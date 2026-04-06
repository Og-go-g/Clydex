import { NextRequest, NextResponse } from "next/server";
import { getTraderProfile } from "@/lib/copytrade/leaderboard";

const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * GET /api/traders/:address/profile — public trader profile.
 *
 * Returns aggregate metrics, top trades, market breakdown, recent trades.
 * Cached for 5 minutes.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;

  if (!SOLANA_ADDR_RE.test(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  try {
    const profile = await getTraderProfile(address);
    if (!profile) {
      return NextResponse.json({ error: "Trader not found" }, { status: 404 });
    }

    return NextResponse.json(
      { data: profile },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" } },
    );
  } catch (error) {
    console.error(`[api/traders/${address}/profile] error:`, error);
    return NextResponse.json({ error: "Failed to fetch trader profile" }, { status: 500 });
  }
}
