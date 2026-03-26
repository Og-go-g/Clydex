import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getAuthAddress } from "@/lib/auth/session";
import { getUser, getAccount, getAccountOrders, getAccountTriggers, getMarketsInfo, getMarketStats } from "@/lib/n1/client";

// ─── Server-side caches ─────────────────────────────────────────

// Market info cache (refreshes every 60s — market list rarely changes)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedMarketsInfo: any = null;
let marketsCacheTime = 0;
const MARKETS_CACHE_TTL = 60_000;

async function getCachedMarketsInfo() {
  const now = Date.now();
  if (cachedMarketsInfo && now - marketsCacheTime < MARKETS_CACHE_TTL) {
    return cachedMarketsInfo;
  }
  cachedMarketsInfo = await getMarketsInfo();
  marketsCacheTime = now;
  return cachedMarketsInfo;
}

// User → accountId cache (refreshes every 5 min — account IDs don't change)
const userCache = new Map<string, { accountId: number; time: number }>();
const USER_CACHE_TTL = 300_000;
const MAX_USER_CACHE_SIZE = 1_000;

async function getCachedAccountId(address: string): Promise<number | null> {
  const now = Date.now();
  const cached = userCache.get(address);
  if (cached && now - cached.time < USER_CACHE_TTL) {
    return cached.accountId;
  }
  const user = await getUser(address);
  if (!user || !user.accountIds?.length) return null;
  const accountId = user.accountIds[0];

  // Evict oldest entries if cache is at capacity
  while (userCache.size >= MAX_USER_CACHE_SIZE) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of userCache) {
      if (entry.time < oldestTime) {
        oldestTime = entry.time;
        oldestKey = key;
      }
    }
    if (oldestKey) userCache.delete(oldestKey);
    else break;
  }

  userCache.set(address, { accountId, time: now });
  return accountId;
}

