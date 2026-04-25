import { NextResponse, type NextRequest } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// ─── Upstash Redis rate limiters (production) ─────────────────

const hasUpstash = !!(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);

const redis = hasUpstash ? Redis.fromEnv() : undefined;

const upstashLimiters = redis
  ? {
      auth: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(10, "60 s"),
        prefix: "rl:auth",
      }),
      expensive: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(30, "60 s"),
        prefix: "rl:expensive",
      }),
      default: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(60, "60 s"),
        prefix: "rl:default",
      }),
    }
  : null;

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

// ─── In-memory fallback (dev / no Redis) ──────────────────────

interface Tier {
  maxTokens: number;
  refillRate: number;
}

const TIERS: Record<string, Tier> = {
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
  tierKey: TierKey
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
    entry.tokens + elapsed * tier.refillRate
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

function maybeCleanup() {
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

// ─── Upstash failure logging (throttled) ──────────────────────

let lastUpstashLogMs = 0;
const UPSTASH_LOG_INTERVAL_MS = 60_000;

function logUpstashFailure(err: unknown): void {
  const now = Date.now();
  if (now - lastUpstashLogMs < UPSTASH_LOG_INTERVAL_MS) return;
  lastUpstashLogMs = now;
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[middleware] Upstash rate-limiter failed, falling back to in-memory: ${msg}`);
}

// ─── CSRF / Content-Type constants ────────────────────────────

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// ─── Middleware ───────────────────────────────────────────────

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // ── Rate limit ──
  // Self-hosted behind nginx: trust X-Real-IP set by nginx proxy,
  // fallback to first entry of X-Forwarded-For (real client IP),
  // last resort: "unknown" (shared bucket — aggressive limiting).
  const realIp = request.headers.get("x-real-ip");
  const xff = request.headers.get("x-forwarded-for");
  const firstHop = xff?.split(",")[0]?.trim();
  const ip = realIp || firstHop || "unknown";

  const tierKey = getTierKey(pathname);

  // Try Upstash first (production-grade, distributed across instances).
  // If it throws — most commonly quota exhaustion ("max requests limit
  // exceeded") or transient network errors — fall back to the in-memory
  // limiter so the entire `/api/*` surface doesn't 500. We log the error
  // once per minute (cheap throttle via timestamp bucket) to avoid log spam.
  let upstashFailed = false;
  if (upstashLimiters) {
    try {
      const { success, reset } = await upstashLimiters[tierKey].limit(ip);

      if (!success) {
        const retryAfter = Math.ceil((reset - Date.now()) / 1000);
        return NextResponse.json(
          { error: "Too many requests. Please try again later." },
          {
            status: 429,
            headers: { "Retry-After": String(Math.max(retryAfter, 1)) },
          }
        );
      }
    } catch (err) {
      upstashFailed = true;
      logUpstashFailure(err);
    }
  }

  if (!upstashLimiters || upstashFailed) {
    maybeCleanup();
    const { ok, retryAfter } = inMemoryRateLimit(ip, tierKey);

    if (!ok) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }
  }

  // ── Content-Type + CSRF checks for mutating requests ──
  if (MUTATING_METHODS.has(request.method)) {
    // DELETE requests without body don't need Content-Type
    const contentLength = request.headers.get("content-length");
    const hasBody = contentLength !== null && contentLength !== "0";
    if (request.method !== "DELETE" || hasBody) {
      const contentType = request.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        return NextResponse.json(
          { error: "Bad Request" },
          { status: 415 }
        );
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
