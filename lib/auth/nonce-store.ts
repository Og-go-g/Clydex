/**
 * One-time SIWS sign-in nonce store — Postgres primary, in-memory last-resort.
 *
 * History:
 *   v1: Upstash Redis primary (`SET ... NX EX` for store, `GETDEL` for consume)
 *       with in-memory fallback. Same Upstash quota burn as rate-limit.
 *   v2: Removed Upstash entirely. Postgres `nonces` table holds the value +
 *       expires_at, `DELETE ... RETURNING` provides the atomic single-use
 *       guarantee (row-level lock prevents two concurrent verifies from
 *       both succeeding). Pattern is the canonical Supabase Auth approach
 *       for one-time tokens.
 *
 * Atomicity of single-use:
 *   `DELETE FROM nonces WHERE value = $1 AND expires_at > NOW() RETURNING value`
 *   acquires a row-level lock, applies the time predicate, deletes, and
 *   returns the deleted row in one statement. Two parallel `verify` requests
 *   for the same nonce serialise on the lock and only one returns a row.
 *   No race window between read and delete.
 *
 * Fallback chain on Postgres outage:
 *   pgConsumeNonce returns false on any error → memTake() is checked next.
 *   The store path mirrors it: pgStoreNonce reports failure → memSet() runs.
 *   On a single-process deployment that's enough; cross-process consistency
 *   isn't required because every login flow happens within one Next.js
 *   server instance handling both the /nonce and /login halves.
 */

import { prisma } from "../db";

const NONCE_TTL_S = 300; // 5 minutes

/* ------------------------------------------------------------------ */
/*  In-memory fallback                                                */
/* ------------------------------------------------------------------ */

const memStore = new Map<string, number>();

function memCleanup(): void {
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
  // Always remove (single-use), but only confirm success if not expired.
  memStore.delete(nonce);
  if (Date.now() - createdAt > NONCE_TTL_S * 1000) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/*  Postgres backend                                                  */
/* ------------------------------------------------------------------ */

let lastPgWarnAt = 0;
const PG_WARN_INTERVAL_MS = 60_000;

function warn(label: string, err: unknown): void {
  const now = Date.now();
  if (now - lastPgWarnAt > PG_WARN_INTERVAL_MS) {
    lastPgWarnAt = now;
    console.warn(
      `[nonce-store] ${label} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function pgStoreNonce(nonce: string): Promise<boolean> {
  try {
    // ON CONFLICT DO NOTHING handles the (effectively impossible) collision
    // when two concurrent /api/auth/nonce requests draw the same 16-byte
    // random value. The first wins; the second silently no-ops and the
    // caller gets back its own value, which would just be unusable. Not
    // a security concern — collisions on 128-bit randomness are negligible.
    await prisma.$executeRaw`
      INSERT INTO nonces (value, expires_at)
      VALUES (${nonce}, NOW() + (${NONCE_TTL_S}::int * INTERVAL '1 second'))
      ON CONFLICT (value) DO NOTHING;
    `;
    return true;
  } catch (err) {
    warn("pgStoreNonce", err);
    return false;
  }
}

async function pgConsumeNonce(nonce: string): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<{ value: string }[]>`
      DELETE FROM nonces
      WHERE value = ${nonce}
        AND expires_at > NOW()
      RETURNING value;
    `;
    return rows.length > 0;
  } catch (err) {
    warn("pgConsumeNonce", err);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Background cleanup of expired Postgres rows                       */
/* ------------------------------------------------------------------ */

const CLEANUP_INTERVAL_MS = 5 * 60_000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanupTimer(): void {
  if (cleanupTimer || typeof setInterval === "undefined") return;
  cleanupTimer = setInterval(() => {
    void prisma
      .$executeRaw`DELETE FROM nonces WHERE expires_at < NOW();`
      .catch((err: unknown) => warn("periodic cleanup", err));
  }, CLEANUP_INTERVAL_MS);
  if (typeof cleanupTimer === "object" && cleanupTimer && "unref" in cleanupTimer) {
    (cleanupTimer as unknown as { unref: () => void }).unref();
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/** Store a freshly generated nonce. Returns the same string for chaining. */
export async function storeNonce(nonce: string): Promise<string> {
  ensureCleanupTimer();
  const ok = await pgStoreNonce(nonce);
  if (!ok) memSet(nonce);
  return nonce;
}

/**
 * Atomically consume a nonce. Returns true if the nonce was valid and is now
 * burned (it was deleted from the store; subsequent calls return false).
 *
 * Tries Postgres first, falls back to the in-memory map if PG is down or
 * if the nonce was originally written there during a prior outage.
 */
export async function consumeNonce(nonce: string): Promise<boolean> {
  ensureCleanupTimer();
  if (await pgConsumeNonce(nonce)) return true;
  return memTake(nonce);
}
