import { NextResponse } from "next/server";
import { getMarketStats } from "@/lib/n1/client";

/** GET /api/markets/[id] — get single market stats */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const marketId = parseInt(id, 10);
    if (isNaN(marketId) || marketId < 0) {
      return NextResponse.json({ error: "Invalid market ID" }, { status: 400 });
    }

    const stats = await getMarketStats(marketId);
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[/api/markets/[id]] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch market stats" },
      { status: 500 }
    );
  }
}