/** GET /api/account — get authenticated user's account info */
export async function GET() {
  try {
    const address = await getAuthAddress();
    if (!address) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Look up the user's N1 account (cached — account IDs don't change)
    const accountId = await getCachedAccountId(address);
    if (accountId === null) {
      return NextResponse.json({
        exists: false,
        message: "No 01 Exchange account found. Deposit USDC to create one.",
      }, {
        headers: { "Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache" },
      });
    }

    // Fetch account data + triggers in parallel; market info is cached (rarely changes)
    const [account, triggers, marketsInfo] = await Promise.all([
      getAccount(accountId),
      getAccountTriggers(accountId),
      getCachedMarketsInfo(),
    ]);

    console.log("[/api/account] accountId:", accountId, "triggers count:", (triggers ?? []).length, "raw:", JSON.stringify((triggers ?? []).slice(0, 2)));

    // Build market lookups from live API
    const marketSymbols: Record<number, string> = {};
    const marketImfs: Record<number, number> = {};
    const marketMmfs: Record<number, number> = {};
    const marketCmfs: Record<number, number> = {};
    const marketMaxLev: Record<number, number> = {};
    const marketPriceDecimals: Record<number, number> = {};
    for (const m of marketsInfo.markets) {
      marketSymbols[m.marketId] = m.symbol;
      // SDK per-market imf is half the actual trading IMF (empirically verified)
      marketImfs[m.marketId] = m.imf * 2;
      // SDK per-market mmf — exact maintenance margin fraction from API
      marketMmfs[m.marketId] = m.mmf;
      // cmf — closing/cancel margin fraction (used for liquidation price calculation)
      // SDK cmf is halved like imf — multiply by 2 for actual value
      marketCmfs[m.marketId] = (m.cmf ?? m.mmf) * 2;
      // Max leverage from per-market IMF (NOT doubled — per-market imf is correct)
      marketMaxLev[m.marketId] = Math.max(1, Math.floor(1 / m.imf));
      // priceDecimals — needed to descale trigger prices from API (returned as scaled integers)
      marketPriceDecimals[m.marketId] = (m as Record<string, unknown>).priceDecimals as number ?? 4;
    }

    // Open orders from account state, enriched with timestamps from order history
    const rawOrders = (account.orders ?? []) as Array<{
      orderId: number; marketId: number; side: string;
      size: number; price: number; originalOrderSize?: number;
    }>;

    // Fetch order history to get addedAt timestamps (parallel, non-blocking)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let orderTimestamps: Record<number, string> = {};
    if (rawOrders.length > 0) {
      try {
        const orderHistory = await getAccountOrders(accountId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items = (orderHistory as any)?.items ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const oh of items as any[]) {
          if (oh.orderId != null && oh.addedAt) {
            orderTimestamps[oh.orderId] = oh.addedAt;
          }
        }
      } catch { /* non-critical — timestamps are a bonus, not required */ }
    }

    const openOrders = rawOrders.map(o => ({
      orderId: o.orderId,
      marketId: o.marketId,
      symbol: marketSymbols[o.marketId] ?? `Market-${o.marketId}`,
      side: o.side,
      size: o.size,
      price: o.price,
      originalOrderSize: o.originalOrderSize,
      marketMmf: marketMmfs[o.marketId] ?? 0.025,
      // Real placement time from order history (RFC3339 string or null)
      placedAt: orderTimestamps[o.orderId] ?? null,
    }));

    // Fetch live mark prices for markets with open positions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activeMarketIds = (account.positions ?? [])
      .filter((p: any) => p.perp && p.perp.baseSize !== 0)
      .map((p: any) => p.marketId as number);

    const markPrices: Record<number, number> = {};
    if (activeMarketIds.length > 0) {
      const statsResults = await Promise.allSettled(
        activeMarketIds.map((id) => getMarketStats(id))
      );
      activeMarketIds.forEach((id, i) => {
        const result = statsResults[i];
        if (result.status === "fulfilled") {
          markPrices[id] = result.value.perpStats?.mark_price ?? result.value.indexPrice ?? 0;
        }
      });
    }

    // Normalize positions with market data and live mark prices
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const positions = (account.positions ?? []).map((p: any) => ({
      marketId: p.marketId,
      symbol: marketSymbols[p.marketId] ?? `Market-${p.marketId}`,
      openOrders: p.openOrders,
      perp: p.perp,
      marketImf: marketImfs[p.marketId] ?? 0.10,
      marketMmf: marketMmfs[p.marketId] ?? 0.025,
      marketCmf: marketCmfs[p.marketId] ?? 0.03,
      maxLeverage: marketMaxLev[p.marketId] ?? 1,
      markPrice: markPrices[p.marketId] ?? null,
    }));

    return NextResponse.json({
      exists: true,
      accountId,
      positions,
      balances: account.balances ?? [],
      margins: account.margins,
      openOrders,
      // Descale trigger prices — API returns scaled integers (e.g., 9500 for $0.95 with priceDecimals=4)
      // Always divide by 10^priceDecimals — no heuristics, no guessing
      triggers: (triggers ?? []).map((t: Record<string, unknown>) => {
        const mktId = t.marketId as number;
        const pd = marketPriceDecimals[mktId] ?? 4;
        const scale = Math.pow(10, pd);
        return {
          ...t,
          triggerPrice: typeof t.triggerPrice === "number" ? t.triggerPrice / scale : t.triggerPrice,
          ...(typeof t.limitPrice === "number" ? { limitPrice: t.limitPrice / scale } : {}),
          ...(typeof t.price === "number" ? { price: t.price / scale } : {}),
        };
      }),
      marketSymbols,
    }, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache" },
    });
  } catch (error) {
    Sentry.captureException(error, { tags: { endpoint: "account" } });
    return NextResponse.json(
      { error: "Failed to fetch account" },
      { status: 500 }
    );
  }
}
