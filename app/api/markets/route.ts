import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getMarketsInfo, getMarketStats } from "@/lib/n1/client";
import { tierFromImf, setMarketCache } from "@/lib/n1/constants";
import type { N1Market } from "@/lib/n1/types";

// Server-side response cache — stale-while-revalidate pattern
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedResponse: any = null;
let responseCacheTime = 0;
const RESPONSE_CACHE_TTL = 60_000; // 60s fresh
const STALE_TTL = 300_000; // 5min stale fallback

/** GET /api/markets — list all markets with stats (single request) */
export async function GET() {
  try {
    // Return cached response if fresh (prevents upstream API amplification)
    const now = Date.now();
    if (cachedResponse && now - responseCacheTime < RESPONSE_CACHE_TTL) {
      return NextResponse.json(cachedResponse);
    }
    const info = await getMarketsInfo();

    // Build market list from live API data — no hardcoded IDs
    const marketsBase = info.markets.map((apiMarket) => {
      const { tier, maxLeverage } = tierFromImf(apiMarket.imf);
      const symbol = apiMarket.symbol;
      const baseAsset = symbol.replace(/USD$/, "");
      return {
        id: apiMarket.marketId,
        symbol,
        baseAsset,
        tier,
        maxLeverage,
        initialMarginFraction: apiMarket.imf,
        imf: apiMarket.imf,
        mmf: apiMarket.mmf,
        priceDecimals: apiMarket.priceDecimals,
        sizeDecimals: apiMarket.sizeDecimals,
      };
    });

    // Populate the in-memory cache so resolveMarket() and other helpers work
    setMarketCache(marketsBase.map((m): N1Market => ({
      id: m.id,
      symbol: m.symbol,
      baseAsset: m.baseAsset,
      tier: m.tier,
      initialMarginFraction: m.initialMarginFraction,
      maxLeverage: m.maxLeverage,
    })));

    // Batch-fetch stats for all markets server-side (parallel, with individual error tolerance)
    const statsResults = await Promise.allSettled(
      marketsBase.map((m) => getMarketStats(m.id))
    );

    const markets = marketsBase.map((m, i) => {
      const result = statsResults[i];
      if (result.status !== "fulfilled") {
        return { ...m, markPrice: null, change24h: null, volume24h: null, fundingRate: null };
      }
      const stats = result.value;
      const markPrice = stats.perpStats?.mark_price ?? stats.indexPrice ?? null;
      const indexPrice = stats.indexPrice ?? null;
      const close = stats.close24h;
      const prev = stats.prevClose24h;
      const change24h = close && prev ? ((close - prev) / prev) * 100 : null;
      const volume24h = stats.volumeQuote24h ?? null;
      const fundingRate = stats.perpStats?.funding_rate ?? null;
      return { ...m, markPrice, indexPrice, change24h, volume24h, fundingRate };
    });

    const responseData = {
      markets,
      collateralToken: info.tokens?.[0] ?? null,
    };
    cachedResponse = responseData;
    responseCacheTime = Date.now();

    return NextResponse.json(responseData);
  } catch (error) {
    Sentry.captureException(error, { tags: { endpoint: "markets" } });
    // Return stale cache if available (better than error)
    if (cachedResponse && Date.now() - responseCacheTime < STALE_TTL) {
      return NextResponse.json(cachedResponse);
    }
    return NextResponse.json(
      { error: "Failed to fetch markets" },
      { status: 500 }
    );
  }
}
