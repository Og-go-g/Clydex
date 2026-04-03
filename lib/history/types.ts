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
}

export interface TradeWithPnlRow extends TradeHistoryRow {
  closedPnl: string | null;
}

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

export type HistoryType = "trades" | "orders" | "pnl" | "funding" | "deposits" | "withdrawals" | "liquidations";

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
