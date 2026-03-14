import { NextResponse } from "next/server";
import { getTokenPrice } from "@/lib/defi/prices";
import { getAuthAddress } from "@/lib/auth/session";

export async function GET(request: Request) {
  // Require auth to prevent abuse as free API proxy
  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get("token");

    if (!token || token.length > 100 || !/^[a-zA-Z0-9_.\-]+$/.test(token)) {
      return NextResponse.json(
        { error: "Missing or invalid token parameter" },
        { status: 400 }
      );
    }

    const price = await getTokenPrice(token);

    if (!price) {
      return NextResponse.json(
        { error: "Token not found on Base" },
        { status: 404 }
      );
    }

    return NextResponse.json({ price });
  } catch (error) {
    console.error("Prices API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch price" },
      { status: 500 }
    );
  }
}
