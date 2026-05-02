/**
 * Rate limiting for /api/* — Postgres primary, in-memory last-resort fallback.
 *
 * History:
 *   v1 (pre-Phase-8a): Upstash Redis primary, in-memory fallback. Free-tier
 *                      500K/mo exhausted in days under one active user;
 *                      adding a paid tier would have cost $10+/mo per region.
 *   v2 (this file):    Removed Upstash entirely. Postgres is the local DB on
 *                      the same host, ~1ms via host network, zero quotas.
 *                      In-memory remains as the very last resort if PG itself
 *                      is unreachable (single-process counters, but our prod
 *                      runs as one app container, so single-process == correct).
 *
 * Algorithm: fixed-window via the canonical Postgres pattern documented in
 * Neon's rate-limiting guide (https://neon.com/guides/rate-limiting):
 *
 *   INSERT (key, 1, NOW())
 *   ON CONFLICT (key) DO UPDATE SET
 *     count = CASE WHEN window_start + window <= NOW() THEN 1 ELSE count + 1 END,
 *     window_start = CASE WHEN ... THEN NOW() ELSE window_start END
 *   RETURNING count;
 *
 * Atomicity: Postgres acquires a row-level lock on the conflicting row inside
 * `ON CONFLICT DO UPDATE`. Concurrent INSERTs for the same key serialise on
 * that lock — no lost-update race. This is documented behaviour, no advisory
 * lock needed for single-key counter increments. (See Cybertec's writeup +
 * Postgres docs on the ON CONFLICT clause.)
 *
 * Latency: 0.7-2.5ms p95 in `rate-limiter-flexible` benchmarks against
 * Postgres. Our PG is on the host network → ~1ms — comparable to a Redis
 * remote round-trip (5-10ms over the wire) and a couple of orders of
 * magnitude under any reasonable HTTP latency budget.
 *
 * Cleanup: a single setInterval prunes rows whose window expired more than
 * an hour ago, every 5 minutes. The interval is created lazily on first
 * call so test harnesses that import the module don't leak timers. Pattern
 * borrowed from `rate-limiter-flexible`.
 */

import { prisma } from "./db";

/* ------------------------------------------------------------------ */
/*  Tier limits — exported as constants so callers don't repeat magic */
/*  numbers and so adjusting a tier is a one-file change.             */
/* ------------------------------------------------------------------ */

/** Per-user request budget for one 60s window, by route family. */
export const RATE_LIMITS = {
  /** Solana RPC reads — getAccountInfo, getBalance, etc. */
  rpcRead: 120,
  /** Solana RPC writes — sendTransaction, simulateTransaction. */
  rpcWrite: 10,
  /** Deposit/withdraw API. */
  collateral: 20,
  /** Order place/cancel/edit. */
  order: 30,
  /** AI chat completions — each call is expensive. */
  chat: 10,
} as const;

/** Default sliding window length. */
const DEFAULT_WINDOW_MS = 60_000;

/* ------------------------------------------------------------------ */
/*  In-memory fallback (only used when Postgres is unreachable)       */
/* ------------------------------------------------------------------ */

interface MemBucket {
  count: number;
  resetAt: number;
}

const memMap = new Map<string, MemBucket>();

/**
 * Fixed-window bucket in process memory. Survives a Postgres outage but does
 * not coordinate across processes — that's fine for our single-container
 * prod, less fine if we ever scale horizontally without sticky sessions.
 */
export function memRateLimit(
  key: string,
  limit: number,
  windowMs: number = DEFAULT_WINDOW_MS,
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

  // Hard caps to prevent unbounded memory growth under prolonged PG outage.
  if (memMap.size > 500) {
    const cleanupNow = Date.now();
    for (const [k, b] of memMap) {
      if (cleanupNow > b.resetAt + 120_000) memMap.delete(k);
    }
    while (memMap.size > 2000) {
      const firstKey = memMap.keys().next().value;
      if (firstKey) memMap.delete(firstKey);
      else break;
    }
  }

  return { success: true, remaining: limit - bucket.count };
}

