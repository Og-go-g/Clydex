import { NextResponse, type NextRequest } from "next/server";

// ─── Per-tier token-bucket rate limiter ────────────────────────
// In-memory, per serverless/edge instance. For full distributed
// rate limiting in production, use Upstash Redis (@upstash/ratelimit).
// This still provides meaningful protection: Vercel reuses instances
// for multiple requests, so the limiter catches sustained abuse
// within a single instance's lifetime.

interface Tier {
  maxTokens: number;
  refillRate: number; // tokens/sec
}

const TIERS: Record<string, Tier> = {
  auth:      { maxTokens: 5,  refillRate: 5 / 60 },   // 5/min  — brute force protection
  expensive: { maxTokens: 10, refillRate: 10 / 60 },   // 10/min — chat, swap, quote
  default:   { maxTokens: 30, refillRate: 30 / 60 },   // 30/min — prices, yields, etc.
};

const TIER_KEYS = ["auth", "expensive", "default"] as const;
type TierKey = (typeof TIER_KEYS)[number];

function getTierKey(pathname: string): TierKey {
  if (pathname.startsWith("/api/auth/login") || pathname.startsWith("/api/auth/nonce")) {
    return "auth";
  }
  if (pathname.startsWith("/api/chat") || pathname.startsWith("/api/swap") || pathname.startsWith("/api/quote") || pathname.startsWith("/api/approvals")) {
    return "expensive";
  }
  return "default";
}

// Use pipe delimiter to avoid conflicts with IPv6 colons
// Key format: "tierKey|ip"  (tierKey is always one of 3 known values)
const store = new Map<string, { tokens: number; lastRefill: number; tierKey: TierKey }>();

function rateLimit(ip: string, tierKey: TierKey): { ok: boolean; retryAfter: number } {
  const tier = TIERS[tierKey];
  const key = `${tierKey}|${ip}`;
  const now = Date.now();
  const entry = store.get(key);

  if (!entry) {
    store.set(key, { tokens: tier.maxTokens - 1, lastRefill: now, tierKey });
    return { ok: true, retryAfter: 0 };
  }

  const elapsed = (now - entry.lastRefill) / 1000;
  entry.tokens = Math.min(tier.maxTokens, entry.tokens + elapsed * tier.refillRate);
  entry.lastRefill = now;

  if (entry.tokens >= 1) {
    entry.tokens -= 1;
    return { ok: true, retryAfter: 0 };
  }

  return {
    ok: false,
    retryAfter: Math.ceil((1 - entry.tokens) / tier.refillRate),
  };
}

// Lazy cleanup every ~200 requests to prevent memory growth
let reqCount = 0;
const MAX_STORE_SIZE = 10_000; // Hard cap to prevent unbounded growth

function maybeCleanup() {
  reqCount += 1;
  // Force cleanup if store exceeds hard cap, otherwise every 200 requests
  if (store.size < MAX_STORE_SIZE && reqCount % 200 !== 0) return;

  const now = Date.now();
  const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes without activity → evict

  for (const [key, entry] of store) {
    // Evict entries that are fully refilled OR stale
    const tier = TIERS[entry.tierKey] ?? TIERS.default;
    const elapsed = (now - entry.lastRefill) / 1000;
    const isFull = entry.tokens + elapsed * tier.refillRate >= tier.maxTokens;
    const isStale = now - entry.lastRefill > MAX_AGE_MS;

    if (isFull || isStale) {
      store.delete(key);
    }
  }
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // ── Rate limit ──
  // Prefer x-real-ip (set reliably by Vercel/proxies) over x-forwarded-for
  const ip =
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";

  const tierKey = getTierKey(pathname);

  maybeCleanup();
  const { ok, retryAfter } = rateLimit(ip, tierKey);

  if (!ok) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }

  // ── Content-Type + CSRF checks for mutating requests ──
  if (MUTATING_METHODS.has(request.method)) {
    const contentType = request.headers.get("content-type");
    // If Content-Type is present, it must be JSON (allows omitted for backwards compat)
    if (contentType && !contentType.includes("application/json")) {
      return NextResponse.json(
        { error: "Content-Type must be application/json" },
        { status: 415 }
      );
    }

    // ── CSRF: verify Origin for all mutating methods ──
    const origin = request.headers.get("origin");
    const host = request.headers.get("host");

    // Deny if Origin is missing (fail-closed) or mismatched
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
