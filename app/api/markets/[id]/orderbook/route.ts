import { NextResponse } from "next/server";
import { getOrderbook } from "@/lib/n1/client";

/** GET /api/markets/[id]/orderbook — get orderbook for a market */
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

    const orderbook = await getOrderbook({ marketId });
    return NextResponse.json(orderbook);
  } catch (error) {
    console.error("[/api/markets/[id]/orderbook] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch orderbook" },
      { status: 500 }
    );
  }
}
