import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { query } from "@/lib/db-history";

/**
 * GET /api/stats — public endpoint returning aggregate stats.
 * Cached for 5 minutes via Cache-Control to avoid hammering the DB.
 */
export async function GET() {
  try {
    const [users, traderRows] = await Promise.all([
      prisma.user.count().catch(() => null),
      query<{ cnt: string }>(`SELECT COUNT(*)::text AS cnt FROM pnl_totals`).catch(() => []),
    ]);
    const traders = parseInt(traderRows[0]?.cnt ?? "0");
    return NextResponse.json(
      { users, traders },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" } },
    );
  } catch (error) {
    console.error("[api/stats] error:", error);
    return NextResponse.json({ users: null, traders: null }, { status: 500 });
  }
}
