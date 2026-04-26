import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/**
 * Production rate limiter backed by Upstash Redis.
 * Falls back to a no-op limiter if Upstash env vars are missing (dev mode).
 *
 * Usage:
 *   const { success, remaining } = await rpcReadLimiter.limit(userKey);
 */

const hasRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

if (!hasRedis && process.env.NODE_ENV === "production") {
  throw new Error(
    "[SECURITY] UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set in production. " +
    "Rate limiting without Redis is unsafe (resets on cold start, single-instance only)."
  );
}

const redis = hasRedis
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
  : null;

// RPC reads: 120 per 60 seconds per user
export const rpcReadLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(120, "60 s"),
      prefix: "rl:rpc:read",
      analytics: true,
    })
  : null;

// RPC writes (sendTransaction, simulateTransaction): 10 per 60 seconds per user
export const rpcWriteLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(10, "60 s"),
      prefix: "rl:rpc:write",
      analytics: true,
    })
  : null;

// Collateral API: 20 per 60 seconds per user
export const collateralLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(20, "60 s"),
      prefix: "rl:collateral",
      analytics: true,
    })
  : null;

// Order API: 30 per 60 seconds per user
export const orderLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(30, "60 s"),
      prefix: "rl:order",
      analytics: true,
    })
  : null;

// Chat API: 10 per 60 seconds per user (each request = expensive AI call)
export const chatLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(10, "60 s"),
      prefix: "rl:chat",
      analytics: true,
    })
  : null;

/**
 * Fallback in-memory rate limiter for dev/local when Upstash is not configured.
 * NOT suitable for production (resets on cold start, single-instance only).
 */
interface MemBucket {
  count: number;
  resetAt: number;
}

const memMap = new Map<string, MemBucket>();

export function memRateLimit(
  key: string,
  limit: number,
  windowMs: number = 60_000
): { success: boolean; remaining: number } {
  const now = Date.now();
  let bucket = memMap.get(key);

  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    memMap.set(key, bucket);
  }

  if (bucket.count >= limit) {
    return { success: false, remaining: 0 };
  }

  bucket.count++;

  // Periodic cleanup: evict expired buckets and enforce hard cap
  if (memMap.size > 500) {
    const cleanupNow = Date.now();
    for (const [k, b] of memMap) {
      if (cleanupNow > b.resetAt + 120_000) memMap.delete(k); // 2min max age
    }
    // Hard cap if still over limit
    while (memMap.size > 2000) {
      const firstKey = memMap.keys().next().value;
      if (firstKey) memMap.delete(firstKey);
      else break;
    }
  }

  return { success: true, remaining: limit - bucket.count };
}

// Lazy cleanup — call periodically to prevent unbounded growth
export function memCleanup() {
  if (memMap.size < 500) return;
  const now = Date.now();
  for (const [key, bucket] of memMap) {
    if (now > bucket.resetAt) memMap.delete(key);
  }
}

/**
 * Throttled-warn wrapper around an Upstash limiter that falls through to
 * the in-memory token bucket when Upstash throws. Use this instead of
 * `await limiter.limit(key)` directly — Upstash quota exhaustion (or any
 * transient error) would otherwise propagate to the route's catch block
 * and turn into a 500.
 *
 * Same pattern as middleware.ts after commit 670b25f, generalised so all
 * /api/* routes share the protection.
 *
 * @param limiter         Upstash Ratelimit instance (or null if unconfigured).
 * @param userKey         Per-user identity (wallet address, IP, etc).
 * @param memFallbackKey  Prefix used for the in-memory bucket key (e.g. "rpc:r:" + address).
 * @param memFallbackMax  Per-window cap for the in-memory bucket.
 */
let lastUpstashWarnAt = 0;
const UPSTASH_WARN_INTERVAL_MS = 60_000;

export async function safeRateLimit(
  limiter: Ratelimit | null,
  userKey: string,
  memFallbackKey: string,
  memFallbackMax: number
): Promise<{ success: boolean; remaining: number }> {
  if (limiter) {
    try {
      const r = await limiter.limit(userKey);
      return { success: r.success, remaining: r.remaining };
    } catch (err) {
      const now = Date.now();
      if (now - lastUpstashWarnAt > UPSTASH_WARN_INTERVAL_MS) {
        lastUpstashWarnAt = now;
        console.warn(
          "[ratelimit] Upstash limit() failed, falling back to in-memory:",
          err instanceof Error ? err.message : err
        );
      }
    }
  }
  memCleanup();
  return memRateLimit(memFallbackKey + userKey, memFallbackMax);
}
