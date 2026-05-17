import { query, execute, uuid } from "../db-history";
import type { EncryptedSession } from "./session-crypto";

// ─── Types ───────────────────────────────────────────────────────

export interface CopySession extends Record<string, unknown> {
  id: string;
  walletAddr: string;
  encryptedKey: string;
  iv: string;
  authTag: string;
  sessionPubkey: string;
  sessionIdStr: string | null; // bigint as string
  expiresAt: Date;
  createdAt: Date;
}

export interface CopySubscription extends Record<string, unknown> {
  id: string;
  followerAddr: string;
  leaderAddr: string;
  allocationUsdc: string;
  leverageMult: string;
  maxPositionUsdc: string | null;
  maxTotalPositionUsdc: string | null;
  stopLossPct: string | null;
  active: boolean;
  /** NULL = engine has not yet completed first-run bootstrap for this
   * (follower, leader) pair. Set to NOW() at the end of the first
   * successful engine cycle that processes this subscription, regardless
   * of whether leader had any positions to baseline. See
   * sql/2026-05-15_subscription_bootstrap_flag.sql for the rationale. */
  bootstrappedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CopySnapshot extends Record<string, unknown> {
  id: string;
  followerAddr: string;
  leaderAddr: string;
  marketId: number;
  size: string;
  side: string;
  capturedAt: Date;
}

export interface CopyTrade extends Record<string, unknown> {
  id: string;
  subscriptionId: string;
  followerAddr: string;
  leaderAddr: string;
  marketId: number;
  symbol: string;
  side: string;
  size: string;
  price: string | null;
  status: string;
  error: string | null;
  origTradeId: string | null;
  orderId: string | null;
  createdAt: Date;
  filledAt: Date | null;
}

// ─── Sessions ────────────────────────────────────────────────────

export async function upsertSession(
  walletAddr: string,
  encrypted: EncryptedSession,
  sessionPubkey: string,
  expiresAt: Date,
  sessionIdStr?: string,
): Promise<string> {
  const id = uuid();
  await execute(
    `INSERT INTO copy_sessions (id, wallet_addr, encrypted_key, iv, auth_tag, session_pubkey, session_id_str, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (wallet_addr) DO UPDATE SET
       encrypted_key = EXCLUDED.encrypted_key,
       iv = EXCLUDED.iv,
       auth_tag = EXCLUDED.auth_tag,
       session_pubkey = EXCLUDED.session_pubkey,
       session_id_str = EXCLUDED.session_id_str,
       expires_at = EXCLUDED.expires_at,
       created_at = NOW()`,
    [id, walletAddr, encrypted.ciphertext, encrypted.iv, encrypted.authTag, sessionPubkey, sessionIdStr ?? null, expiresAt],
  );
  return id;
}

export async function getSession(walletAddr: string): Promise<CopySession | null> {
  const rows = await query<CopySession>(
    `SELECT id, wallet_addr AS "walletAddr", encrypted_key AS "encryptedKey",
            iv, auth_tag AS "authTag", session_pubkey AS "sessionPubkey",
            session_id_str AS "sessionIdStr",
            expires_at AS "expiresAt", created_at AS "createdAt"
     FROM copy_sessions
     WHERE wallet_addr = $1 AND expires_at > NOW()`,
    [walletAddr],
  );
  return rows[0] ?? null;
}

export async function deleteSession(walletAddr: string): Promise<void> {
  await execute(`DELETE FROM copy_sessions WHERE wallet_addr = $1`, [walletAddr]);
}

// ─── Subscriptions ───────────────────────────────────────────────

export async function createSubscription(params: {
  followerAddr: string;
  leaderAddr: string;
  allocationUsdc: number;
  leverageMult?: number;
  maxPositionUsdc?: number;
  maxTotalPositionUsdc?: number;
  stopLossPct?: number;
}): Promise<string> {
  const id = uuid();
  // ON CONFLICT path also re-activates (active = TRUE) — previously this
  // silently resurrected subscriptions a user had explicitly paused via
  // toggleSubscription(id, false). Now we only flip `active` to TRUE when
  // the existing row is ALREADY active; a paused row stays paused even
  // if the same (follower, leader) pair gets a new createSubscription
  // call from the dialog. To re-enable, the user has to explicitly
  // toggle it back via the existing toggle endpoint.
  await execute(
    `INSERT INTO copy_subscriptions (id, follower_addr, leader_addr, allocation_usdc, leverage_mult, max_position_usdc, max_total_position_usdc, stop_loss_pct)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (follower_addr, leader_addr) DO UPDATE SET
       allocation_usdc = EXCLUDED.allocation_usdc,
       leverage_mult = EXCLUDED.leverage_mult,
       max_position_usdc = EXCLUDED.max_position_usdc,
       max_total_position_usdc = EXCLUDED.max_total_position_usdc,
       stop_loss_pct = EXCLUDED.stop_loss_pct,
       updated_at = NOW()`,
    [
      id,
      params.followerAddr,
      params.leaderAddr,
      params.allocationUsdc,
      params.leverageMult ?? 1.0,
      params.maxPositionUsdc ?? null,
      params.maxTotalPositionUsdc ?? null,
      params.stopLossPct ?? null,
    ],
  );
  return id;
}

export async function getSubscriptions(followerAddr: string): Promise<CopySubscription[]> {
  return query<CopySubscription>(
    `SELECT id, follower_addr AS "followerAddr", leader_addr AS "leaderAddr",
            allocation_usdc AS "allocationUsdc", leverage_mult AS "leverageMult",
            max_position_usdc AS "maxPositionUsdc", max_total_position_usdc AS "maxTotalPositionUsdc", stop_loss_pct AS "stopLossPct",
            active, bootstrapped_at AS "bootstrappedAt", created_at AS "createdAt", updated_at AS "updatedAt"
     FROM copy_subscriptions
     WHERE follower_addr = $1
     ORDER BY created_at DESC`,
    [followerAddr],
  );
}

export async function getActiveSubscriptionsByLeader(leaderAddr: string): Promise<CopySubscription[]> {
  return query<CopySubscription>(
    `SELECT id, follower_addr AS "followerAddr", leader_addr AS "leaderAddr",
            allocation_usdc AS "allocationUsdc", leverage_mult AS "leverageMult",
            max_position_usdc AS "maxPositionUsdc", max_total_position_usdc AS "maxTotalPositionUsdc", stop_loss_pct AS "stopLossPct",
            active, bootstrapped_at AS "bootstrappedAt", created_at AS "createdAt", updated_at AS "updatedAt"
     FROM copy_subscriptions
     WHERE leader_addr = $1 AND active = TRUE`,
    [leaderAddr],
  );
}

export async function updateSubscriptionSettings(
  id: string,
  settings: {
    allocationUsdc?: number;
    leverageMult?: number;
    maxPositionUsdc?: number | null;
    maxTotalPositionUsdc?: number | null;
    stopLossPct?: number | null;
    active?: boolean;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (settings.allocationUsdc !== undefined) {
    sets.push(`allocation_usdc = $${idx}`);
    params.push(settings.allocationUsdc);
    idx++;
  }
  if (settings.leverageMult !== undefined) {
    sets.push(`leverage_mult = $${idx}`);
    params.push(settings.leverageMult);
    idx++;
  }
  if (settings.maxPositionUsdc !== undefined) {
    sets.push(`max_position_usdc = $${idx}`);
    params.push(settings.maxPositionUsdc);
    idx++;
  }
  if (settings.maxTotalPositionUsdc !== undefined) {
    sets.push(`max_total_position_usdc = $${idx}`);
    params.push(settings.maxTotalPositionUsdc);
    idx++;
  }
  if (settings.stopLossPct !== undefined) {
    sets.push(`stop_loss_pct = $${idx}`);
    params.push(settings.stopLossPct);
    idx++;
  }
  if (settings.active !== undefined) {
    sets.push(`active = $${idx}`);
    params.push(settings.active);
    idx++;
  }

  if (sets.length === 0) return;

  sets.push("updated_at = NOW()");
  params.push(id);
  await execute(
    `UPDATE copy_subscriptions SET ${sets.join(", ")} WHERE id = $${idx}`,
    params,
  );
}

export async function toggleSubscription(id: string, active: boolean): Promise<void> {
  await execute(
    `UPDATE copy_subscriptions SET active = $1, updated_at = NOW() WHERE id = $2`,
    [active, id],
  );
}

/**
 * Mark a subscription's first-run bootstrap as complete. Called by the
 * engine at the end of the isFirstRun branch, regardless of whether
 * the leader had positions to baseline. Sets bootstrapped_at = NOW()
 * if it's currently NULL; idempotent on subsequent calls (NULL check
 * prevents overwriting an earlier timestamp).
 */
export async function markSubscriptionBootstrapped(id: string): Promise<void> {
  await execute(
    `UPDATE copy_subscriptions
     SET bootstrapped_at = NOW()
     WHERE id = $1 AND bootstrapped_at IS NULL`,
    [id],
  );
}

export async function deleteSubscription(followerAddr: string, leaderAddr: string): Promise<number> {
  // Wipe per-follower snapshots so a re-subscribe gets fresh first-run
  // bootstrap (otherwise stale snapshots from before unfollow would
  // make the engine think the follower already mirrored to those
  // positions and skip the actual sync).
  await deleteFollowerSnapshots(followerAddr, leaderAddr);
  return execute(
    `DELETE FROM copy_subscriptions WHERE follower_addr = $1 AND leader_addr = $2`,
    [followerAddr, leaderAddr],
  );
}

// ─── Snapshots ───────────────────────────────────────────────────

/**
 * Upsert one (follower, leader, market) snapshot row.
 *
 * Per-follower so a failed copy_trade for one follower doesn't poison
 * the others' diff detection. Engine writes ONLY after a successful
 * order fill, so failed trades naturally re-appear as diffs in the next
 * cycle (this row simply doesn't advance for that follower).
 */
export async function upsertSnapshot(
  followerAddr: string,
  leaderAddr: string,
  marketId: number,
  size: string,
  side: string,
): Promise<void> {
  await execute(
    `INSERT INTO copy_snapshots (id, follower_addr, leader_addr, market_id, size, side)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (follower_addr, leader_addr, market_id) DO UPDATE SET
       size = EXCLUDED.size,
       side = EXCLUDED.side,
       captured_at = NOW()`,
    [uuid(), followerAddr, leaderAddr, marketId, size, side],
  );
}

export async function getSnapshots(
  followerAddr: string,
  leaderAddr: string,
): Promise<CopySnapshot[]> {
  return query<CopySnapshot>(
    `SELECT id, follower_addr AS "followerAddr", leader_addr AS "leaderAddr",
            market_id AS "marketId", size, side, captured_at AS "capturedAt"
     FROM copy_snapshots
     WHERE follower_addr = $1 AND leader_addr = $2`,
    [followerAddr, leaderAddr],
  );
}

/** Delete a single (follower, leader, market) snapshot — used on close fills. */
export async function deleteSnapshot(
  followerAddr: string,
  leaderAddr: string,
  marketId: number,
): Promise<void> {
  await execute(
    `DELETE FROM copy_snapshots
     WHERE follower_addr = $1 AND leader_addr = $2 AND market_id = $3`,
    [followerAddr, leaderAddr, marketId],
  );
}

/**
 * Delete all snapshots for a (follower, leader) pair — used on unfollow
 * to clean up so a re-subscribe gets a fresh first-run.
 */
export async function deleteFollowerSnapshots(
  followerAddr: string,
  leaderAddr: string,
): Promise<void> {
  await execute(
    `DELETE FROM copy_snapshots WHERE follower_addr = $1 AND leader_addr = $2`,
    [followerAddr, leaderAddr],
  );
}

// ─── Copy Trades ─────────────────────────────────────────────────

export async function insertCopyTrade(params: {
  subscriptionId: string;
  followerAddr: string;
  leaderAddr: string;
  marketId: number;
  symbol: string;
  side: string;
  size: string;
  origTradeId?: string;
  /** Defaults to 'pending'. Pass 'skipped' or 'failed' for already-final trades to save a roundtrip. */
  status?: "pending" | "filled" | "failed" | "cancelled" | "skipped";
  error?: string;
}): Promise<string> {
  const id = uuid();
  await execute(
    `INSERT INTO copy_trades (id, subscription_id, follower_addr, leader_addr, market_id, symbol, side, size, orig_trade_id, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, 'pending'), $11)`,
    [
      id,
      params.subscriptionId,
      params.followerAddr,
      params.leaderAddr,
      params.marketId,
      params.symbol,
      params.side,
      params.size,
      params.origTradeId ?? null,
      params.status ?? null,
      params.error ?? null,
    ],
  );
  return id;
}

export async function updateCopyTradeStatus(
  id: string,
  status: "filled" | "failed" | "cancelled" | "skipped",
  extra?: { orderId?: string; price?: string; error?: string },
): Promise<void> {
  await execute(
    `UPDATE copy_trades SET
       status = $1,
       order_id = COALESCE($2, order_id),
       price = COALESCE($3, price),
       error = COALESCE($4, error),
       filled_at = CASE WHEN $1 = 'filled' THEN NOW() ELSE filled_at END
     WHERE id = $5`,
    [status, extra?.orderId ?? null, extra?.price ?? null, extra?.error ?? null, id],
  );
}

export async function getRecentCopyTrades(
  followerAddr: string,
  limit = 20,
): Promise<CopyTrade[]> {
  return query<CopyTrade>(
    `SELECT id, subscription_id AS "subscriptionId", follower_addr AS "followerAddr",
            leader_addr AS "leaderAddr", market_id AS "marketId", symbol, side, size,
            price, status, error, orig_trade_id AS "origTradeId", order_id AS "orderId",
            created_at AS "createdAt", filled_at AS "filledAt"
     FROM copy_trades
     WHERE follower_addr = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [followerAddr, limit],
  );
}

// ─── Stats ───────────────────────────────────────────────────────

// ─── Engine Queries ──────────────────────────────────────────────

/** Get unique leader addresses that have at least one active follower */
export async function getActiveLeaders(): Promise<string[]> {
  const rows = await query<{ leaderAddr: string }>(
    `SELECT DISTINCT leader_addr AS "leaderAddr"
     FROM copy_subscriptions
     WHERE active = TRUE`,
    [],
  );
  return rows.map((r) => r.leaderAddr);
}

/**
 * Get all active followers for a specific leader, oldest subscription
 * first. Order matters for ownership-collision determinism: when two
 * followers' subscriptions concurrently bid for ownership of a new
 * market in the same engine cycle, the older subscription wins.
 */
export async function getFollowersForLeader(leaderAddr: string): Promise<CopySubscription[]> {
  return query<CopySubscription>(
    `SELECT id, follower_addr AS "followerAddr", leader_addr AS "leaderAddr",
            allocation_usdc AS "allocationUsdc", leverage_mult AS "leverageMult",
            max_position_usdc AS "maxPositionUsdc", max_total_position_usdc AS "maxTotalPositionUsdc", stop_loss_pct AS "stopLossPct",
            active, bootstrapped_at AS "bootstrappedAt", created_at AS "createdAt", updated_at AS "updatedAt"
     FROM copy_subscriptions
     WHERE leader_addr = $1 AND active = TRUE
     ORDER BY created_at ASC`,
    [leaderAddr],
  );
}

/** Get recent copy trades since a timestamp (for toast notifications) */
export async function getRecentCopyTradesSince(
  followerAddr: string,
  since: Date,
): Promise<CopyTrade[]> {
  return query<CopyTrade>(
    `SELECT id, subscription_id AS "subscriptionId", follower_addr AS "followerAddr",
            leader_addr AS "leaderAddr", market_id AS "marketId", symbol, side, size,
            price, status, error, orig_trade_id AS "origTradeId", order_id AS "orderId",
            created_at AS "createdAt", filled_at AS "filledAt"
     FROM copy_trades
     WHERE follower_addr = $1 AND created_at > $2
     ORDER BY created_at DESC`,
    [followerAddr, since],
  );
}

/** Count consecutive failures for circuit breaker */
export async function getConsecutiveFailures(subscriptionId: string): Promise<number> {
  const rows = await query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM (
       SELECT status FROM copy_trades
       WHERE subscription_id = $1
       ORDER BY created_at DESC LIMIT 5
     ) recent WHERE status = 'failed'`,
    [subscriptionId],
  );
  return parseInt(rows[0]?.cnt ?? "0");
}

/** Get market IDs where copy trades were actually executed for a specific leader */
export async function getCopiedMarketIds(
  followerAddr: string,
  leaderAddr: string,
): Promise<number[]> {
  const rows = await query<{ marketId: number }>(
    `SELECT DISTINCT market_id AS "marketId"
     FROM copy_trades
     WHERE follower_addr = $1 AND leader_addr = $2 AND status = 'filled'`,
    [followerAddr, leaderAddr],
  );
  return rows.map((r) => r.marketId);
}

/**
 * Markets currently OWNED by (follower, leader) per copy_position_ownership.
 * This is the authoritative "what should we close on bulk unfollow" list —
 * unlike getCopiedMarketIds which reads from copy_trades history and
 * therefore includes markets the user already closed manually (which we
 * must NOT touch again, since the position there is now either gone or
 * a fresh manual position).
 */
export async function getOwnedMarketIdsForLeader(
  followerAddr: string,
  leaderAddr: string,
): Promise<number[]> {
  const rows = await query<{ marketId: number }>(
    `SELECT market_id AS "marketId"
     FROM copy_position_ownership
     WHERE follower_addr = $1 AND owning_leader_addr = $2`,
    [followerAddr, leaderAddr],
  );
  return rows.map((r) => r.marketId);
}

// ─── Position ownership ("one leader per market") ───────────────

export interface PositionOwnership extends Record<string, unknown> {
  followerAddr: string;
  marketId: number;
  owningLeaderAddr: string;
  subscriptionId: string | null;
  openedAt: Date;
}

/** Look up current owner of (follower, market). Returns null if free. */
export async function getOwnership(
  followerAddr: string,
  marketId: number,
): Promise<PositionOwnership | null> {
  const rows = await query<PositionOwnership>(
    `SELECT follower_addr AS "followerAddr", market_id AS "marketId",
            owning_leader_addr AS "owningLeaderAddr",
            subscription_id AS "subscriptionId",
            opened_at AS "openedAt"
     FROM copy_position_ownership
     WHERE follower_addr = $1 AND market_id = $2`,
    [followerAddr, marketId],
  );
  return rows[0] ?? null;
}

/**
 * Atomically claim ownership for (follower, market). Returns true if
 * acquired (or already owned by the same leader), false if owned by
 * another leader. Used as the engine's gate before placeOrder.
 *
 * On conflict where the existing owner matches the requested leader
 * (re-subscribe case after orphan), refresh `subscription_id` to the
 * current sub. Otherwise preserve existing owner + sub_id (collision).
 */
export async function acquireOwnership(
  followerAddr: string,
  marketId: number,
  leaderAddr: string,
  subscriptionId: string,
): Promise<boolean> {
  const rows = await query<{ owningLeaderAddr: string }>(
    `INSERT INTO copy_position_ownership
       (follower_addr, market_id, owning_leader_addr, subscription_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (follower_addr, market_id) DO UPDATE SET
       owning_leader_addr = copy_position_ownership.owning_leader_addr,
       subscription_id = CASE
         WHEN copy_position_ownership.owning_leader_addr = EXCLUDED.owning_leader_addr
         THEN EXCLUDED.subscription_id
         ELSE copy_position_ownership.subscription_id
       END
     RETURNING owning_leader_addr AS "owningLeaderAddr"`,
    [followerAddr, marketId, leaderAddr, subscriptionId],
  );
  return rows[0]?.owningLeaderAddr === leaderAddr;
}

/** Release ownership of (follower, market) — used on full close. */
export async function releaseOwnership(
  followerAddr: string,
  marketId: number,
): Promise<void> {
  await execute(
    `DELETE FROM copy_position_ownership
     WHERE follower_addr = $1 AND market_id = $2`,
    [followerAddr, marketId],
  );
}

/**
 * Release all ownership rows for (follower, leader) — used on
 * unfollow-with-close-positions. After this the markets are free for
 * other leaders.
 */
export async function releaseAllOwnership(
  followerAddr: string,
  leaderAddr: string,
): Promise<void> {
  await execute(
    `DELETE FROM copy_position_ownership
     WHERE follower_addr = $1 AND owning_leader_addr = $2`,
    [followerAddr, leaderAddr],
  );
}

/**
 * All ownership rows for a follower — used by the Open Copy Positions
 * panel to enrich with live exchange position data. Includes
 * orphan-locked rows (subscription_id IS NULL) so the panel can
 * still show + close those positions.
 */
export async function getOwnershipForFollower(
  followerAddr: string,
): Promise<PositionOwnership[]> {
  return query<PositionOwnership>(
    `SELECT follower_addr AS "followerAddr", market_id AS "marketId",
            owning_leader_addr AS "owningLeaderAddr",
            subscription_id AS "subscriptionId",
            opened_at AS "openedAt"
     FROM copy_position_ownership
     WHERE follower_addr = $1
     ORDER BY opened_at ASC`,
    [followerAddr],
  );
}

/**
 * Get markets owned by OTHER leaders (i.e. forbidden) for this
 * follower if they were to subscribe to a new candidate leader.
 * Used by the FollowTraderDialog overlap-warning UX — shows the user
 * which markets the candidate leader trades that are already locked.
 */
export async function getMarketsBlockedForFollower(
  followerAddr: string,
  excludeLeaderAddr: string,
): Promise<Array<{ marketId: number; owningLeaderAddr: string }>> {
  return query<{ marketId: number; owningLeaderAddr: string }>(
    `SELECT market_id AS "marketId", owning_leader_addr AS "owningLeaderAddr"
     FROM copy_position_ownership
     WHERE follower_addr = $1 AND owning_leader_addr <> $2`,
    [followerAddr, excludeLeaderAddr],
  );
}

// ─── Stats ───────────────────────────────────────────────────────

// ─── Paginated History ──────────────────────────────────────────

export async function getCopyTradesHistory(
  followerAddr: string,
  opts: {
    limit?: number;
    offset?: number;
    leaderAddr?: string;
    status?: string;
  } = {},
): Promise<{ trades: CopyTrade[]; total: number }> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const conditions = [`follower_addr = $1`];
  const params: unknown[] = [followerAddr];
  let idx = 2;

  if (opts.leaderAddr) {
    conditions.push(`leader_addr = $${idx}`);
    params.push(opts.leaderAddr);
    idx++;
  }
  if (opts.status) {
    conditions.push(`status = $${idx}`);
    params.push(opts.status);
    idx++;
  }

  const where = conditions.join(" AND ");

  const [rows, countRows] = await Promise.all([
    query<CopyTrade>(
      `SELECT id, subscription_id AS "subscriptionId", follower_addr AS "followerAddr",
              leader_addr AS "leaderAddr", market_id AS "marketId", symbol, side, size,
              price, status, error, orig_trade_id AS "origTradeId", order_id AS "orderId",
              created_at AS "createdAt", filled_at AS "filledAt"
       FROM copy_trades
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    ),
    query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM copy_trades WHERE ${where}`,
      params,
    ),
  ]);

  return { trades: rows, total: parseInt(countRows[0]?.cnt ?? "0") };
}

// ─── Per-Leader Stats ───────────────────────────────────────────

export async function getPerLeaderStats(followerAddr: string): Promise<
  Array<{
    leaderAddr: string;
    totalTrades: number;
    filledTrades: number;
    failedTrades: number;
    totalVolume: number;
  }>
> {
  return query<{
    leaderAddr: string;
    totalTrades: number;
    filledTrades: number;
    failedTrades: number;
    totalVolume: number;
  }>(
    `SELECT
       leader_addr AS "leaderAddr",
       COUNT(*)::int AS "totalTrades",
       COUNT(*) FILTER (WHERE status = 'filled')::int AS "filledTrades",
       COUNT(*) FILTER (WHERE status = 'failed')::int AS "failedTrades",
       COALESCE(SUM(
         CASE WHEN status = 'filled' AND price IS NOT NULL
           THEN ABS(size::numeric * price::numeric)
           ELSE 0 END
       ), 0)::float AS "totalVolume"
     FROM copy_trades
     WHERE follower_addr = $1
     GROUP BY leader_addr
     ORDER BY "filledTrades" DESC`,
    [followerAddr],
  );
}

// ─── Trades by Leader (for expanded cards) ──────────────────────

export async function getRecentTradesByLeader(
  followerAddr: string,
  leaderAddr: string,
  limit = 10,
): Promise<CopyTrade[]> {
  return query<CopyTrade>(
    `SELECT id, subscription_id AS "subscriptionId", follower_addr AS "followerAddr",
            leader_addr AS "leaderAddr", market_id AS "marketId", symbol, side, size,
            price, status, error, orig_trade_id AS "origTradeId", order_id AS "orderId",
            created_at AS "createdAt", filled_at AS "filledAt"
     FROM copy_trades
     WHERE follower_addr = $1 AND leader_addr = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [followerAddr, leaderAddr, limit],
  );
}

export async function getCopyStats(followerAddr: string): Promise<{
  totalTrades: number;
  filledTrades: number;
  failedTrades: number;
  todayTrades: number;
}> {
  const rows = await query<{
    totalTrades: string;
    filledTrades: string;
    failedTrades: string;
    todayTrades: string;
  }>(
    `SELECT
       COUNT(*)::text AS "totalTrades",
       COUNT(*) FILTER (WHERE status = 'filled')::text AS "filledTrades",
       COUNT(*) FILTER (WHERE status = 'failed')::text AS "failedTrades",
       COUNT(*) FILTER (WHERE created_at > CURRENT_DATE)::text AS "todayTrades"
     FROM copy_trades
     WHERE follower_addr = $1`,
    [followerAddr],
  );
  const r = rows[0];
  return {
    totalTrades: parseInt(r?.totalTrades ?? "0"),
    filledTrades: parseInt(r?.filledTrades ?? "0"),
    failedTrades: parseInt(r?.failedTrades ?? "0"),
    todayTrades: parseInt(r?.todayTrades ?? "0"),
  };
}
