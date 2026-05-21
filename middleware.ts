import { NextResponse, type NextRequest } from "next/server";
import { generateCspNonce, buildCsp } from "@/lib/security/csp";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  isCsrfExempt,
  verifyCsrfPair,
} from "@/lib/security/csrf";

/**
 * Edge-runtime middleware: coarse, IP-keyed rate limit + CSRF/Content-Type
 * checks for mutating requests.
 *
 * Two-layer rate-limiting design:
 *
 *   Layer 1 (this file, edge runtime):
 *     - IP-based, in-memory token bucket per instance
 *     - Cheap and fast — runs on every /api/* request
 *     - Does NOT see the authenticated wallet, only the IP
 *     - Purpose: coarse DDoS / bot-flood protection at the door
 *
 *   Layer 2 (lib/ratelimit.ts, Node runtime, called from route handlers):
 *     - Wallet-keyed (or address) Postgres-backed counters
 *     - Per-tier limits (rpc-read, rpc-write, order, chat, collateral)
 *     - Survives a single-process restart, shared with cleanup
 *
 * Why no Postgres here: Next.js edge middleware cannot import `pg` /
 * Prisma. We previously used Upstash Redis (HTTP-based, edge-compatible)
 * for cross-instance correctness, but on a single-container deployment
 * the in-memory bucket is just as accurate as a remote Redis call. After
 * Phase 8a (Postgres rate-limiter) we removed Upstash entirely — see
 * memory/tier2_phase1_2_done.md for context.
 */

// ─── Tier routing ─────────────────────────────────────────────

const TIER_KEYS = ["auth", "expensive", "default"] as const;
type TierKey = (typeof TIER_KEYS)[number];

function getTierKey(pathname: string): TierKey {
  if (
    pathname.startsWith("/api/auth/login") ||
    pathname.startsWith("/api/auth/nonce")
  ) {
    return "auth";
  }
  if (
    pathname.startsWith("/api/chat") ||
    pathname.startsWith("/api/collateral") ||
    pathname.includes("/candles") ||
    pathname.includes("/orderbook") ||
    pathname.startsWith("/api/copy")
  ) {
    return "expensive";
  }
  // /api/account needs higher limit for live portfolio polling
  if (pathname.startsWith("/api/account")) {
    return "default";
  }
  return "default";
}

// ─── In-memory token bucket ───────────────────────────────────

interface Tier {
  maxTokens: number;
  refillRate: number; // tokens per second
}

const TIERS: Record<TierKey, Tier> = {
  auth: { maxTokens: 5, refillRate: 5 / 60 },
  expensive: { maxTokens: 10, refillRate: 10 / 60 },
  default: { maxTokens: 30, refillRate: 30 / 60 },
};

const store = new Map<
  string,
  { tokens: number; lastRefill: number; tierKey: TierKey }
>();

function inMemoryRateLimit(
  ip: string,
  tierKey: TierKey,
): { ok: boolean; retryAfter: number } {
  const tier = TIERS[tierKey];
  const key = `${tierKey}|${ip}`;
  const now = Date.now();
  const entry = store.get(key);

  if (!entry) {
    store.set(key, { tokens: tier.maxTokens - 1, lastRefill: now, tierKey });
    return { ok: true, retryAfter: 0 };
  }

  const elapsed = (now - entry.lastRefill) / 1000;
  entry.lastRefill = now; // Update FIRST to prevent double-counting window
  entry.tokens = Math.min(
    tier.maxTokens,
    entry.tokens + elapsed * tier.refillRate,
  );

  if (entry.tokens >= 1) {
    entry.tokens -= 1;
    return { ok: true, retryAfter: 0 };
  }

  return {
    ok: false,
    retryAfter: Math.ceil((1 - entry.tokens) / tier.refillRate),
  };
}

let reqCount = 0;
const MAX_STORE_SIZE = 10_000;

function maybeCleanup(): void {
  reqCount += 1;
  if (store.size < MAX_STORE_SIZE && reqCount % 200 !== 0) return;

  const now = Date.now();
  const MAX_AGE_MS = 5 * 60 * 1000;

  for (const [key, entry] of store) {
    const tier = TIERS[entry.tierKey] ?? TIERS.default;
    const elapsed = (now - entry.lastRefill) / 1000;
    const isFull = entry.tokens + elapsed * tier.refillRate >= tier.maxTokens;
    const isStale = now - entry.lastRefill > MAX_AGE_MS;

    if (isFull || isStale) {
      store.delete(key);
    }
  }
}

// ─── CSRF / Content-Type constants ────────────────────────────

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// ─── CSP nonce — see lib/security/csp.ts for the full directive set
//     and the rationale behind each one. Per-request nonce closes the
//     XSS-via-inline-script vector that the previous static
//     'unsafe-inline' CSP left open. CSP_RELAXED=true reverts to the
//     old behaviour as a no-redeploy rollback. ────────────────────

