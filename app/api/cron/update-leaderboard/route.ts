import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { refreshAllPnlTotals } from "@/lib/copytrade/refresh";

/**
 * GET /api/cron/update-leaderboard
 *
 * Legacy daily cron that refreshed pnl_totals + volume_calendar for every
 * tracked account. Replaced by the pg-boss worker (tier 1 every 30 min,
 * tier 4 nightly) which does the same work incrementally.
 *
 * We keep the route so crontab entries don't 404, but behaviour depends on
 * env flag LEGACY_CRON_DISABLED:
 *   - set to "true"  → no-op, returns {status:"migrated"} (recommended
 *                      once WORKER_SCHEDULES_ENABLED=true so we don't
 *                      duplicate work with the worker)
 *   - unset / false  → runs refreshAllPnlTotals, which now syncs raw data
 *                      from mainnet-backend.01.xyz and rebuilds
 *                      pnl_totals + volume_calendar locally (the old 01.xyz
 *                      frontend API path is gone — blocked by Vercel WAF).
 *
 * Protected by CRON_SECRET bearer token.
 * Crontab: "0 4 * * *" (daily 4am UTC).
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

  if (process.env.LEGACY_CRON_DISABLED === "true") {
    return NextResponse.json({
      status: "migrated",
      note: "Leaderboard refresh is now handled by the pg-boss worker.",
    });
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
