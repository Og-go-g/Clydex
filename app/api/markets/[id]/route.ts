import { NextResponse } from "next/server";
import { getMarketStats } from "@/lib/n1/client";

// Per-market stats cache with stale fallback
const statsCache = new Map<number, { data: unknown; time: number }>();
const STATS_TTL = 15_000; // 15s fresh
const STATS_STALE = 120_000; // 2min stale fallback

/** GET /api/markets/[id] — get single market stats */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const marketId = parseInt(id, 10);
  if (isNaN(marketId) || marketId < 0) {
    return NextResponse.json({ error: "Invalid market ID" }, { status: 400 });
  }

  const now = Date.now();
  const cached = statsCache.get(marketId);

  // Return fresh cache
  if (cached && now - cached.time < STATS_TTL) {
    return NextResponse.json(cached.data);
  }

  try {
    const stats = await getMarketStats(marketId);
    statsCache.set(marketId, { data: stats, time: now });
    return NextResponse.json(stats);
  } catch (error) {
    // Return stale cache if available
    if (cached && now - cached.time < STATS_STALE) {
      return NextResponse.json(cached.data);
    }
    console.error("[/api/markets/[id]] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch market stats" },
      { status: 500 }
    );
  }
}
