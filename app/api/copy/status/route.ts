import { NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { isSessionActive } from "@/lib/copy/session-activator";
import { getSubscriptions, getCopyStats, getRecentCopyTrades, getPerLeaderStats, getRecentTradesByLeader } from "@/lib/copy/queries";

/**
 * GET /api/copy/status
 * Full copy trading status: session, subscriptions, stats.
 */
export async function GET() {
  const addr = await getAuthAddress();
  if (!addr) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const [session, subscriptions, stats, recentTrades, leaderStats] = await Promise.all([
      isSessionActive(addr),
      getSubscriptions(addr),
      getCopyStats(addr),
      getRecentCopyTrades(addr, 20),
      getPerLeaderStats(addr),
    ]);

    // Fetch recent trades per leader (for expanded cards)
    const leaderAddrs = subscriptions.map((s) => s.leaderAddr);
    const leaderTradesMap: Record<string, Array<{ symbol: string; side: string; size: string; price: string | null; status: string; createdAt: Date }>> = {};
    if (leaderAddrs.length > 0) {
      const tradeResults = await Promise.all(
        leaderAddrs.map((la) => getRecentTradesByLeader(addr, la, 5)),
      );
      leaderAddrs.forEach((la, i) => {
        leaderTradesMap[la] = tradeResults[i].map((t) => ({
          symbol: t.symbol,
          side: t.side,
          size: t.size,
          price: t.price,
          status: t.status,
          createdAt: t.createdAt,
        }));
      });
    }

    // Build leaderStats map for quick lookup
    const leaderStatsMap: Record<string, { totalTrades: number; filledTrades: number; failedTrades: number; totalVolume: number }> = {};
    for (const ls of leaderStats) {
      leaderStatsMap[ls.leaderAddr] = {
        totalTrades: ls.totalTrades,
        filledTrades: ls.filledTrades,
        failedTrades: ls.failedTrades,
        totalVolume: ls.totalVolume,
      };
    }

    return NextResponse.json({
      sessionActive: session.active,
      sessionExpires: session.expiresAt?.toISOString() ?? null,
      subscriptions: subscriptions.map((s) => ({
        id: s.id,
        leaderAddr: s.leaderAddr,
        allocationUsdc: s.allocationUsdc,
        leverageMult: s.leverageMult,
        maxPositionUsdc: s.maxPositionUsdc,
        maxTotalPositionUsdc: s.maxTotalPositionUsdc,
        stopLossPct: s.stopLossPct,
        active: s.active,
        stats: leaderStatsMap[s.leaderAddr] ?? { totalTrades: 0, filledTrades: 0, failedTrades: 0, totalVolume: 0 },
        recentTrades: leaderTradesMap[s.leaderAddr] ?? [],
      })),
      stats,
      recentTrades: recentTrades.map((t) => ({
        symbol: t.symbol,
        side: t.side,
        size: t.size,
        price: t.price,
        status: t.status,
        error: t.error,
        leaderAddr: t.leaderAddr,
        createdAt: t.createdAt,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    // PRE-2026-05-16 this branch returned a fake "empty session" body
    // (sessionActive:false, subscriptions:[]) on ECONNREFUSED so local
    // dev wouldn't crash. On PROD this masked transient DB hiccups
    // (pool exhaustion, brief network blip) as "you lost your 30-day
    // session and all your subscriptions" — user reloads, sees the
    // activate UI, clicks Enable, and the active DB session gets
    // overwritten by a fresh wallet sign. Same mask also made
    // unfollow look broken: DELETE succeeds, the follow-up status
    // fetch hits a transient error, fallback returns empty subs, UI
    // shows… the stale subscription it cached before the click.
    //
    // Now: 503 on any DB error. Frontend keeps its previous status
    // displayed (see CopyTradingPanel.fetchStatus) and retries on
    // the next poll tick instead of blinking the user back to the
    // "Enable Copy Trading" screen.
    console.error("[copy/status]", msg);
    return NextResponse.json(
      { error: "Copy status temporarily unavailable. Retry in a moment." },
      { status: 503 },
    );
  }
}
