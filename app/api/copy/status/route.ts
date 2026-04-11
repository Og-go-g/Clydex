import { NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { isSessionActive } from "@/lib/copy/session-activator";
import { getSubscriptions, getCopyStats } from "@/lib/copy/queries";

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
    const [session, subscriptions, stats] = await Promise.all([
      isSessionActive(addr),
      getSubscriptions(addr),
      getCopyStats(addr),
    ]);

    return NextResponse.json({
      sessionActive: session.active,
      sessionExpires: session.expiresAt?.toISOString() ?? null,
      subscriptions: subscriptions.map((s) => ({
        id: s.id,
        leaderAddr: s.leaderAddr,
        allocationUsdc: s.allocationUsdc,
        leverageMult: s.leverageMult,
        maxPositionUsdc: s.maxPositionUsdc,
        stopLossPct: s.stopLossPct,
        active: s.active,
      })),
      stats,
    });
  } catch (err) {
    // History DB may be unavailable in local dev
    const msg = err instanceof Error ? err.message : "Unknown error";
    if (msg.includes("ECONNREFUSED") || msg.includes("connect")) {
      return NextResponse.json({
        sessionActive: false,
        sessionExpires: null,
        subscriptions: [],
        stats: { totalTrades: 0, filledTrades: 0, failedTrades: 0, todayTrades: 0 },
      });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
