/**
 * Realtime data fetcher — pulls fresh data from 01 Exchange API
 * for the gap between the last DB sync and now.
 *
 * Used when a user opens History: DB data + realtime gap = complete view.
 */

import { N1_MAINNET_URL } from "@/lib/n1/constants";
import { ensureMarketCache, getCachedMarkets } from "@/lib/n1/constants";
import { query } from "@/lib/db-history";
import type {
  TradeHistoryRow,
  OrderHistoryRow,
  PnlHistoryRow,
  FundingHistoryRow,
  VolumeCalendarDay,
  PnlTotalsData,
} from "./types";

// ─── Constants ───────────────────────────────────────────────────

const SDK_API = N1_MAINNET_URL;
const PAGE_SIZE = 50;

// ─── SDK API helpers ─────────────────────────────────────────────

interface PaginatedResponse<T> {
  data: T[];
  cursor?: string;
  hasMore: boolean;
}

async function fetchPage<T>(url: string): Promise<PaginatedResponse<T>> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`01 API ${res.status} for ${url}`);
  const body = await res.json();

  if (Array.isArray(body)) {
    return { data: body as T[], hasMore: body.length >= PAGE_SIZE, cursor: undefined };
  }
  const data = (body.items ?? body.data ?? body.results ?? []) as T[];
  const cursor = body.nextStartInclusive ?? body.cursor ?? body.nextCursor ?? undefined;
  return { data, cursor, hasMore: data.length >= PAGE_SIZE && cursor != null };
}

async function fetchAll<T>(baseUrl: string, maxPages = 10): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  let hasMore = true;
  let pages = 0;

  while (hasMore && pages < maxPages) {
    let url = baseUrl + (baseUrl.includes("?") ? "&" : "?") + `pageSize=${PAGE_SIZE}`;
    if (cursor) url += `&startInclusive=${encodeURIComponent(cursor)}`;

    const page = await fetchPage<T>(url);
    if (page.data.length === 0) break;

    all.push(...page.data);
    cursor = page.cursor;
    hasMore = page.hasMore && !!cursor;
    pages++;
  }
  return all;
}

// ─── Market Symbol Resolver ──────────────────────────────────────

function marketSymbol(marketId: number): string {
  const markets = getCachedMarkets();
  const m = markets.find((mk) => mk.id === marketId);
  return m?.symbol ?? `MARKET-${marketId}`;
}

// ─── SDK API Types (raw from 01 Exchange) ────────────────────────

interface ApiTrade {
  tradeId: number;
  price: number;
  baseSize: number;
  takerSide: string;
  time: string;
  marketId: number;
  takerId: number;
  makerId: number;
  actionId: number;
  orderId: number;
}

interface ApiOrder {
  orderId: number;
  traderId: number;
  marketId: number;
  side: string;
  placedSize: number;
  filledSize: number | null;
  placedPrice: number;
  fillMode: string;
  finalizationReason: string;
  isReduceOnly: boolean;
  marketSymbol: string;
  addedAt: string;
  updatedAt: string;
}

interface ApiPnl {
  tradingPnl: number;
  settledFundingPnl: number;
  positionSize: number;
  marketId: number;
  time: string;
  actionId: number;
}

interface ApiFunding {
  fundingPnl: number;
  positionSize: number;
  marketId: number;
  time: string;
  actionId: number;
}

// ─── Fetch Recent Data (SDK API, since last sync) ────────────────

export async function fetchRecentTrades(
  accountId: number,
  walletAddr: string,
  since: string,
): Promise<TradeHistoryRow[]> {
  await ensureMarketCache();

  const results: TradeHistoryRow[] = [];

  for (const role of ["taker", "maker"] as const) {
    const param = role === "taker" ? "takerId" : "makerId";
    const trades = await fetchAll<ApiTrade>(
      `${SDK_API}/trades?${param}=${accountId}&since=${encodeURIComponent(since)}`,
    );

    for (const t of trades) {
      results.push({
        id: `rt-${t.tradeId}-${role}`,
        tradeId: String(t.tradeId),
        accountId,
        walletAddr,
        marketId: t.marketId,
        symbol: marketSymbol(t.marketId),
        side: (role === "taker")
          ? (t.takerSide === "bid" ? "Long" : "Short")
          : (t.takerSide === "bid" ? "Short" : "Long"),
        size: String(t.baseSize ?? 0),
        price: String(t.price ?? 0),
        role,
        fee: "0",
        time: new Date(t.time),
      });
    }
  }

  return results;
}

