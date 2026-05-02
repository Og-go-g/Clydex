import { NextResponse, type NextRequest } from "next/server";

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

// ─── Middleware ───────────────────────────────────────────────

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Self-hosted behind nginx: trust X-Real-IP set by the nginx config,
  // fallback to first entry of X-Forwarded-For (real client IP),
  // last resort: "unknown" (shared bucket — aggressive limiting).
  const realIp = request.headers.get("x-real-ip");
  const xff = request.headers.get("x-forwarded-for");
  const firstHop = xff?.split(",")[0]?.trim();
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

  // ── Content-Type + CSRF checks for mutating requests ──
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
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
