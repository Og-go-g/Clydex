import { query, toCamelRows } from "@/lib/db-history";
import type {
  TradeHistoryRow,
  OrderHistoryRow,
  PnlHistoryRow,
  FundingHistoryRow,
  DepositHistoryRow,
  WithdrawalHistoryRow,
  LiquidationHistoryRow,
  PagedResult,
} from "./types";

// ─── Shared ───────────────────────────────────────────────────────

interface PaginationParams {
  walletAddr: string;
  marketId?: number;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit?: number): number {
  if (!limit || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

// ─── Order History ────────────────────────────────────────────────

export async function getOrderHistory(params: PaginationParams): Promise<PagedResult<OrderHistoryRow>> {
  const { walletAddr, marketId, offset = 0 } = params;
  const limit = clampLimit(params.limit);

  const [dataRows, countRows] = await Promise.all([
    query(
      `SELECT * FROM order_history
       WHERE wallet_addr = $1 AND ($2::int IS NULL OR market_id = $2)
       ORDER BY added_at DESC LIMIT $3 OFFSET $4`,
      [walletAddr, marketId ?? null, limit, offset],
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM order_history
       WHERE wallet_addr = $1 AND ($2::int IS NULL OR market_id = $2)`,
      [walletAddr, marketId ?? null],
    ),
  ]);

  return {
    data: toCamelRows<OrderHistoryRow>(dataRows),
    total: parseInt(countRows[0]?.count ?? "0", 10),
    limit,
    offset,
  };
}

// ─── Trade History ────────────────────────────────────────────────

export async function getTradeHistory(params: PaginationParams): Promise<PagedResult<TradeHistoryRow>> {
  const { walletAddr, marketId, offset = 0 } = params;
  const limit = clampLimit(params.limit);

  const [dataRows, countRows] = await Promise.all([
    query(
      `SELECT * FROM trade_history
       WHERE wallet_addr = $1 AND ($2::int IS NULL OR market_id = $2)
       ORDER BY "time" DESC LIMIT $3 OFFSET $4`,
      [walletAddr, marketId ?? null, limit, offset],
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM trade_history
       WHERE wallet_addr = $1 AND ($2::int IS NULL OR market_id = $2)`,
      [walletAddr, marketId ?? null],
    ),
  ]);

  return {
    data: toCamelRows<TradeHistoryRow>(dataRows),
    total: parseInt(countRows[0]?.count ?? "0", 10),
    limit,
    offset,
  };
}

// ─── PnL History ──────────────────────────────────────────────────

export async function getPnlHistory(params: PaginationParams): Promise<PagedResult<PnlHistoryRow>> {
  const { walletAddr, marketId, offset = 0 } = params;
  const limit = clampLimit(params.limit);

  const [dataRows, countRows] = await Promise.all([
    query(
      `SELECT * FROM pnl_history
       WHERE wallet_addr = $1 AND ($2::int IS NULL OR market_id = $2)
       ORDER BY "time" DESC LIMIT $3 OFFSET $4`,
      [walletAddr, marketId ?? null, limit, offset],
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pnl_history
       WHERE wallet_addr = $1 AND ($2::int IS NULL OR market_id = $2)`,
      [walletAddr, marketId ?? null],
    ),
  ]);

  return {
    data: toCamelRows<PnlHistoryRow>(dataRows),
    total: parseInt(countRows[0]?.count ?? "0", 10),
    limit,
    offset,
  };
}

// ─── Funding History ──────────────────────────────────────────────

export async function getFundingHistory(params: PaginationParams): Promise<PagedResult<FundingHistoryRow>> {
  const { walletAddr, marketId, offset = 0 } = params;
  const limit = clampLimit(params.limit);

  const [dataRows, countRows] = await Promise.all([
    query(
      `SELECT * FROM funding_history
       WHERE wallet_addr = $1 AND ($2::int IS NULL OR market_id = $2)
       ORDER BY "time" DESC LIMIT $3 OFFSET $4`,
      [walletAddr, marketId ?? null, limit, offset],
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM funding_history
       WHERE wallet_addr = $1 AND ($2::int IS NULL OR market_id = $2)`,
      [walletAddr, marketId ?? null],
    ),
  ]);

  return {
    data: toCamelRows<FundingHistoryRow>(dataRows),
    total: parseInt(countRows[0]?.count ?? "0", 10),
    limit,
    offset,
  };
}

// ─── Deposit History ──────────────────────────────────────────────

export async function getDepositHistory(params: Omit<PaginationParams, "marketId">): Promise<PagedResult<DepositHistoryRow>> {
  const { walletAddr, offset = 0 } = params;
  const limit = clampLimit(params.limit);

  const [dataRows, countRows] = await Promise.all([
    query(
      `SELECT * FROM deposit_history WHERE wallet_addr = $1
       ORDER BY "time" DESC LIMIT $2 OFFSET $3`,
      [walletAddr, limit, offset],
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM deposit_history WHERE wallet_addr = $1`,
      [walletAddr],
    ),
  ]);

  return {
    data: toCamelRows<DepositHistoryRow>(dataRows),
    total: parseInt(countRows[0]?.count ?? "0", 10),
    limit,
    offset,
  };
}

// ─── Withdrawal History ───────────────────────────────────────────

export async function getWithdrawalHistory(params: Omit<PaginationParams, "marketId">): Promise<PagedResult<WithdrawalHistoryRow>> {
  const { walletAddr, offset = 0 } = params;
  const limit = clampLimit(params.limit);

  const [dataRows, countRows] = await Promise.all([
    query(
      `SELECT * FROM withdrawal_history WHERE wallet_addr = $1
       ORDER BY "time" DESC LIMIT $2 OFFSET $3`,
      [walletAddr, limit, offset],
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM withdrawal_history WHERE wallet_addr = $1`,
      [walletAddr],
    ),
  ]);

  return {
    data: toCamelRows<WithdrawalHistoryRow>(dataRows),
    total: parseInt(countRows[0]?.count ?? "0", 10),
    limit,
    offset,
  };
}

// ─── Liquidation History ──────────────────────────────────────────

export async function getLiquidationHistory(params: Omit<PaginationParams, "marketId">): Promise<PagedResult<LiquidationHistoryRow>> {
  const { walletAddr, offset = 0 } = params;
  const limit = clampLimit(params.limit);

  const [dataRows, countRows] = await Promise.all([
    query(
      `SELECT * FROM liquidation_history WHERE wallet_addr = $1
       ORDER BY "time" DESC LIMIT $2 OFFSET $3`,
      [walletAddr, limit, offset],
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM liquidation_history WHERE wallet_addr = $1`,
      [walletAddr],
    ),
  ]);

  return {
    data: toCamelRows<LiquidationHistoryRow>(dataRows),
    total: parseInt(countRows[0]?.count ?? "0", 10),
    limit,
    offset,
  };
}

// ─── Stats ────────────────────────────────────────────────────────

export async function getHistoryStats(walletAddr: string) {
  const tables = ["trade_history", "pnl_history", "funding_history", "deposit_history", "withdrawal_history", "liquidation_history"];
  const counts = await Promise.all(
    tables.map((t) =>
      query<{ count: string }>(`SELECT count(*)::text AS count FROM ${t} WHERE wallet_addr = $1`, [walletAddr])
    ),
  );
  return {
    trades: parseInt(counts[0][0]?.count ?? "0", 10),
    pnl: parseInt(counts[1][0]?.count ?? "0", 10),
    funding: parseInt(counts[2][0]?.count ?? "0", 10),
    deposits: parseInt(counts[3][0]?.count ?? "0", 10),
    withdrawals: parseInt(counts[4][0]?.count ?? "0", 10),
    liquidations: parseInt(counts[5][0]?.count ?? "0", 10),
  };
}
