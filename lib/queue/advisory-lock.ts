/**
 * Advisory locks for account-level coordination between worker jobs.
 *
 * Lock keyspace is namespaced via NS offset in upper 16 bits to avoid
 * collisions with copy engine's lock keys (32-bit hash of leaderAddr).
 *
 *   accountIdToLockKey(id) = (0xC1D7 << 32) | (id as uint32)
 *
 * This is a signed 64-bit bigint — well-formed for pg's
 * pg_try_advisory_xact_lock(bigint).
 *
 * IMPORTANT: This module ONLY exposes `withAccountLock`. The previous
 * implementation (`tryAdvisoryLock` + `releaseAdvisoryLock` as separate
 * exports calling `Pool.query` independently) was unsound:
 *
 *   - Session-scope advisory locks are tied to a connection.
 *   - `Pool.query` checks out a fresh connection per call and returns it
 *     to the pool when done.
 *   - Lock acquired on connection A, then `pg_advisory_unlock` issued on
 *     connection B (next pool checkout) → silent no-op (returns `false`).
 *   - Connection A returned to pool with the lock STILL HELD.
 *   - The same key would then be perpetually unacquirable from any other
 *     connection until the docker container restarts and the connection
 *     dies (only then does the session end and PG releases the lock).
 *
 * Symptom in practice: tier-refresh jobs increasingly logged
 * "[leaderboard-batch] N skipped (locked elsewhere)" as connections
 * accumulated stuck locks. A docker restart "fixed" it for a while.
 *
 * The fix is to use **transaction-scoped** advisory locks
 * (`pg_advisory_xact_lock`), which PG releases automatically on COMMIT
 * or ROLLBACK. By holding the connection for the whole transaction we
 * also guarantee acquire/release happen on the same connection, no
 * matter what the work function does internally with the pool.
 */

import { historyPool } from "@/lib/db-history";

const NS = 0xC1D7; // 'clydex' marker
const THIRTY_TWO = BigInt(32);

export function accountIdToLockKey(accountId: number): bigint {
  const uint32 = BigInt(accountId >>> 0);
  return (BigInt(NS) << THIRTY_TWO) | uint32;
}

/**
 * Run `fn` while holding a transaction-scoped advisory lock on
 * `accountId`. Returns:
 *   - the result of `fn` if the lock was acquired and `fn` resolved;
 *   - `undefined` if another worker already holds the lock (caller should
 *     skip — the other worker is doing the same job);
 *   - throws if `fn` throws (the lock is still released by the rollback).
 *
 * Note: `fn` runs OUTSIDE the lock transaction in terms of its own DB
 * work. The transaction here exists only to scope the lock; `fn` is
 * free to use `historyPool.query` / its own transactions internally.
 * That's fine because all we need is mutex semantics, not ACID coupling
 * between the lock and the work.
 */
export async function withAccountLock<T>(
  accountId: number,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const key = accountIdToLockKey(accountId);
  const client = await historyPool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock($1::bigint) AS locked`,
      [key.toString()],
    );
    if (!rows[0]?.locked) {
      // Someone else holds the lock — release the txn (and the failed
      // try-lock, which is a no-op release since we never acquired) and
      // signal "skip" via undefined.
      await client.query("ROLLBACK");
      return undefined;
    }
    try {
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (err) {
      // Bubble the work error up but make sure the lock is released
      // before we let the connection rejoin the pool.
      await client.query("ROLLBACK").catch(() => {
        /* swallow rollback errors — original work error is more useful */
      });
      throw err;
    }
  } finally {
    client.release();
  }
}
