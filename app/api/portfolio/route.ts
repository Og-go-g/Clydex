import { NextResponse } from "next/server";
import { getMultiChainPortfolio } from "@/lib/defi/moralis";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const address = searchParams.get("address");

    if (!address || !address.startsWith("0x")) {
      return NextResponse.json(
        { error: "Missing or invalid address parameter" },
        { status: 400 }
      );
    }

    const portfolio = await getMultiChainPortfolio(address);
    return NextResponse.json(portfolio);
  } catch (error) {
    console.error("Portfolio API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch portfolio" },
      { status: 500 }
    );
  }
}
