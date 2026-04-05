import { NextRequest, NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { getDepositHistory, getWithdrawalHistory } from "@/lib/history/queries";
import { safeInt } from "@/lib/history/validate";

export async function GET(req: NextRequest) {
  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const params = req.nextUrl.searchParams;
  const type = params.get("type"); // "deposits" | "withdrawals" | null (both)
  const limit = safeInt(params.get("limit"));
  const offset = safeInt(params.get("offset"));

  try {
    if (type === "deposits") {
      const result = await getDepositHistory({ walletAddr: address, limit, offset });
      return NextResponse.json(result);
    }
    if (type === "withdrawals") {
      const result = await getWithdrawalHistory({ walletAddr: address, limit, offset });
      return NextResponse.json(result);
    }

    // Return both
    const [deposits, withdrawals] = await Promise.all([
      getDepositHistory({ walletAddr: address, limit, offset }),
      getWithdrawalHistory({ walletAddr: address, limit, offset }),
    ]);
    return NextResponse.json({ deposits, withdrawals });
  } catch (error) {
    console.error("[api/history/transfers] error:", error);
    return NextResponse.json({ error: "Failed to fetch transfer history" }, { status: 500 });
  }
}
