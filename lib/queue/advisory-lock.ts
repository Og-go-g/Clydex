/**
 * Advisory locks for account-level coordination between worker jobs.
 *
 * Lock keyspace is namespaced via NS offset in upper 16 bits to avoid
 * collisions with copy engine's lock keys (32-bit hash of leaderAddr).
 *
 *   accountIdToLockKey(id) = (0xC1D7 << 32) | (id as uint32)
 *
 * This is a signed 64-bit bigint — well-formed for pg's pg_try_advisory_lock(bigint).
 */

import { query } from "@/lib/db-history";

const NS = 0xC1D7; // 'clydex' marker
const THIRTY_TWO = BigInt(32);

export function accountIdToLockKey(accountId: number): bigint {
  const uint32 = BigInt(accountId >>> 0);
  return (BigInt(NS) << THIRTY_TWO) | uint32;
}

export async function tryAdvisoryLock(key: bigint): Promise<boolean> {
  const rows = await query<{ locked: boolean }>(
    `SELECT pg_try_advisory_lock($1::bigint) AS locked`,
    [key.toString()],
  );
  return !!rows[0]?.locked;
}

export async function releaseAdvisoryLock(key: bigint): Promise<void> {
  await query(`SELECT pg_advisory_unlock($1::bigint)`, [key.toString()]);
}

/**
 * Run fn with advisory lock held. Returns undefined if lock could not be acquired.
 */
export async function withAccountLock<T>(
  accountId: number,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const key = accountIdToLockKey(accountId);
  const locked = await tryAdvisoryLock(key);
  if (!locked) return undefined;
  try {
    return await fn();
  } finally {
    await releaseAdvisoryLock(key);
  }
}
