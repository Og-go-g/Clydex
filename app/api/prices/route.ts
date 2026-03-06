import { NextResponse } from "next/server";
import { getTokenPrice } from "@/lib/defi/prices";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get("token");

    if (!token) {
      return NextResponse.json(
        { error: "Missing token parameter" },
        { status: 400 }
      );
    }

    const price = await getTokenPrice(token);

    if (!price) {
      return NextResponse.json(
        { error: `Token "${token}" not found on Base` },
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
