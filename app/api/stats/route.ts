import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * GET /api/stats — public endpoint returning aggregate stats.
 * Cached for 5 minutes via Cache-Control to avoid hammering the DB.
 */
export async function GET() {
  try {
    const traders = await prisma.user.count();
    return NextResponse.json(
      { traders },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" } },
    );
  } catch (error) {
    console.error("[api/stats] error:", error);
    return NextResponse.json({ traders: null }, { status: 500 });
  }
}
