/**
 * Realtime data fetcher — pulls fresh data from 01 Exchange API
 * for the gap between the last DB sync and now.
 *
 * Used when a user opens History: DB data + realtime gap = complete view.
 */

import { N1_MAINNET_URL } from "@/lib/n1/constants";
import { ensureMarketCache, getCachedMarkets } from "@/lib/n1/constants";
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
const FRONTEND_API = "https://01.xyz/api";
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

async function fetchAll<T>(baseUrl: string, maxPages = 20): Promise<T[]> {
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

// ─── 01.xyz Frontend API ─────────────────────────────────────────
// These endpoints are behind Vercel WAF — use browser-like headers.

const BROWSER_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Referer: "https://01.xyz/",
  Origin: "https://01.xyz",
};

export async function fetchVolumeCalendar(
  accountId: number,
): Promise<Record<string, VolumeCalendarDay>> {
  try {
    const res = await fetch(`${FRONTEND_API}/volume-calendar/${accountId}`, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return {};
    const body = await res.json();
    const days: Record<string, VolumeCalendarDay> = {};
    for (const [date, data] of Object.entries(body.days ?? {})) {
      const d = data as Record<string, number>;
      days[date] = {
        date,
        volume: d.volume ?? 0,
        makerVolume: d.makerVolume ?? 0,
        takerVolume: d.takerVolume ?? 0,
        makerFees: d.makerFees ?? 0,
        takerFees: d.takerFees ?? 0,
        totalFees: d.totalFees ?? 0,
      };
    }
    return days;
  } catch (err) {
    console.error(`[realtime] volume-calendar/${accountId} failed:`, err);
    return {};
  }
}

export async function fetchPnlTotals(
  accountId: number,
): Promise<PnlTotalsData | null> {
  try {
    const res = await fetch(`${FRONTEND_API}/pnl-totals/${accountId}`, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as PnlTotalsData;
  } catch (err) {
    console.error(`[realtime] pnl-totals/${accountId} failed:`, err);
    return null;
  }
}