/** Manual cleanup hook — used by tests. Production cleanup is automatic. */
export function memCleanup(): void {
  if (memMap.size < 500) return;
  const now = Date.now();
  for (const [key, bucket] of memMap) {
    if (now > bucket.resetAt) memMap.delete(key);
  }
}

/* ------------------------------------------------------------------ */
/*  Postgres backend                                                  */
/* ------------------------------------------------------------------ */

let lastPgWarnAt = 0;
const PG_WARN_INTERVAL_MS = 60_000;

/**
 * Atomic fixed-window rate limit. The single SQL statement reads, decides
 * whether the prior window has elapsed, and either resets or increments —
 * all under the same row-level lock that ON CONFLICT DO UPDATE acquires.
 * No race condition is possible between the check and the write.
 */
async function pgRateLimit(
  key: string,
  max: number,
  windowMs: number,
): Promise<{ success: boolean; remaining: number }> {
  try {
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO rate_limit_buckets (key, count, window_start)
      VALUES (${key}, 1, NOW())
      ON CONFLICT (key) DO UPDATE SET
        count = CASE
          WHEN rate_limit_buckets.window_start < NOW() - (${windowMs}::int * INTERVAL '1 millisecond')
            THEN 1
            ELSE rate_limit_buckets.count + 1
        END,
        window_start = CASE
          WHEN rate_limit_buckets.window_start < NOW() - (${windowMs}::int * INTERVAL '1 millisecond')
            THEN NOW()
            ELSE rate_limit_buckets.window_start
        END
      RETURNING count;
    `;
    const count = rows[0]?.count ?? 1;
    return {
      success: count <= max,
      remaining: Math.max(0, max - count),
    };
  } catch (err) {
    const now = Date.now();
    if (now - lastPgWarnAt > PG_WARN_INTERVAL_MS) {
      lastPgWarnAt = now;
      console.warn(
        "[ratelimit] pgRateLimit failed, falling back to in-memory:",
        err instanceof Error ? err.message : err,
      );
    }
    return memRateLimit(key, max, windowMs);
  }
}

/* ------------------------------------------------------------------ */
/*  Background cleanup of expired Postgres rows                       */
/* ------------------------------------------------------------------ */
//
// Lazily started on the first rate-limit call so test harnesses that
// `import` this module without using it never leak a timer.
// Pattern borrowed from `rate-limiter-flexible`'s PG store.

const CLEANUP_INTERVAL_MS = 5 * 60_000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanupTimer(): void {
  if (cleanupTimer || typeof setInterval === "undefined") return;
  cleanupTimer = setInterval(() => {
    void prisma
      .$executeRaw`DELETE FROM rate_limit_buckets WHERE window_start < NOW() - INTERVAL '1 hour';`
      .catch((err: unknown) => {
        console.warn(
          "[ratelimit] periodic cleanup failed:",
          err instanceof Error ? err.message : err,
        );
      });
  }, CLEANUP_INTERVAL_MS);
  // Don't keep the Node process alive just to run cleanup.
  if (typeof cleanupTimer === "object" && cleanupTimer && "unref" in cleanupTimer) {
    (cleanupTimer as unknown as { unref: () => void }).unref();
  }
}

/* ------------------------------------------------------------------ */
/*  Public API — what /api/* routes and middleware.ts call            */
/* ------------------------------------------------------------------ */

/**
 * Check + consume one request budget for the given user/key.
 *
 * @param userKey  Per-user identity (wallet address, IP, anonymous bucket).
 * @param prefix   Tier namespace (e.g. "rpc:r:", "order:"). Concatenated
 *                 with userKey for the storage key — keep different tiers
 *                 from sharing a counter.
 * @param max      Per-window cap; usually `RATE_LIMITS.<tier>`.
 * @param windowMs Window length in ms; defaults to 60s.
 *
 * @returns { success: boolean; remaining: number }
 *   `success=false` → caller should respond 429.
 */
export async function safeRateLimit(
  userKey: string,
  prefix: string,
  max: number,
  windowMs: number = DEFAULT_WINDOW_MS,
): Promise<{ success: boolean; remaining: number }> {
  ensureCleanupTimer();
  return pgRateLimit(prefix + userKey, max, windowMs);
}
