import { NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { getOwnershipForFollower } from "@/lib/copy/queries";
import { getAccount, getUser } from "@/lib/n1/client";
import { ensureMarketCache, getCachedMarkets } from "@/lib/n1/constants";

/**
 * GET /api/copy/open-positions
 *
 * Returns currently-open copy positions for the authenticated user —
 * the join of `copy_position_ownership` × the user's live exchange
 * positions. Used by the Open Copy Positions panel (replaces the old
 * Activity Log inside CopyTradingPanel).
 *
 * For each ownership row:
 *   - If the user has a non-zero exchange position in that market →
 *     enrich with live data (side, size, entry price, trading PnL,
 *     funding PnL) and include in the response.
 *   - Otherwise → skip (the position was closed manually or was
 *     never actually opened — orphan ownership row, harmless).
 *
 * tradingPnl from PerpPositionUpdate is the exchange-computed
 * unrealized PnL in USDC, mark-priced. No need to fetch market
 * stats separately for PnL display.
 */
export const dynamic = "force-dynamic";

interface OpenCopyPosition {
  marketId: number;
  symbol: string;
  side: "Long" | "Short";
  size: number;
  entryPrice: number;
  tradingPnl: number;
  fundingPnl: number;
  owningLeaderAddr: string;
  openedAt: string;
}

export async function GET() {
  const followerAddr = await getAuthAddress();
  if (!followerAddr) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const ownership = await getOwnershipForFollower(followerAddr);
    if (ownership.length === 0) {
      return NextResponse.json({ positions: [] });
    }

    // Resolve follower's accountId to fetch live positions.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = await getUser(followerAddr) as any;
    const accountIds: number[] = user?.accountIds ?? [];
    if (accountIds.length === 0) {
      return NextResponse.json({ positions: [] });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const account = await getAccount(accountIds[0]) as any;
    const livePositions = Array.isArray(account?.positions) ? account.positions : [];

    // Build (marketId → live position) lookup, dropping zero-size entries.
    const liveByMarket = new Map<number, { baseSize: number; entryPrice: number; tradingPnl: number; fundingPnl: number }>();
    for (const p of livePositions) {
      const baseSize = p.perp?.baseSize ?? 0;
      if (baseSize === 0) continue;
      liveByMarket.set(p.marketId, {
        baseSize,
        entryPrice: p.perp?.price ?? 0,
        tradingPnl: p.perp?.tradingPnl ?? 0,
        fundingPnl: p.perp?.fundingPaymentPnl ?? 0,
      });
    }

    await ensureMarketCache();
    const markets = getCachedMarkets();
    const symbolByMarket = new Map<number, string>();
    for (const m of markets) symbolByMarket.set(m.id, m.symbol);

    // Join ownership × live positions, enrich.
    const positions: OpenCopyPosition[] = [];
    for (const own of ownership) {
      const live = liveByMarket.get(own.marketId);
      if (!live) continue;
      positions.push({
        marketId: own.marketId,
        symbol: symbolByMarket.get(own.marketId) ?? `M${own.marketId}`,
        side: live.baseSize > 0 ? "Long" : "Short",
        size: Math.abs(live.baseSize),
        entryPrice: live.entryPrice,
        tradingPnl: live.tradingPnl,
        fundingPnl: live.fundingPnl,
        owningLeaderAddr: own.owningLeaderAddr,
        openedAt: own.openedAt instanceof Date ? own.openedAt.toISOString() : String(own.openedAt),
      });
    }

    return NextResponse.json({ positions });
  } catch (err) {
    console.error("[copy/open-positions]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load open positions" },
      { status: 500 },
    );
  }
}