export async function fetchRecentOrders(
  accountId: number,
  walletAddr: string,
  since: string,
): Promise<OrderHistoryRow[]> {
  await ensureMarketCache();

  const orders = await fetchAll<ApiOrder>(
    `${SDK_API}/account/${accountId}/orders?since=${encodeURIComponent(since)}`,
  );

  return orders.map((o) => ({
    id: `ro-${o.orderId}`,
    orderId: String(o.orderId),
    accountId,
    walletAddr,
    marketId: o.marketId,
    symbol: o.marketSymbol ?? marketSymbol(o.marketId),
    side: o.side === "bid" ? "Long" : "Short",
    placedSize: String(o.placedSize ?? 0),
    filledSize: o.filledSize != null ? String(o.filledSize) : null,
    placedPrice: String(o.placedPrice ?? 0),
    orderValue: String((o.placedPrice ?? 0) * (o.placedSize ?? 0)),
    fillMode: o.fillMode ?? "unknown",
    fillStatus: o.filledSize != null && o.filledSize > 0 ? "Filled" : "Unfilled",
    status: o.finalizationReason ?? "unknown",
    isReduceOnly: o.isReduceOnly ?? false,
    addedAt: new Date(o.addedAt),
    updatedAt: new Date(o.updatedAt),
  }));
}

export async function fetchRecentPnl(
  accountId: number,
  walletAddr: string,
  since: string,
): Promise<PnlHistoryRow[]> {
  await ensureMarketCache();

  const items = await fetchAll<ApiPnl>(
    `${SDK_API}/account/${accountId}/history/pnl?since=${encodeURIComponent(since)}`,
  );

  return items.map((p) => ({
    id: `rp-${p.marketId}-${p.time}`,
    accountId,
    walletAddr,
    marketId: p.marketId,
    symbol: marketSymbol(p.marketId),
    tradingPnl: String(p.tradingPnl ?? 0),
    settledFundingPnl: String(p.settledFundingPnl ?? 0),
    positionSize: String(p.positionSize ?? 0),
    time: new Date(p.time),
  }));
}

export async function fetchRecentFunding(
  accountId: number,
  walletAddr: string,
  since: string,
): Promise<FundingHistoryRow[]> {
  await ensureMarketCache();

  const items = await fetchAll<ApiFunding>(
    `${SDK_API}/account/${accountId}/history/funding?since=${encodeURIComponent(since)}`,
  );

  return items.map((f) => ({
    id: `rf-${f.marketId}-${f.time}`,
    accountId,
    walletAddr,
    marketId: f.marketId,
    symbol: marketSymbol(f.marketId),
    fundingPnl: String(f.fundingPnl ?? 0),
    positionSize: String(f.positionSize ?? 0),
    time: new Date(f.time),
  }));
}

// ─── Aggregated views (from local pnl_totals / volume_calendar) ──
//
// Formerly fetched directly from the 01.xyz frontend API, now read from
// the tables the pg-boss worker rebuilds locally. The data you get here
// is only as fresh as the last tier refresh (Tier 1 = every 30 min).
// Callers that need absolute freshness should enqueue an on-demand-refresh
// job and retry in a few seconds.

export async function fetchVolumeCalendar(
  accountId: number,
): Promise<Record<string, VolumeCalendarDay>> {
  const rows = await query<{
    date: string;
    volume: string;
    makerVolume: string;
    takerVolume: string;
    makerFees: string;
    takerFees: string;
    totalFees: string;
  }>(
    `SELECT date,
            volume::text,
            "makerVolume"::text,
            "takerVolume"::text,
            "makerFees"::text,
            "takerFees"::text,
            "totalFees"::text
     FROM volume_calendar
     WHERE "accountId" = $1
     ORDER BY date`,
    [accountId],
  );

  const days: Record<string, VolumeCalendarDay> = {};
  for (const r of rows) {
    days[r.date] = {
      date: r.date,
      volume: parseFloat(r.volume) || 0,
      makerVolume: parseFloat(r.makerVolume) || 0,
      takerVolume: parseFloat(r.takerVolume) || 0,
      makerFees: parseFloat(r.makerFees) || 0,
      takerFees: parseFloat(r.takerFees) || 0,
      totalFees: parseFloat(r.totalFees) || 0,
    };
  }
  return days;
}

export async function fetchPnlTotals(
  accountId: number,
): Promise<PnlTotalsData | null> {
  const rows = await query<{
    totalPnl: string;
    totalTradingPnl: string;
    totalFundingPnl: string;
    fetchedAt: Date;
  }>(
    `SELECT "totalPnl"::text,
            "totalTradingPnl"::text,
            "totalFundingPnl"::text,
            "fetchedAt"
     FROM pnl_totals
     WHERE "accountId" = $1
     LIMIT 1`,
    [accountId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    totalPnl: parseFloat(r.totalPnl) || 0,
    totalTradingPnl: parseFloat(r.totalTradingPnl) || 0,
    totalFundingPnl: parseFloat(r.totalFundingPnl) || 0,
    fetchedAt: r.fetchedAt.toISOString(),
    accountId: String(accountId),
  };
}
