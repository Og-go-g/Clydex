import { NextRequest, NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { getCopyTradesHistory } from "@/lib/copy/queries";

/**
 * GET /api/copy/history?limit=50&offset=0&leader=...&status=filled|failed
 * Paginated copy trade history for the authenticated user.
 */
export async function GET(req: NextRequest) {
  const addr = await getAuthAddress();
  if (!addr) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const limit = Math.min(Math.max(parseInt(sp.get("limit") ?? "50"), 1), 100);
  const offset = Math.max(parseInt(sp.get("offset") ?? "0"), 0);
  const leaderAddr = sp.get("leader") || undefined;
  const status = sp.get("status") || undefined;

  if (status && !["filled", "failed", "pending", "cancelled"].includes(status)) {
    return NextResponse.json({ error: "Invalid status filter" }, { status: 400 });
  }

  try {
    const { trades, total } = await getCopyTradesHistory(addr, {
      limit,
      offset,
      leaderAddr,
      status,
    });

    return NextResponse.json({
      trades: trades.map((t) => ({
        id: t.id,
        symbol: t.symbol,
        side: t.side,
        size: t.size,
        price: t.price,
        status: t.status,
        error: t.error,
        leaderAddr: t.leaderAddr,
        createdAt: t.createdAt,
        filledAt: t.filledAt,
      })),
      total,
      limit,
      offset,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    if (msg.includes("ECONNREFUSED") || msg.includes("connect")) {
      return NextResponse.json({ trades: [], total: 0, limit, offset });
    }
    console.error("[copy/history]", msg);
    return NextResponse.json({ error: "An internal error occurred" }, { status: 500 });
  }
}
