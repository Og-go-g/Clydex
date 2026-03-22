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
    pathname.includes("/orderbook")
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

// ─── CSRF / Content-Type constants ────────────────────────────

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// ─── Middleware ───────────────────────────────────────────────

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // ── Rate limit ──
  // 1. Vercel sets request.ip from their edge (trusted, not spoofable)
  // 2. Fallback: last entry of x-forwarded-for (closest proxy to Vercel edge)
  // 3. Last resort: "unknown" (shared bucket — very aggressive limiting)
  const vercelIp = (request as unknown as { ip?: string }).ip;
  const xff = request.headers.get("x-forwarded-for");
  const lastHop = xff?.split(",").pop()?.trim();
  const ip = vercelIp || lastHop || "unknown";

  const tierKey = getTierKey(pathname);

  if (upstashLimiters) {
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
  } else {
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
    const contentType = request.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      return NextResponse.json(
        { error: "Bad Request" },
        { status: 415 }
      );
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
