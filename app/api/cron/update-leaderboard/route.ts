import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { refreshAllPnlTotals } from "@/lib/copytrade/refresh";

/**
 * GET /api/cron/update-leaderboard
 *
 * Daily cron — refreshes pnl_totals + volume_calendar for all tracked accounts
 * from 01.xyz frontend API. Keeps leaderboard data fresh.
 *
 * Rate: ~3s per account (01.xyz WAF). 100 accounts ≈ 5 min.
 *
 * Protected by CRON_SECRET bearer token.
 * Crontab: "0 4 * * *" (daily 4am UTC, after sync-history at 3am).
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret}`;
  const maxLen = Math.max(auth.length, expected.length);
  const authBuf = Buffer.from(auth.padEnd(maxLen));
  const expectedBuf = Buffer.from(expected.padEnd(maxLen));
  if (auth.length !== expected.length || !timingSafeEqual(authBuf, expectedBuf)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await refreshAllPnlTotals();

    return NextResponse.json({
      accounts: result.totalAccounts,
      updated: result.updated,
      failed: result.failed,
      skipped: result.skipped,
      durationSeconds: Math.round(result.durationMs / 1000),
    });
  } catch (error) {
    console.error("[cron/update-leaderboard] fatal:", error);
    return NextResponse.json({ error: "Refresh failed" }, { status: 500 });
  }
}
