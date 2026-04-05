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

// ─── Trade History + Closed PnL ──────────────────────────────────

export async function getTradeHistoryWithPnl(params: PaginationParams): Promise<PagedResult<TradeWithPnlRow>> {
  // 1. Fetch trades normally
  const trades = await getTradeHistory(params);
  if (trades.data.length === 0) {
    return { ...trades, data: [] };
  }

  // 2. For each trade, find the closest pnl_history snapshot (same market, closest time ≤ trade time).
  //    The tradingPnl field is cumulative realized PnL, so the change between two consecutive
  //    snapshots = the realized PnL from that position change.
  const { walletAddr } = params;

  // Collect unique (marketId, time) pairs from trades
  const marketIds = [...new Set(trades.data.map((t) => t.marketId))];

  // Fetch ALL pnl snapshots for these markets for this wallet (they're sparse — ~10-50 per market)
  const pnlRows = marketIds.length > 0
    ? await query(
        `SELECT "marketId", "time", "tradingPnl" FROM pnl_history
         WHERE "walletAddr" = $1 AND "marketId" = ANY($2::int[])
         ORDER BY "marketId", "time"`,
        [walletAddr, marketIds],
      )
    : [];
  const pnlData = toCamelRows<{ marketId: number; time: Date; tradingPnl: string }>(pnlRows);

  // Group PnL by market, sorted by time ascending
  const pnlByMarket = new Map<number, { time: number; tradingPnl: number }[]>();
  for (const p of pnlData) {
    const arr = pnlByMarket.get(p.marketId) ?? [];
    arr.push({ time: new Date(p.time).getTime(), tradingPnl: parseFloat(p.tradingPnl) });
    pnlByMarket.set(p.marketId, arr);
  }

  // 3. Map PnL snapshots → trades (not trades → snapshots).
  //    Each pnl_history entry = one position close event with a specific time.
  //    We find the single closest trade for each PnL snapshot (within ±5s).
  //    This guarantees 1:1 mapping — no double-counting.

  // Build a lookup: for each PnL snapshot, compute its delta and find matching trade
  const pnlForTrade = new Map<string, number>(); // tradeId → closedPnl

  for (const [marketId, snapshots] of pnlByMarket) {
    const marketTrades = trades.data
      .filter(t => t.marketId === marketId)
      .map(t => ({ id: t.tradeId ?? t.id, time: new Date(t.time).getTime() }));

    if (marketTrades.length === 0) continue;

    const usedTradeIds = new Set<string>();

    for (let i = 0; i < snapshots.length; i++) {
      const snapTime = snapshots[i].time;
      const curr = snapshots[i].tradingPnl;
      const prev = i > 0 ? snapshots[i - 1].tradingPnl : 0;
      const delta = curr - prev;

      if (Math.abs(delta) < 0.000001) continue; // no PnL change

      // Find the closest trade to this snapshot (within ±5s), not yet consumed
      let bestTrade: string | null = null;
      let bestDist = Infinity;
      for (const t of marketTrades) {
        if (usedTradeIds.has(t.id)) continue;
        const dist = Math.abs(t.time - snapTime);
        if (dist < bestDist && dist <= 5_000) {
          bestDist = dist;
          bestTrade = t.id;
        }
      }

      if (bestTrade) {
        pnlForTrade.set(bestTrade, delta);
        usedTradeIds.add(bestTrade);
      }
    }
  }

  const data: TradeWithPnlRow[] = trades.data.map((trade) => {
    const tradeKey = trade.tradeId ?? trade.id;
    const pnl = pnlForTrade.get(tradeKey);
    return {
      ...trade,
      closedPnl: pnl != null ? pnl.toFixed(6) : null,
    };
  });

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

  // 1. Mini-sync: fetch fresh trades from API since last sync → insert into DB
  const lastSync = await getLastSyncTime(walletAddr);
  const since = lastSync?.toISOString() ?? new Date(Date.now() - 7 * 86400_000).toISOString();

  const [freshTrades, freshPnl] = await Promise.all([
    fetchRecentTrades(accountId, walletAddr, since).catch(() => [] as TradeHistoryRow[]),
    fetchRecentPnl(accountId, walletAddr, since).catch(() => [] as PnlHistoryRow[]),
  ]);

  // Insert fresh trades into DB (ON CONFLICT DO NOTHING for dedup)
  if (freshTrades.length > 0) {
    await insertFreshTrades(freshTrades);
  }
  if (freshPnl.length > 0) {
    await insertFreshPnl(freshPnl);
  }

  // 2. Now paginate from DB (includes both old + freshly inserted data)
  return getTradeHistoryWithPnl({ walletAddr, marketId, limit: params.limit, offset: params.offset });
}

/**
 * Realtime order history: mini-sync then paginate from DB.
 */
export async function getOrderHistoryRealtime(params: RealtimeParams): Promise<PagedResult<OrderHistoryRow>> {
  const { walletAddr, accountId, marketId } = params;

  const lastSync = await getLastSyncTime(walletAddr);
  const since = lastSync?.toISOString() ?? new Date(Date.now() - 7 * 86400_000).toISOString();

  const freshOrders = await fetchRecentOrders(accountId, walletAddr, since).catch(() => [] as OrderHistoryRow[]);
  if (freshOrders.length > 0) {
    await insertFreshOrders(freshOrders);
  }

  return getOrderHistory({ walletAddr, marketId, limit: params.limit, offset: params.offset });
}

/**
 * Realtime funding history: mini-sync then paginate from DB.
 */
export async function getFundingHistoryRealtime(params: RealtimeParams): Promise<PagedResult<FundingHistoryRow>> {
  const { walletAddr, accountId, marketId } = params;

  const lastSync = await getLastSyncTime(walletAddr);
  const since = lastSync?.toISOString() ?? new Date(Date.now() - 7 * 86400_000).toISOString();

  const freshFunding = await fetchRecentFunding(accountId, walletAddr, since).catch(() => [] as FundingHistoryRow[]);
  if (freshFunding.length > 0) {
    await insertFreshFunding(freshFunding);
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
     ON CONFLICT ("orderId") DO NOTHING`,
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
