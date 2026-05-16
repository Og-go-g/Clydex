import { NextRequest, NextResponse } from "next/server";
import { getLeaderboard, isMMLike, parsePeriod } from "@/lib/copytrade/leaderboard";
import { safeInt } from "@/lib/history/validate";

/**
 * GET /api/leaderboard — public endpoint, no auth required.
 *
 * Query params:
 *   period:    integer day count (1-365), `7d` / `30d` shorthand, or
 *              `all` (default: `all`). Garbage falls back to `all`.
 *   sort:      "pnl" | "winrate" | "volume" | "trades" (default: "pnl")
 *   limit:     1-100 (default: 50)
 *   includeMM: `true` or `1` to include market-maker / bot accounts.
 *              Default omitted → excluded. The response carries
 *              `mmFiltered` (count hidden) and `mmIncluded` (flag) so
 *              clients can present transparency.
 *
 * Cached for 5 minutes — leaderboard data doesn't change fast.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  const period = parsePeriod(params.get("period")) ?? "all";

  const sortRaw = params.get("sort") ?? "pnl";
  const sort = (["pnl", "winrate", "volume", "trades"] as const).includes(sortRaw as "pnl")
    ? (sortRaw as "pnl" | "winrate" | "volume" | "trades")
    : "pnl";

  const limit = safeInt(params.get("limit")) ?? 50;
  const includeMMRaw = params.get("includeMM");
  const includeMM = includeMMRaw === "true" || includeMMRaw === "1";

  try {
    // Over-fetch 4× when MM-filtering so we still hit the requested
    // limit after the post-filter — same pattern the AI tools use.
    const rawLimit = includeMM ? limit : Math.min(limit * 4, 200);
    const raw = await getLeaderboard(period, sort, rawLimit);
    const data = includeMM ? raw.slice(0, limit) : raw.filter((t) => !isMMLike(t)).slice(0, limit);
    const mmFiltered = includeMM ? 0 : raw.length - data.length;
    return NextResponse.json(
      { data, mmFiltered, mmIncluded: includeMM },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" } },
    );
  } catch (error) {
    console.error("[api/leaderboard] error:", error);
    return NextResponse.json({ error: "Failed to fetch leaderboard" }, { status: 500 });
  }
}
