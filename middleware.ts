import { NextResponse, type NextRequest } from "next/server";

// ─── Token-bucket rate limiter ─────────────────────────────────
// In-memory, per serverless/edge instance. For full distributed
// rate limiting, swap for Upstash Redis or Cloudflare KV.

const store = new Map<string, { tokens: number; lastRefill: number }>();
const MAX_TOKENS = 30; // burst capacity
const REFILL_RATE = 0.5; // tokens/sec (~30/min)

function rateLimit(ip: string): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const entry = store.get(ip);

  if (!entry) {
    store.set(ip, { tokens: MAX_TOKENS - 1, lastRefill: now });
    return { ok: true, retryAfter: 0 };
  }

  const elapsed = (now - entry.lastRefill) / 1000;
  entry.tokens = Math.min(MAX_TOKENS, entry.tokens + elapsed * REFILL_RATE);
  entry.lastRefill = now;

  if (entry.tokens >= 1) {
    entry.tokens -= 1;
    return { ok: true, retryAfter: 0 };
  }

  return {
    ok: false,
    retryAfter: Math.ceil((1 - entry.tokens) / REFILL_RATE),
  };
}

// Lazy cleanup every ~200 requests to prevent memory growth
let reqCount = 0;
function maybeCleanup() {
  if (++reqCount % 200 !== 0) return;
  const now = Date.now();
  for (const [key, entry] of store) {
    const elapsed = (now - entry.lastRefill) / 1000;
    if (entry.tokens + elapsed * REFILL_RATE >= MAX_TOKENS) {
      store.delete(key);
    }
  }
}

export function middleware(request: NextRequest) {
  // ── Rate limit ──
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";

  maybeCleanup();
  const { ok, retryAfter } = rateLimit(ip);

  if (!ok) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }

  // ── CSRF: verify Origin for POST requests ──
  // Browsers always send Origin on POST; if present it must match host.
  if (request.method === "POST") {
    const origin = request.headers.get("origin");
    const host = request.headers.get("host");

    if (origin && host) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
      } catch {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
