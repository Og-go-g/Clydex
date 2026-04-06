import { NextRequest, NextResponse } from "next/server";
import { getLeaderboard } from "@/lib/copytrade/leaderboard";
import { safeInt } from "@/lib/history/validate";

/**
 * GET /api/leaderboard — public endpoint, no auth required.
 *
 * Query params:
 *   period: "7d" | "30d" | "all" (default: "all")
 *   sort:   "pnl" | "winrate" | "volume" | "trades" (default: "pnl")
 *   limit:  1-100 (default: 50)
 *
 * Cached for 5 minutes — leaderboard data doesn't change fast.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  const periodRaw = params.get("period") ?? "all";
  const period = (["7d", "30d", "all"] as const).includes(periodRaw as "7d" | "30d" | "all")
    ? (periodRaw as "7d" | "30d" | "all")
    : "all";

  const sortRaw = params.get("sort") ?? "pnl";
  const sort = (["pnl", "winrate", "volume", "trades"] as const).includes(sortRaw as "pnl")
    ? (sortRaw as "pnl" | "winrate" | "volume" | "trades")
    : "pnl";

  const limit = safeInt(params.get("limit")) ?? 50;

  try {
    const data = await getLeaderboard(period, sort, limit);
    return NextResponse.json(
      { data },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" } },
    );
  } catch (error) {
    console.error("[api/leaderboard] error:", error);
    return NextResponse.json({ error: "Failed to fetch leaderboard" }, { status: 500 });
  }
}
