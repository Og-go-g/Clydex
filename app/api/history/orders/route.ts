import { NextRequest, NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { getOrderHistory } from "@/lib/history/queries";
import { safeInt } from "@/lib/history/validate";

/**
 * GET /api/history/orders — the authenticated user's filled orders.
 *
 * As of 2026-04-19 the response is derived from trade_history grouped by
 * orderId (see getOrderHistory in lib/history/queries.ts). There's no
 * standalone order_history table anymore and no separate mini-sync —
 * whenever the Trade tab syncs fresh trades, those same rows feed this
 * view through their orderId column.
 */
export async function GET(req: NextRequest) {
  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const params = req.nextUrl.searchParams;
  const marketId = safeInt(params.get("marketId"));
  const limit = safeInt(params.get("limit"));
  const offset = safeInt(params.get("offset"));

  try {
    const result = await getOrderHistory({ walletAddr: address, marketId, limit, offset });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[api/history/orders] error:", error);
    return NextResponse.json({ error: "Failed to fetch order history" }, { status: 500 });
  }
}
