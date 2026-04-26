/**
 * Nonce store backed by Upstash Redis for cross-instance consistency.
 * Falls back to in-memory Map when Redis is unavailable (dev mode).
 *
 * Redis commands used:
 *   storeNonce  → SET nonce:{value} 1 EX 300 NX  (1 command)
 *   consumeNonce → GETDEL nonce:{value}           (1 command)
 *
 * Total: 2 Redis commands per login flow.
 */

import { Redis } from "@upstash/redis";

const NONCE_TTL_S = 300; // 5 minutes
const REDIS_PREFIX = "nonce:";

// ── Redis client ──
const hasRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

const redis = hasRedis
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
  : null;

// ── In-memory fallback (dev only) ──
const memStore = new Map<string, number>();

function memCleanup() {
  if (memStore.size < 100) return;
  const now = Date.now();
  for (const [k, createdAt] of memStore) {
    if (now - createdAt > NONCE_TTL_S * 1000) memStore.delete(k);
  }
}

function memSet(nonce: string): void {
  memCleanup();
  memStore.set(nonce, Date.now());
}

function memTake(nonce: string): boolean {
  const createdAt = memStore.get(nonce);
  if (createdAt === undefined) return false;
  memStore.delete(nonce);
  if (Date.now() - createdAt > NONCE_TTL_S * 1000) return false;
  return true;
}

/** Store a nonce. Returns the nonce string. */
export async function storeNonce(nonce: string): Promise<string> {
  if (redis) {
    try {
      await redis.set(`${REDIS_PREFIX}${nonce}`, "1", { nx: true, ex: NONCE_TTL_S });
      return nonce;
    } catch (err) {
      // Upstash unavailable / quota exhausted — fall through to in-memory
      // so login keeps working. Mirrors the pattern used in middleware
      // and lib/ratelimit.ts (commit 670b25f).
      console.warn(
        "[nonce-store] Upstash storeNonce failed, using in-memory:",
        err instanceof Error ? err.message : err
      );
    }
  }
  memSet(nonce);
  return nonce;
}

/**
 * Atomically consume a nonce. Returns true if valid and consumed.
 * After this call, the nonce cannot be used again (single-use guarantee).
 *
 * Redis GETDEL is atomic — even concurrent requests can't both succeed.
 * Falls through to in-memory if Redis is down so nonces stored during an
 * outage can still be consumed (otherwise login would 401 even with a
 * valid signature).
 */
export async function consumeNonce(nonce: string): Promise<boolean> {
  if (redis) {
    try {
      const val = await redis.getdel(`${REDIS_PREFIX}${nonce}`);
      if (val !== null) return true;
      // Not in Redis — could be a nonce stored under the in-memory
      // fallback during a prior outage. Try memStore before giving up.
    } catch (err) {
      console.warn(
        "[nonce-store] Upstash consumeNonce failed, using in-memory:",
        err instanceof Error ? err.message : err
      );
    }
  }
  return memTake(nonce);
}
