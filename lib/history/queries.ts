import { query, toCamelRows } from "@/lib/db-history";
import {
  fetchRecentTrades,
  fetchRecentOrders,
  fetchRecentPnl,
  fetchRecentFunding,
} from "./realtime";
import { getLastSyncTime } from "./sync";
import type {
  TradeHistoryRow,
  TradeWithPnlRow,
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
       WHERE "walletAddr" = $1 AND ($2::int IS NULL OR "marketId" = $2)
       ORDER BY "addedAt" DESC LIMIT $3 OFFSET $4`,
      [walletAddr, marketId ?? null, limit, offset],
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM order_history
       WHERE "walletAddr" = $1 AND ($2::int IS NULL OR "marketId" = $2)`,
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
       WHERE "walletAddr" = $1 AND ($2::int IS NULL OR "marketId" = $2)
       ORDER BY "time" DESC LIMIT $3 OFFSET $4`,
      [walletAddr, marketId ?? null, limit, offset],
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM trade_history
       WHERE "walletAddr" = $1 AND ($2::int IS NULL OR "marketId" = $2)`,
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

// ─── Per-trade Closed PnL via SQL (exact NUMERIC arithmetic) ────
//
// Uses a PL/pgSQL function that walks trades chronologically per market,
// tracking position size and weighted-average entry price using
// PostgreSQL's NUMERIC type (no floating-point precision loss).
//
// For each reduce/close trade: PnL = (tradePrice - avgEntry) × closedSize × direction
// Returns only rows where |closedPnl| > 0.0001 (filters float noise).
//
// Fixes: C1 (precision), C2 (negative size guard), H2 (no JS memory load),
//        H3 (numeric tradeId sort), M1 (threshold).

const PNL_QUERY = `
WITH RECURSIVE
numbered AS MATERIALIZED (
  SELECT
    "tradeId",
    side,
    price::numeric AS price,
    size::numeric AS size,
    (CASE WHEN side = 'Long' THEN size ELSE -size END)::numeric AS delta,
    ROW_NUMBER() OVER (ORDER BY "time" ASC, CAST("tradeId" AS bigint) ASC) AS rn
  FROM trade_history
  WHERE "walletAddr" = $1 AND "marketId" = $2
    AND size > 0 AND price > 0
),
tracker AS (
  -- Base case: first trade opens position
  SELECT
    n."tradeId",
    n.delta AS pos_after,
    n.price AS avg_entry,
    0::numeric AS closed_pnl,
    n.rn
  FROM numbered n WHERE n.rn = 1

  UNION ALL

  -- Recursive: process next trade
  SELECT
    n."tradeId",
    -- pos_after: new position after this trade
    CASE
      WHEN t.pos_after = 0 OR SIGN(n.delta) = SIGN(t.pos_after)
        THEN t.pos_after + n.delta
      WHEN ABS(n.delta) > ABS(t.pos_after)
        THEN n.delta + t.pos_after
      ELSE t.pos_after + n.delta
    END,
    -- avg_entry: weighted average entry price
    CASE
      WHEN t.pos_after = 0
        THEN n.price
      WHEN SIGN(n.delta) = SIGN(t.pos_after)
        THEN (t.avg_entry * t.pos_after + n.price * n.delta)
             / (t.pos_after + n.delta)
      WHEN ABS(n.delta) > ABS(t.pos_after)
        THEN n.price
      WHEN t.pos_after + n.delta = 0
        THEN 0::numeric
      ELSE t.avg_entry
    END,
    -- closed_pnl: realized PnL for this trade
    CASE
      WHEN t.pos_after = 0 OR SIGN(n.delta) = SIGN(t.pos_after)
        THEN 0::numeric
      ELSE (n.price - t.avg_entry)
           * LEAST(ABS(n.delta), ABS(t.pos_after))
           * SIGN(t.pos_after)
    END,
    n.rn
  FROM numbered n
  JOIN tracker t ON n.rn = t.rn + 1
)
SELECT "tradeId", closed_pnl::text AS "closedPnl"
FROM tracker
WHERE ABS(closed_pnl) > 0.0001
`;

// ─── Trade History + Closed PnL ──────────────────────────────────

export async function getTradeHistoryWithPnl(params: PaginationParams): Promise<PagedResult<TradeWithPnlRow>> {
  // 1. Fetch paginated trades
  const trades = await getTradeHistory(params);
  if (trades.data.length === 0) {
    return { ...trades, data: [] };
  }

  // 2. Collect unique marketIds from page results
  const marketIds = [...new Set(trades.data.map((t) => t.marketId))];

  // 3. For each market, compute PnL via SQL (exact NUMERIC, no JS memory load)
  const pnlMap = new Map<string, string>();
  const settled = await Promise.allSettled(
    marketIds.map(async (mId) => {
      const rows = await query<{ tradeId: string; closedPnl: string }>(
        PNL_QUERY,
        [params.walletAddr, mId],
      );
      for (const row of rows) {
        pnlMap.set(row.tradeId, row.closedPnl);
      }
    }),
  );

  // Log failures but don't crash — graceful degradation
  for (const r of settled) {
    if (r.status === "rejected") {
      console.error("[getTradeHistoryWithPnl] PnL computation failed for a market:", r.reason);
    }
  }

  // 4. Merge computed PnL into paginated results
  const data: TradeWithPnlRow[] = trades.data.map((trade) => ({
    ...trade,
    closedPnl: pnlMap.get(trade.tradeId) ?? null,
  }));

  return { ...trades, data };
}

// ─── PnL History ──────────────────────────────────────────────────

export async function getPnlHistory(params: PaginationParams): Promise<PagedResult<PnlHistoryRow>> {
  const { walletAddr, marketId, offset = 0 } = params;
  const limit = clampLimit(params.limit);

  const [dataRows, countRows] = await Promise.all([
    query(
      `SELECT * FROM pnl_history
       WHERE "walletAddr" = $1 AND ($2::int IS NULL OR "marketId" = $2)
       ORDER BY "time" DESC LIMIT $3 OFFSET $4`,
      [walletAddr, marketId ?? null, limit, offset],
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pnl_history
       WHERE "walletAddr" = $1 AND ($2::int IS NULL OR "marketId" = $2)`,
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
       WHERE "walletAddr" = $1 AND ($2::int IS NULL OR "marketId" = $2)
       ORDER BY "time" DESC LIMIT $3 OFFSET $4`,
      [walletAddr, marketId ?? null, limit, offset],
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM funding_history
       WHERE "walletAddr" = $1 AND ($2::int IS NULL OR "marketId" = $2)`,
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
      `SELECT * FROM deposit_history WHERE "walletAddr" = $1
       ORDER BY "time" DESC LIMIT $2 OFFSET $3`,
      [walletAddr, limit, offset],
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM deposit_history WHERE "walletAddr" = $1`,
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
      `SELECT * FROM withdrawal_history WHERE "walletAddr" = $1
       ORDER BY "time" DESC LIMIT $2 OFFSET $3`,
      [walletAddr, limit, offset],
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM withdrawal_history WHERE "walletAddr" = $1`,
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
      `SELECT * FROM liquidation_history WHERE "walletAddr" = $1
       ORDER BY "time" DESC LIMIT $2 OFFSET $3`,
      [walletAddr, limit, offset],
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM liquidation_history WHERE "walletAddr" = $1`,
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
      query<{ count: string }>(`SELECT count(*)::text AS count FROM ${t} WHERE "walletAddr" = $1`, [walletAddr])
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

// ═══════════════════════════════════════════════════════════════════
//  REALTIME MERGE — DB + API gap since last sync
// ═══════════════════════════════════════════════════════════════════

interface RealtimeParams extends PaginationParams {
  accountId: number;
}

/**
 * Realtime trade history: insert fresh API data into DB, then paginate from DB.
 * Efficient for any number of trades (no full-table load into memory).
 */
export async function getTradeHistoryRealtime(params: RealtimeParams): Promise<PagedResult<TradeWithPnlRow>> {
  const { walletAddr, accountId, marketId } = params;

  // Mini-sync: fill the gap between last full sync and now.
  // Only runs if user has been synced before (has a cursor).
  // For new users, syncAllHistory handles the full download — mini-sync would
  // be incomplete (capped at 500 records) and cause data gaps.
  const lastSync = await getLastSyncTime(walletAddr);
  if (lastSync) {
    const since = lastSync.toISOString();
    const [freshTrades, freshPnl] = await Promise.all([
      fetchRecentTrades(accountId, walletAddr, since).catch(() => [] as TradeHistoryRow[]),
      fetchRecentPnl(accountId, walletAddr, since).catch(() => [] as PnlHistoryRow[]),
    ]);

    if (freshTrades.length > 0) {
      await insertFreshTrades(freshTrades);
    }
    if (freshPnl.length > 0) {
      await insertFreshPnl(freshPnl);
    }
  }

  // Paginate from DB (includes both old + freshly inserted data)
  return getTradeHistoryWithPnl({ walletAddr, marketId, limit: params.limit, offset: params.offset });
}

/**
 * Realtime order history: mini-sync then paginate from DB.
 */
export async function getOrderHistoryRealtime(params: RealtimeParams): Promise<PagedResult<OrderHistoryRow>> {
  const { walletAddr, accountId, marketId } = params;

  const lastSync = await getLastSyncTime(walletAddr);
  if (lastSync) {
    const since = lastSync.toISOString();
    const freshOrders = await fetchRecentOrders(accountId, walletAddr, since).catch(() => [] as OrderHistoryRow[]);
    if (freshOrders.length > 0) {
      await insertFreshOrders(freshOrders);
    }
  }

  return getOrderHistory({ walletAddr, marketId, limit: params.limit, offset: params.offset });
}

/**
 * Realtime funding history: mini-sync then paginate from DB.
 */
export async function getFundingHistoryRealtime(params: RealtimeParams): Promise<PagedResult<FundingHistoryRow>> {
  const { walletAddr, accountId, marketId } = params;

  const lastSync = await getLastSyncTime(walletAddr);
  if (lastSync) {
    const since = lastSync.toISOString();
    const freshFunding = await fetchRecentFunding(accountId, walletAddr, since).catch(() => [] as FundingHistoryRow[]);
    if (freshFunding.length > 0) {
      await insertFreshFunding(freshFunding);
    }
  }

  return getFundingHistory({ walletAddr, marketId, limit: params.limit, offset: params.offset });
}

// ─── Internal: insert fresh API data into DB (mini-sync) ─────────

import { historyPool, uuid } from "@/lib/db-history";

async function insertFreshTrades(trades: TradeHistoryRow[]): Promise<void> {
  if (trades.length === 0) return;
  await historyPool.query(
    `INSERT INTO trade_history (id, "tradeId", "accountId", "walletAddr", "marketId", symbol, side, size, price, role, fee, "time")
     SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::int[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::text[], $11::numeric[], $12::timestamptz[])
     ON CONFLICT ("tradeId") DO NOTHING`,
    [
      trades.map(() => uuid()),
      trades.map((t) => t.tradeId),
      trades.map((t) => t.accountId),
      trades.map((t) => t.walletAddr),
      trades.map((t) => t.marketId),
      trades.map((t) => t.symbol),
      trades.map((t) => t.side),
      trades.map((t) => t.size),
      trades.map((t) => t.price),
      trades.map((t) => t.role),
      trades.map((t) => t.fee),
      trades.map((t) => new Date(t.time)),
    ],
  );
}

async function insertFreshPnl(pnl: PnlHistoryRow[]): Promise<void> {
  if (pnl.length === 0) return;
  await historyPool.query(
    `INSERT INTO pnl_history (id, "accountId", "walletAddr", "marketId", symbol, "tradingPnl", "settledFundingPnl", "positionSize", "time")
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::int[], $5::text[], $6::numeric[], $7::numeric[], $8::numeric[], $9::timestamptz[])
     ON CONFLICT ("walletAddr", "marketId", "time") DO NOTHING`,
    [
      pnl.map(() => uuid()),
      pnl.map((p) => p.accountId),
      pnl.map((p) => p.walletAddr),
      pnl.map((p) => p.marketId),
      pnl.map((p) => p.symbol),
      pnl.map((p) => p.tradingPnl),
      pnl.map((p) => p.settledFundingPnl),
      pnl.map((p) => p.positionSize),
      pnl.map((p) => new Date(p.time)),
    ],
  );
}

async function insertFreshOrders(orders: OrderHistoryRow[]): Promise<void> {
  if (orders.length === 0) return;
  await historyPool.query(
    `INSERT INTO order_history (id, "orderId", "accountId", "walletAddr", "marketId", symbol, side, "placedSize", "filledSize", "placedPrice", "orderValue", "fillMode", "fillStatus", status, "isReduceOnly", "addedAt", "updatedAt")
     SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::int[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[], $12::text[], $13::text[], $14::text[], $15::boolean[], $16::timestamptz[], $17::timestamptz[])
     ON CONFLICT DO NOTHING`,
    [
      orders.map(() => uuid()),
      orders.map((o) => o.orderId),
      orders.map((o) => o.accountId),
      orders.map((o) => o.walletAddr),
      orders.map((o) => o.marketId),
      orders.map((o) => o.symbol),
      orders.map((o) => o.side),
      orders.map((o) => o.placedSize),
      orders.map((o) => o.filledSize),
      orders.map((o) => o.placedPrice),
      orders.map((o) => o.orderValue),
      orders.map((o) => o.fillMode),
      orders.map((o) => o.fillStatus),
      orders.map((o) => o.status),
      orders.map((o) => o.isReduceOnly),
      orders.map((o) => new Date(o.addedAt)),
      orders.map((o) => new Date(o.updatedAt)),
    ],
  );
}

async function insertFreshFunding(funding: FundingHistoryRow[]): Promise<void> {
  if (funding.length === 0) return;
  await historyPool.query(
    `INSERT INTO funding_history (id, "accountId", "walletAddr", "marketId", symbol, "fundingPnl", "positionSize", "time")
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::int[], $5::text[], $6::numeric[], $7::numeric[], $8::timestamptz[])
     ON CONFLICT ("walletAddr", "marketId", "time") DO NOTHING`,
    [
      funding.map(() => uuid()),
      funding.map((f) => f.accountId),
      funding.map((f) => f.walletAddr),
      funding.map((f) => f.marketId),
      funding.map((f) => f.symbol),
      funding.map((f) => f.fundingPnl),
      funding.map((f) => f.positionSize),
      funding.map((f) => new Date(f.time)),
    ],
  );
}
