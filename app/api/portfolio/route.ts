import { NextResponse } from "next/server";
import { getMultiChainPortfolio } from "@/lib/defi/moralis";
import { getAuthAddress } from "@/lib/auth/session";

export async function GET(request: Request) {
  try {
    // Require authentication to prevent Moralis API key abuse
    const authAddress = await getAuthAddress();
    if (!authAddress) {
      return NextResponse.json(
        { error: "Not authenticated — please sign in first" },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const address = searchParams.get("address");

    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return NextResponse.json(
        { error: "Missing or invalid address parameter" },
        { status: 400 }
      );
    }

    // Only allow users to query their own portfolio
    if (address.toLowerCase() !== authAddress) {
      return NextResponse.json(
        { error: "Address mismatch — you can only view your own portfolio" },
        { status: 403 }
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
