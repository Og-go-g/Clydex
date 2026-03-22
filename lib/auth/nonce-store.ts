/**
 * Server-side nonce store with atomic consume.
 * Prevents race condition where two concurrent login requests
 * can both read the same nonce from a cookie-based session.
 */

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface NonceEntry {
  nonce: string;
  createdAt: number;
}

// In-memory store keyed by nonce value for O(1) atomic consume
const nonceStore = new Map<string, NonceEntry>();

/** Store a nonce. Returns the nonce string. */
export function storeNonce(nonce: string): string {
  // Cleanup expired nonces periodically
  if (nonceStore.size > 500) {
    const now = Date.now();
    for (const [k, v] of nonceStore) {
      if (now - v.createdAt > NONCE_TTL_MS) nonceStore.delete(k);
    }
  }
  nonceStore.set(nonce, { nonce, createdAt: Date.now() });
  return nonce;
}

/**
 * Atomically consume a nonce. Returns true if the nonce was valid and consumed.
 * After this call, the nonce cannot be used again (single-use guarantee).
 */
export function consumeNonce(nonce: string): boolean {
  const entry = nonceStore.get(nonce);
  if (!entry) return false;
  // Check TTL BEFORE deleting — prevents expired nonce from passing validation
  if (Date.now() - entry.createdAt > NONCE_TTL_MS) {
    nonceStore.delete(nonce); // cleanup expired entry
    return false;
  }
  // Atomic delete — even if two requests arrive simultaneously in the same
  // event loop tick, Map.delete is synchronous and the second call gets false.
  nonceStore.delete(nonce);
  return true;
}
