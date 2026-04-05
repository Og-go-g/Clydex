import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";
import { getMarketsInfo, getMarketStats } from "@/lib/n1/client";

/**
 * GET /api/cron/collect-prices
 *
 * Cron job (every 15 min) that collects mark prices for all markets from 01 Exchange
 * and stores them in PriceHistory for chart data.
 *
 * Protected by CRON_SECRET bearer token.
 * Called by crontab every 15 minutes.
 */
export async function GET(request: NextRequest) {
  // Auth: always require cron secret
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret}`;
  // Timing-safe comparison — pad both to the SAME length (max of the two)
  const maxLen = Math.max(auth.length, expected.length);
  const authBuf = Buffer.from(auth.padEnd(maxLen));
  const expectedBuf = Buffer.from(expected.padEnd(maxLen));
  if (auth.length !== expected.length || !timingSafeEqual(authBuf, expectedBuf)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // 1. Get all markets
    const info = await getMarketsInfo();
    const markets = info.markets;

    if (!markets?.length) {
      return NextResponse.json({ error: "No markets found" }, { status: 500 });
    }

    // 2. Fetch stats for all markets in parallel
    const statsResults = await Promise.allSettled(
      markets.map((m) => getMarketStats(m.marketId))
    );

    // 3. Collect prices — truncate timestamp to nearest 15-min interval
    const now = new Date();
    const minutes = Math.floor(now.getMinutes() / 15) * 15;
    const intervalStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      now.getHours(),
      minutes,
      0,
      0
    );

    const records: Array<{ marketId: number; time: Date; price: number }> = [];

    for (let i = 0; i < markets.length; i++) {
      const result = statsResults[i];
      if (result.status !== "fulfilled") continue;

      const stats = result.value;
      const markPrice =
        stats.perpStats?.mark_price ?? stats.indexPrice ?? null;
      if (markPrice == null || markPrice <= 0) continue;

      records.push({
        marketId: markets[i].marketId,
        time: intervalStart,
        price: markPrice,
      });
    }

    if (records.length === 0) {
      return NextResponse.json({ collected: 0, error: "No valid prices" });
    }

    // 4. Batch upsert — skip duplicates for idempotency
    const result = await prisma.priceHistory.createMany({
      data: records,
      skipDuplicates: true,
    });

    return NextResponse.json({
      collected: result.count,
      total: records.length,
      time: intervalStart.toISOString(),
    });
  } catch (error) {
    console.error("[cron/collect-prices] Error:", error);
    return NextResponse.json(
      { error: "Failed to collect prices" },
      { status: 500 }
    );
  }
}