// ─── Middleware ───────────────────────────────────────────────

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isApi = pathname.startsWith("/api/");

  // Generate one nonce per request and use it for the CSP header on
  // every response we return below. The same nonce is also pushed
  // into the request headers as `x-nonce` so server components can
  // read it via `headers().get('x-nonce')` for any custom inline
  // scripts they emit. Next.js's own hydration scripts pick up the
  // nonce automatically from this same header.
  const nonce = generateCspNonce();
  const cspRelaxed = process.env.CSP_RELAXED === "true";
  const cspValue = buildCsp(nonce, cspRelaxed);

  // Build the pass-through response with x-nonce on the request so
  // it propagates to layout.tsx and friends.
  const passThroughHeaders = new Headers(request.headers);
  passThroughHeaders.set("x-nonce", nonce);

  // Helper: attach CSP header to any response we're about to return.
  // Returning early (rate limit, CSRF refuse, healthcheck) still
  // needs the header so the error page itself can't be a CSP gap.
  function withCsp(res: NextResponse): NextResponse {
    res.headers.set("Content-Security-Policy", cspValue);
    return res;
  }

  // Non-API path: HTML page or static asset. Rate-limit + CSRF do
  // not apply (those are mutation-flow concerns). Just attach the
  // CSP header and propagate x-nonce.
  if (!isApi) {
    return withCsp(
      NextResponse.next({ request: { headers: passThroughHeaders } }),
    );
  }

  // /api/health is hit every 30s by the Docker healthcheck and possibly
  // continuously by external uptime monitors. Bypass rate-limiting and
  // CSRF entirely so it never burns the shared "unknown IP" bucket
  // (docker's wget has no X-Real-IP) and never accidentally returns 429
  // — that would let a totally healthy app falsely show as unhealthy.
  if (pathname === "/api/health") {
    return NextResponse.next();
  }

  // /api/admin/* endpoints are all CRON_SECRET-bearer protected and called
  // from non-browser clients (curl, bash scripts in systemd hooks, cron
  // jobs). Browser-style CSRF protection (Origin/Host match) is the wrong
  // layer for them — they have no Origin header and would always fail
  // with 403, which is exactly what bit the systemd alert pipeline on
  // first deploy 2026-05-03. Bypass middleware entirely and let each
  // route enforce its own bearer auth (timing-safe compare).
  if (pathname.startsWith("/api/admin/")) {
    return NextResponse.next();
  }

  // Self-hosted behind nginx: trust X-Real-IP set by the nginx config,
  // fallback to first entry of X-Forwarded-For (real client IP),
  // last resort: "unknown" (shared bucket — aggressive limiting).
  //
  // In production: if NEITHER header is present we are NOT being reached
  // through nginx (someone hit the app port directly), which means rate
  // limiting becomes trivially bypassable — every request hits the
  // shared "unknown" bucket and a single attacker uses an entire
  // tier's budget for everyone. Refuse the request rather than degrade
  // silently. NODE_ENV=development bypasses this so local `next dev`
  // continues to work.
  const realIp = request.headers.get("x-real-ip");
  const xff = request.headers.get("x-forwarded-for");
  const firstHop = xff?.split(",")[0]?.trim();
  if (!realIp && !firstHop && process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Forbidden" },
      { status: 403 },
    );
  }
  const ip = realIp || firstHop || "unknown";

  const tierKey = getTierKey(pathname);

  maybeCleanup();
  const { ok, retryAfter } = inMemoryRateLimit(ip, tierKey);
  if (!ok) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  // ── Content-Type + Origin/Host + CSRF checks for mutating requests ──
  if (MUTATING_METHODS.has(request.method)) {
    // DELETE requests without body don't need Content-Type
    const contentLength = request.headers.get("content-length");
    const hasBody = contentLength !== null && contentLength !== "0";
    if (request.method !== "DELETE" || hasBody) {
      const contentType = request.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        return NextResponse.json({ error: "Bad Request" }, { status: 415 });
      }
    }

    const origin = request.headers.get("origin");
    const host = request.headers.get("host");

    if (!origin || !host) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // ── CSRF double-submit token check ──
    //
    // Layered ON TOP of the Origin/Host check above for defense in
    // depth (Origin can be spoofed in some edge cases — null
    // origin from sandboxed iframes, browser bug). Verifies the
    // `x-csrf-token` header matches the `clydex-csrf` cookie, both
    // of which the legit client got from /api/auth/csrf and an
    // attacker on a different origin can't read.
    //
    // Exempted paths (CSRF_EXEMPT_PATHS): /api/auth/csrf itself
    // (the bootstrap), /api/auth/login + /api/auth/nonce (proven
    // by SIWS signature instead), /api/admin/* (CRON_SECRET
    // bearer), /api/health.
    //
    // Rollout flag CSRF_STRICT:
    //   - unset / != "true" → warn-only. Mismatch fires a Sentry-
    //     visible response header (`x-csrf-warning`) but the
    //     request proceeds. Lets us migrate all 30+ call sites and
    //     watch for late stragglers before flipping to enforce.
    //   - "true" → enforced. Mismatch returns 403.
    if (!isCsrfExempt(pathname)) {
      const headerToken = request.headers.get(CSRF_HEADER_NAME);
      const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value ?? null;
      const verdict = verifyCsrfPair({ headerToken, cookieToken });
      if (!verdict.ok) {
        const strict = process.env.CSRF_STRICT === "true";
        if (strict) {
          return NextResponse.json(
            { error: "Forbidden: CSRF check failed" },
            { status: 403 },
          );
        }
        // Warn-only: attach a header that downstream Sentry
        // breadcrumbs / observability can pick up without breaking
        // legitimate callers that haven't migrated yet.
        const res = NextResponse.next();
        res.headers.set("x-csrf-warning", verdict.reason);
        return res;
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // API routes: rate-limit + CSRF + Content-Type checks.
    "/api/:path*",
    // Page routes: nonce + CSP header. The negative lookahead excludes
    // Next.js static internals so we don't pay middleware cost on
    // every chunk/image, and skips request paths that look like
    // direct asset hits (anything containing a dot in the last
    // segment — image.png, robots.txt, sitemap.xml, etc.).
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.[a-z0-9]+$).*)",
  ],
};
