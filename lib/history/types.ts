// ─── Row types matching DB columns (camelCase) ───────────────────
// pg returns NUMERIC as string, TIMESTAMPTZ as Date — matches Prisma behavior.

export interface TradeHistoryRow {
  id: string;
  tradeId: string;
  accountId: number;
  walletAddr: string;
  marketId: number;
  symbol: string;
  side: string;
  size: string;
  price: string;
  role: string;
  fee: string;
  time: Date;
  // Parent order id. Nullable because rows synced before 2026-04-19 never
  // populated this column. New sync path writes it — see sync.ts#syncTrades.
  orderId: string | null;
}

export interface TradeWithPnlRow extends TradeHistoryRow {
  closedPnl: string | null;
}

/**
 * Row shape for the "Order History" UI — same schema as the old order_history
 * table for zero UI churn, but synthesized from trade_history rows grouped by
 * orderId. Some fields are best-effort reconstructions (see
 * lib/history/queries.ts#getOrderHistoryFromTrades):
 *   - placedSize / filledSize  → SUM(trade.size) for all fills of this order
 *   - placedPrice              → weighted-average fill price
 *   - orderValue               → SUM(trade.size * trade.price)
 *   - fillMode                 → "PostOnly" iff every fill was role=maker, else "Limit"
 *   - fillStatus / status      → always "Filled" (we can only see filled orders)
 *   - isReduceOnly             → always false (not recoverable from trades)
 *   - updatedAt                → MAX(trade.time), addedAt → MIN(trade.time)
 * Cancelled and unfilled orders are not visible via this view — accepted
 * trade-off for retail UX. See `sql/2026-04-19_orders_from_trades.sql`.
 */
export interface OrderHistoryRow {
  id: string;
  orderId: string;
  accountId: number;
  walletAddr: string;
  marketId: number;
  symbol: string;
  side: string;
  placedSize: string;
  filledSize: string | null;
  placedPrice: string;
  orderValue: string;
  fillMode: string;
  fillStatus: string;
  status: string;
  isReduceOnly: boolean;
  addedAt: Date;
  updatedAt: Date;
}

export interface PnlHistoryRow {
  id: string;
  accountId: number;
  walletAddr: string;
  marketId: number;
  symbol: string;
  tradingPnl: string;
  settledFundingPnl: string;
  positionSize: string;
  time: Date;
}

export interface FundingHistoryRow {
  id: string;
  accountId: number;
  walletAddr: string;
  marketId: number;
  symbol: string;
  fundingPnl: string;
  positionSize: string;
  time: Date;
}

export interface DepositHistoryRow {
  id: string;
  accountId: number;
  walletAddr: string;
  amount: string;
  balance: string;
  tokenId: number;
  time: Date;
}

export interface WithdrawalHistoryRow {
  id: string;
  accountId: number;
  walletAddr: string;
  amount: string;
  balance: string;
  fee: string;
  destPubkey: string;
  time: Date;
}

export interface LiquidationHistoryRow {
  id: string;
  accountId: number;
  walletAddr: string;
  fee: string;
  liquidationKind: string;
  margins: Record<string, unknown> | null;
  time: Date;
}

export interface SyncCursorRow {
  id: string;
  walletAddr: string;
  type: string;
  cursor: string | null;
  lastSyncAt: Date;
}

export interface PagedResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

// ─── Volume Calendar & PnL Totals (from 01.xyz frontend API) ────

export interface VolumeCalendarDay {
  date: string;                // "2026-03-29"
  volume: number;
  makerVolume: number;
  takerVolume: number;
  makerFees: number;
  takerFees: number;
  totalFees: number;
}

export interface VolumeCalendarRow {
  id: string;
  accountId: number;
  walletAddr: string;
  date: string;
  volume: string;
  makerVolume: string;
  takerVolume: string;
  makerFees: string;
  takerFees: string;
  totalFees: string;
}

export interface PnlTotalsData {
  totalPnl: number;
  totalTradingPnl: number;
  totalFundingPnl: number;
  fetchedAt: string;
  accountId: string;
}

export interface PnlTotalsRow {
  id: string;
  accountId: number;
  walletAddr: string;
  totalPnl: string;
  totalTradingPnl: string;
  totalFundingPnl: string;
  fetchedAt: Date;
}

// "orders" removed on 2026-04-19 — derived from trade_history GROUP BY orderId
// via /api/history/orders, no longer synced as a separate type.
export type HistoryType = "trades" | "pnl" | "funding" | "deposits" | "withdrawals" | "liquidations";

export interface SyncResult {
  type: HistoryType;
  inserted: number;
  hasMore: boolean;
  error?: string;
}

export interface SyncProgress {
  total: number;
  completed: number;
  results: SyncResult[];
}
