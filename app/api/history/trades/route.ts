import { NextRequest, NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { getCachedAccountId } from "@/lib/n1/account-cache";
import { getTradeHistoryRealtime, getTradeHistoryWithPnl } from "@/lib/history/queries";
import { safeInt } from "@/lib/history/validate";

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
    // Try realtime merge (DB + API gap) if we have an accountId
    const accountId = await getCachedAccountId(address);
    if (accountId !== null) {
      const result = await getTradeHistoryRealtime({ walletAddr: address, accountId, marketId, limit, offset });
      return NextResponse.json(result);
    }

    // Fallback: DB only
    const result = await getTradeHistoryWithPnl({ walletAddr: address, marketId, limit, offset });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[api/history/trades] error:", error);
    return NextResponse.json({ error: "Failed to fetch trade history" }, { status: 500 });
  }
}
