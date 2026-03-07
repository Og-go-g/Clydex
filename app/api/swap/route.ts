import { NextResponse } from "next/server";
import { getSwapCalldata } from "@/lib/defi/swap";
import { simulateSwap } from "@/lib/defi/utils";
import { getAuthAddress } from "@/lib/auth/session";

export async function POST(request: Request) {
  try {
    // Verify SIWE session — only authenticated users can swap
    const authAddress = await getAuthAddress();
    if (!authAddress) {
      return NextResponse.json(
        { error: "Not authenticated — please sign in first" },
        { status: 401 }
      );
    }

    const { fromToken, toToken, amount, userAddress, slippage, provider } =
      await request.json();

    if (
      typeof fromToken !== "string" || typeof toToken !== "string" ||
      typeof amount !== "string" || typeof userAddress !== "string" ||
      !fromToken || !toToken || !amount || !userAddress ||
      isNaN(Number(amount)) || Number(amount) <= 0
    ) {
      return NextResponse.json(
        { error: "Missing or invalid parameters" },
        { status: 400 }
      );
    }

    if (!/^0x[0-9a-fA-F]{40}$/.test(userAddress)) {
      return NextResponse.json(
        { error: "Invalid wallet address" },
        { status: 400 }
      );
    }

    // Verify the request address matches the authenticated session
    if (userAddress.toLowerCase() !== authAddress) {
      return NextResponse.json(
        { error: "Address mismatch — session does not match request" },
        { status: 403 }
      );
    }

    // Clamp slippage to safe range: 0.1% – 5%
    const safeSlippage = Math.min(Math.max(Number(slippage) || 1, 0.1), 5);

    const transaction = await getSwapCalldata(
      fromToken,
      toToken,
      amount,
      userAddress,
      safeSlippage,
      provider
    );

    // Dry-run: simulate the swap via eth_call before sending to the user.
    // Catches reverts (insufficient balance, bad route, expired quote)
    // without costing any gas. Fail-open if RPC is unreachable.
    const sim = await simulateSwap(userAddress, transaction);

    if (!sim.success) {
      return NextResponse.json(
        { error: `Swap would fail: ${sim.reason}` },
        { status: 400 }
      );
    }

    return NextResponse.json({ transaction });
  } catch (error: unknown) {
    console.error("Swap API error:", error);
    const message = error instanceof Error ? error.message : "";
    const safeMsg = message.includes("Unknown token") || message.includes("Provider")
      ? message
      : "Failed to prepare swap transaction";
    return NextResponse.json(
      { error: safeMsg },
      { status: 500 }
    );
  }
}
