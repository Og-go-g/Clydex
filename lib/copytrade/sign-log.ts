/**
 * Hash-chained sign-log writer.
 *
 * Appends one row per signed-on-behalf-of-user action to the
 * `sign_log` table. Each row carries a SHA-256 hash chain back to
 * the previous row, so tamper-evident: an attacker who later
 * doctors a single past row invalidates every subsequent row's
 * hash. The "true" chain root is the latest row's `this_hash`;
 * future ops work mirrors that to an off-box bulletin so even full
 * DB compromise can't quietly re-write history.
 *
 * Why this complements the per-action signing policy from
 * lib/copytrade/signing-policy.ts: the policy refuses sketchy
 * sign requests BEFORE the SDK call; the log records what
 * actually happened (including refusals) AFTER the decision so an
 * auditor can reconstruct the engine's behaviour from outside the
 * box. Together they're the "approved / actually-done" pair.
 *
 * Concurrency:
 *   - The copy engine holds a per-leader advisory lock during each
 *     leader's processing (A6), so sign attempts within one leader
 *     are serial. Across leaders they're parallel.
 *   - We compute `this_hash` based on the latest `prev_hash` we
 *     fetch from the DB transactionally. Two concurrent writers
 *     for different leaders would each see the same prev_hash and
 *     race on insert — the BIGSERIAL ID still gives total order,
 *     and the chain itself is reconstructable by sorting by id,
 *     but the hashes might be computed against a sibling rather
 *     than the strict prev. Acceptable: this is a tamper-evidence
 *     primitive, not strict total-ordering.
 *
 *   - For STRICT chain ordering across leaders the engine would
 *     need a global sign-log lock. We deliberately don't, because
 *     it would serialize all copy signs system-wide and a single
 *     slow sign would block everything. The race window is
 *     measured in milliseconds at the DB-insert level and the
 *     follower-scoped audit path (which is the user-facing one)
 *     IS strictly ordered per-follower thanks to advisory locks.
 *
 * Append-only at the DB level:
 *   - REVOKE UPDATE, DELETE ON sign_log FROM clydex (see
 *     sql/2026-05-21_sign_log.sql). The app role can only INSERT
 *     and SELECT. A SQL injection that lands on this table cannot
 *     re-write a past row.
 */

import { createHash } from "crypto";
import { query } from "../db-history";

export interface SignLogEntry {
  followerWallet: string;
  leaderWallet: string | null;
  /** "open" | "close" | "increase" | "decrease" | "flip" */
  action: string;
  marketId: number;
  symbol: string;
  /** "Long" | "Short" */
  side: string;
  size: number;
  leverage: number;
  slippage: number;
  markPrice: number;
  /** "approved" or "refused:<reason>" — mirrors signing-policy.ts shape. */
  policyResult: string;
  signedAt: Date;
}

const ZERO_HASH = Buffer.alloc(32);

/**
 * Serialize the chained portion of a sign-log row for hashing. Field
 * order is locked into a sorted-key JSON so a future code refactor that
 * reorders the columns in the table doesn't silently change the chain.
 */
function serializeForHash(entry: SignLogEntry): string {
  const ordered = {
    action: entry.action,
    followerWallet: entry.followerWallet,
    leaderWallet: entry.leaderWallet,
    leverage: entry.leverage,
    markPrice: entry.markPrice,
    marketId: entry.marketId,
    policyResult: entry.policyResult,
    side: entry.side,
    signedAt: entry.signedAt.toISOString(),
    size: entry.size,
    slippage: entry.slippage,
    symbol: entry.symbol,
  };
  return JSON.stringify(ordered);
}

/**
 * Compute `this_hash` = SHA256(prev_hash || serialize(row)). Exposed
 * for unit testing and for verifying the chain offline.
 */
export function computeChainHash(prevHash: Buffer, entry: SignLogEntry): Buffer {
  const h = createHash("sha256");
  h.update(prevHash);
  h.update(serializeForHash(entry));
  return h.digest();
}

