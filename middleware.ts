import { NextResponse, type NextRequest } from "next/server";

// ─── Per-tier token-bucket rate limiter ────────────────────────
// In-memory, per serverless/edge instance. For full distributed
// rate limiting, swap for Upstash Redis or Cloudflare KV.

interface Tier {
  maxTokens: number;
  refillRate: number; // tokens/sec
}

const TIERS: Record<string, Tier> = {
  auth:      { maxTokens: 5,  refillRate: 5 / 60 },   // 5/min  — brute force protection
  expensive: { maxTokens: 10, refillRate: 10 / 60 },   // 10/min — chat, swap, quote
  default:   { maxTokens: 30, refillRate: 30 / 60 },   // 30/min — prices, yields, etc.
};

function getTier(pathname: string): Tier {
  if (pathname.startsWith("/api/auth/login") || pathname.startsWith("/api/auth/nonce")) {
    return TIERS.auth;
  }
  if (pathname.startsWith("/api/chat") || pathname.startsWith("/api/swap") || pathname.startsWith("/api/quote")) {
    return TIERS.expensive;
  }
  return TIERS.default;
}

// Separate buckets per IP+tier so limits don't interfere
const store = new Map<string, { tokens: number; lastRefill: number }>();

function rateLimit(ip: string, tier: Tier, tierKey: string): { ok: boolean; retryAfter: number } {
  const key = `${ip}:${tierKey}`;
  const now = Date.now();
  const entry = store.get(key);

  if (!entry) {
    store.set(key, { tokens: tier.maxTokens - 1, lastRefill: now });
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
function maybeCleanup() {
  if (++reqCount % 200 !== 0) return;
  const now = Date.now();
  for (const [key, entry] of store) {
    const tierKey = key.split(":").pop() ?? "default";
    const tier = TIERS[tierKey] ?? TIERS.default;
    const elapsed = (now - entry.lastRefill) / 1000;
    if (entry.tokens + elapsed * tier.refillRate >= tier.maxTokens) {
      store.delete(key);
    }
  }
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // ── Rate limit ──
  // Prefer x-real-ip (set reliably by Vercel/proxies) over x-forwarded-for (spoofable)
  const ip =
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";

  const tier = getTier(pathname);
  const tierKey = tier === TIERS.auth ? "auth" : tier === TIERS.expensive ? "expensive" : "default";

  maybeCleanup();
  const { ok, retryAfter } = rateLimit(ip, tier, tierKey);

  if (!ok) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }

  // ── CSRF: verify Origin for all mutating methods ──
  const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  if (MUTATING.has(request.method)) {
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
