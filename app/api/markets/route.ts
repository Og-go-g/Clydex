import { NextResponse } from "next/server";
import { getMarketsInfo } from "@/lib/n1/client";
import { getAllMarkets } from "@/lib/n1/constants";

/** GET /api/markets — list all markets with stats */
export async function GET() {
  try {
    const [info, localMarkets] = await Promise.all([
      getMarketsInfo(),
      Promise.resolve(getAllMarkets()),
    ]);

    // Merge API market data with our local tier/leverage info
    const markets = info.markets.map((apiMarket) => {
      const local = localMarkets.find((m) => m.id === apiMarket.marketId);
      return {
        id: apiMarket.marketId,
        symbol: apiMarket.symbol,
        tier: local?.tier ?? 0,
        maxLeverage: local?.maxLeverage ?? 1,
        imf: apiMarket.imf,
        mmf: apiMarket.mmf,
        priceDecimals: apiMarket.priceDecimals,
        sizeDecimals: apiMarket.sizeDecimals,
      };
    });

    return NextResponse.json({
      markets,
      collateralToken: info.tokens?.[0] ?? null,
    });
  } catch (error) {
    console.error("[/api/markets] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch markets" },
      { status: 500 }
    );
  }
}
