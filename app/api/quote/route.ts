import { NextResponse } from "next/server";
import { getSwapQuote } from "@/lib/defi/swap";

export async function POST(request: Request) {
  try {
    const { fromToken, toToken, amount, userAddress } = await request.json();

    if (!fromToken || !toToken || !amount || !userAddress) {
      return NextResponse.json(
        { error: "Missing required parameters" },
        { status: 400 }
      );
    }

    const quote = await getSwapQuote(fromToken, toToken, amount, userAddress);
    return NextResponse.json({ quote });
  } catch (error: unknown) {
    console.error("Quote API error:", error);
    const message = error instanceof Error ? error.message : "";
    const safeMsg = message.includes("Unknown token") || message.includes("All DEX providers failed")
      ? message
      : "Failed to get quote";
    return NextResponse.json(
      { error: safeMsg },
      { status: 500 }
    );
  }
}
