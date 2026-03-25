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

/** Store a nonce. Returns the nonce string. */
export async function storeNonce(nonce: string): Promise<string> {
  if (redis) {
    // SET NX EX — only stores if not exists, auto-expires in 5 min
    await redis.set(`${REDIS_PREFIX}${nonce}`, "1", { nx: true, ex: NONCE_TTL_S });
  } else {
    memCleanup();
    memStore.set(nonce, Date.now());
  }
  return nonce;
}

/**
 * Atomically consume a nonce. Returns true if valid and consumed.
 * After this call, the nonce cannot be used again (single-use guarantee).
 *
 * Redis GETDEL is atomic — even concurrent requests can't both succeed.
 */
export async function consumeNonce(nonce: string): Promise<boolean> {
  if (redis) {
    // GETDEL — read and delete in one atomic operation
    const val = await redis.getdel(`${REDIS_PREFIX}${nonce}`);
    return val !== null;
  }

  // In-memory fallback (dev)
  const createdAt = memStore.get(nonce);
  if (createdAt === undefined) return false;
  if (Date.now() - createdAt > NONCE_TTL_S * 1000) {
    memStore.delete(nonce);
    return false;
  }
  memStore.delete(nonce);
  return true;
}
