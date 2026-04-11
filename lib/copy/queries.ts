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
  stopLossPct: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CopySnapshot extends Record<string, unknown> {
  id: string;
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
): Promise<string> {
  const id = uuid();
  await execute(
    `INSERT INTO copy_sessions (id, wallet_addr, encrypted_key, iv, auth_tag, session_pubkey, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (wallet_addr) DO UPDATE SET
       encrypted_key = EXCLUDED.encrypted_key,
       iv = EXCLUDED.iv,
       auth_tag = EXCLUDED.auth_tag,
       session_pubkey = EXCLUDED.session_pubkey,
       expires_at = EXCLUDED.expires_at,
       created_at = NOW()`,
    [id, walletAddr, encrypted.ciphertext, encrypted.iv, encrypted.authTag, sessionPubkey, expiresAt],
  );
  return id;
}

export async function getSession(walletAddr: string): Promise<CopySession | null> {
  const rows = await query<CopySession>(
    `SELECT id, wallet_addr AS "walletAddr", encrypted_key AS "encryptedKey",
            iv, auth_tag AS "authTag", session_pubkey AS "sessionPubkey",
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
  stopLossPct?: number;
}): Promise<string> {
  const id = uuid();
  await execute(
    `INSERT INTO copy_subscriptions (id, follower_addr, leader_addr, allocation_usdc, leverage_mult, max_position_usdc, stop_loss_pct)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (follower_addr, leader_addr) DO UPDATE SET
       allocation_usdc = EXCLUDED.allocation_usdc,
       leverage_mult = EXCLUDED.leverage_mult,
       max_position_usdc = EXCLUDED.max_position_usdc,
       stop_loss_pct = EXCLUDED.stop_loss_pct,
       active = TRUE,
       updated_at = NOW()`,
    [
      id,
      params.followerAddr,
      params.leaderAddr,
      params.allocationUsdc,
      params.leverageMult ?? 1.0,
      params.maxPositionUsdc ?? null,
      params.stopLossPct ?? null,
    ],
  );
  return id;
}

export async function getSubscriptions(followerAddr: string): Promise<CopySubscription[]> {
  return query<CopySubscription>(
    `SELECT id, follower_addr AS "followerAddr", leader_addr AS "leaderAddr",
            allocation_usdc AS "allocationUsdc", leverage_mult AS "leverageMult",
            max_position_usdc AS "maxPositionUsdc", stop_loss_pct AS "stopLossPct",
            active, created_at AS "createdAt", updated_at AS "updatedAt"
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
            max_position_usdc AS "maxPositionUsdc", stop_loss_pct AS "stopLossPct",
            active, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM copy_subscriptions
     WHERE leader_addr = $1 AND active = TRUE`,
    [leaderAddr],
  );
}

export async function toggleSubscription(id: string, active: boolean): Promise<void> {
  await execute(
    `UPDATE copy_subscriptions SET active = $1, updated_at = NOW() WHERE id = $2`,
    [active, id],
  );
}

export async function deleteSubscription(followerAddr: string, leaderAddr: string): Promise<number> {
  return execute(
    `DELETE FROM copy_subscriptions WHERE follower_addr = $1 AND leader_addr = $2`,
    [followerAddr, leaderAddr],
  );
}

// ─── Snapshots ───────────────────────────────────────────────────

export async function upsertSnapshot(
  leaderAddr: string,
  marketId: number,
  size: string,
  side: string,
): Promise<void> {
  await execute(
    `INSERT INTO copy_snapshots (id, leader_addr, market_id, size, side)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (leader_addr, market_id) DO UPDATE SET
       size = EXCLUDED.size,
       side = EXCLUDED.side,
       captured_at = NOW()`,
    [uuid(), leaderAddr, marketId, size, side],
  );
}

export async function getSnapshots(leaderAddr: string): Promise<CopySnapshot[]> {
  return query<CopySnapshot>(
    `SELECT id, leader_addr AS "leaderAddr", market_id AS "marketId",
            size, side, captured_at AS "capturedAt"
     FROM copy_snapshots
     WHERE leader_addr = $1`,
    [leaderAddr],
  );
}

export async function deleteSnapshots(leaderAddr: string): Promise<void> {
  await execute(`DELETE FROM copy_snapshots WHERE leader_addr = $1`, [leaderAddr]);
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
}): Promise<string> {
  const id = uuid();
  await execute(
    `INSERT INTO copy_trades (id, subscription_id, follower_addr, leader_addr, market_id, symbol, side, size, orig_trade_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, params.subscriptionId, params.followerAddr, params.leaderAddr, params.marketId, params.symbol, params.side, params.size, params.origTradeId ?? null],
  );
  return id;
}

export async function updateCopyTradeStatus(
  id: string,
  status: "filled" | "failed" | "cancelled",
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
