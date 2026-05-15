import { NextRequest, NextResponse } from "next/server";
import { getTraderSummary } from "@/lib/copytrade/leaderboard";

const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * GET /api/traders/:address/summary
 *
 * Lightweight version of `/profile`. Returns just the headline stats
 * that fit in the search-result card (PnL, win-rate, trade count,
 * volume, etc) — skips the per-market recursive PnL CTE that
 * `/profile` runs.
 *
 * Built specifically for the Top Traders search box because:
 *   - The card UI never displays top-trades / market-breakdown /
 *     recent-trades.
 *   - For a high-activity trader, /profile takes 20-30s; /summary
 *     takes 200-400ms cold and <5ms warm.
 *
 * AI chat tools (getTraderProfile, compareTraders) keep using
 * /profile because they may render those heavy sections.
 *
 * Address forms accepted: base58 Solana pubkey or `account:<N>`
 * placeholder. The library resolves placeholders to canonical wallet
 * via pnl_totals.accountId before any other query.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;

  const isAccountId = address.startsWith("account:") && /^\d+$/.test(address.slice(8));
  if (!isAccountId && !SOLANA_ADDR_RE.test(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  try {
    const summary = await getTraderSummary(address);
    if (!summary) {
      return NextResponse.json({ error: "Trader not found" }, { status: 404 });
    }
    return NextResponse.json(
      { data: summary },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" } },
    );
  } catch (error) {
    console.error(`[api/traders/${address}/summary] error:`, error);
    return NextResponse.json({ error: "Failed to fetch trader summary" }, { status: 500 });
  }
}
