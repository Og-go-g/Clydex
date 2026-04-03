import { NextRequest, NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { getTradeHistory } from "@/lib/history/queries";

export async function GET(req: NextRequest) {
  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const params = req.nextUrl.searchParams;
  const marketId = params.get("marketId") ? Number(params.get("marketId")) : undefined;
  const limit = params.get("limit") ? Number(params.get("limit")) : undefined;
  const offset = params.get("offset") ? Number(params.get("offset")) : undefined;

  try {
    const result = await getTradeHistory({ walletAddr: address, marketId, limit, offset });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[api/history/trades] error:", error);
    return NextResponse.json({ error: "Failed to fetch trade history" }, { status: 500 });
  }
}
