import { NextRequest, NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { getLiquidationHistory } from "@/lib/history/queries";

export async function GET(req: NextRequest) {
  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const params = req.nextUrl.searchParams;
  const limit = params.get("limit") ? Number(params.get("limit")) : undefined;
  const offset = params.get("offset") ? Number(params.get("offset")) : undefined;

  try {
    const result = await getLiquidationHistory({ walletAddr: address, limit, offset });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[api/history/liquidations] error:", error);
    return NextResponse.json({ error: "Failed to fetch liquidation history" }, { status: 500 });
  }
}