/**
 * Append a sign-log row. Returns the new row's id and this_hash for
 * the caller (typically the engine) to emit a Sentry breadcrumb or
 * surface in /api/copy/sign-log.
 *
 * On error, throws — the caller must decide whether to surface the
 * failure or swallow it. The engine currently swallows: a sign that
 * succeeded on-chain shouldn't be retried just because the audit log
 * failed to write. Sentry breadcrumb covers the gap.
 */
export async function appendSignLog(
  entry: SignLogEntry,
): Promise<{ id: number; thisHash: Buffer }> {
  // Fetch the latest chain hash. If the table is empty, start from
  // 32 zero bytes (canonical "genesis prev").
  const tail = await query<{ this_hash: Buffer }>(
    `SELECT this_hash FROM sign_log ORDER BY id DESC LIMIT 1`,
  );
  const prevHash = tail[0]?.this_hash ?? ZERO_HASH;
  const thisHash = computeChainHash(prevHash, entry);

  const rows = await query<{ id: number }>(
    `INSERT INTO sign_log
       (follower_wallet, leader_wallet, action, market_id, symbol,
        side, size, leverage, slippage, mark_price, policy_result,
        prev_hash, this_hash, signed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      entry.followerWallet,
      entry.leaderWallet,
      entry.action,
      entry.marketId,
      entry.symbol,
      entry.side,
      entry.size,
      entry.leverage,
      entry.slippage,
      entry.markPrice,
      entry.policyResult,
      prevHash,
      thisHash,
      entry.signedAt,
    ],
  );

  return { id: rows[0].id, thisHash };
}

/**
 * Verify a slice of the chain offline. Reads rows by id range, walks
 * forward recomputing this_hash from prev_hash + row contents, asserts
 * each matches the stored this_hash. Returns the first id where the
 * chain breaks, or null if the slice is intact.
 *
 * Used by /api/copy/sign-log to let users verify their own slice and
 * by an admin tool to spot-check the chain after a suspected
 * compromise.
 */
export async function verifyChain(
  fromId: number,
  toId: number,
): Promise<{ ok: true } | { ok: false; firstBreakAt: number }> {
  const rows = await query<{
    id: number;
    follower_wallet: string;
    leader_wallet: string | null;
    action: string;
    market_id: number;
    symbol: string;
    side: string;
    size: string;
    leverage: string;
    slippage: string;
    mark_price: string;
    policy_result: string;
    prev_hash: Buffer;
    this_hash: Buffer;
    signed_at: Date;
  }>(
    `SELECT id, follower_wallet, leader_wallet, action, market_id,
            symbol, side, size, leverage, slippage, mark_price,
            policy_result, prev_hash, this_hash, signed_at
     FROM sign_log
     WHERE id BETWEEN $1 AND $2
     ORDER BY id ASC`,
    [fromId, toId],
  );

  // PG decimal → string; cast back to number for hash input. The
  // serializeForHash field order MUST match between writer and
  // verifier, so we reconstruct the same SignLogEntry shape here.
  let expectedPrev: Buffer | null = null;
  for (const r of rows) {
    if (expectedPrev !== null && !r.prev_hash.equals(expectedPrev)) {
      return { ok: false, firstBreakAt: r.id };
    }
    const entry: SignLogEntry = {
      followerWallet: r.follower_wallet,
      leaderWallet: r.leader_wallet,
      action: r.action,
      marketId: r.market_id,
      symbol: r.symbol,
      side: r.side,
      size: Number(r.size),
      leverage: Number(r.leverage),
      slippage: Number(r.slippage),
      markPrice: Number(r.mark_price),
      policyResult: r.policy_result,
      signedAt: r.signed_at,
    };
    const computed = computeChainHash(r.prev_hash, entry);
    if (!computed.equals(r.this_hash)) {
      return { ok: false, firstBreakAt: r.id };
    }
    expectedPrev = r.this_hash;
  }
  return { ok: true };
}
