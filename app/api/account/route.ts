import { NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { getUser, getAccount, getAccountOrders, getAccountTriggers } from "@/lib/n1/client";

/** GET /api/account — get authenticated user's account info */
export async function GET() {
  try {
    const address = await getAuthAddress();
    if (!address) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Look up the user's N1 account by Solana pubkey
    const user = await getUser(address);
    if (!user || !user.accountIds?.length) {
      return NextResponse.json({
        exists: false,
        message: "No 01 Exchange account found. Deposit USDC to create one.",
      });
    }

    const accountId = user.accountIds[0];

    // Fetch account data, orders, and triggers in parallel
    const [account, orders, triggers] = await Promise.all([
      getAccount(accountId),
      getAccountOrders(accountId),
      getAccountTriggers(accountId),
    ]);

    return NextResponse.json({
      exists: true,
      accountId,
      account,
      orders: orders.items ?? [],
      triggers,
    });
  } catch (error) {
    console.error("[/api/account] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch account" },
      { status: 500 }
    );
  }
}
