import { NextResponse } from "next/server";
import { getOrderbook } from "@/lib/n1/client";

// Per-market orderbook cache with stale fallback
const obCache = new Map<number, { data: unknown; time: number }>();
const OB_TTL = 3_000; // 3s fresh — bid-ask ratio needs low latency
const OB_STALE = 60_000; // 60s stale fallback

/** GET /api/markets/[id]/orderbook — get orderbook for a market */
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
  const cached = obCache.get(marketId);

  // Return fresh cache
  if (cached && now - cached.time < OB_TTL) {
    return NextResponse.json(cached.data);
  }

  try {
    const orderbook = await getOrderbook({ marketId });
    obCache.set(marketId, { data: orderbook, time: now });

    // Evict stale entries if cache grows too large
    if (obCache.size > 50) {
      for (const [key, val] of obCache) {
        if (now - val.time > OB_STALE) obCache.delete(key);
      }
    }

    return NextResponse.json(orderbook);
  } catch (error) {
    // Return stale cache if available
    if (cached && now - cached.time < OB_STALE) {
      return NextResponse.json(cached.data);
    }
    console.error("[/api/markets/[id]/orderbook] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch orderbook" },
      { status: 500 }
    );
  }
}
