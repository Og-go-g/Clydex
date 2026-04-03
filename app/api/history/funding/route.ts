import { NextRequest, NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { getCachedAccountId } from "@/lib/n1/account-cache";
import { getFundingHistoryRealtime, getFundingHistory } from "@/lib/history/queries";

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
    const accountId = await getCachedAccountId(address);
    if (accountId !== null) {
      const result = await getFundingHistoryRealtime({ walletAddr: address, accountId, marketId, limit, offset });
      return NextResponse.json(result);
    }

    const result = await getFundingHistory({ walletAddr: address, marketId, limit, offset });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[api/history/funding] error:", error);
    return NextResponse.json({ error: "Failed to fetch funding history" }, { status: 500 });
  }
}
