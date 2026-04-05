import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";
import { syncAllHistory } from "@/lib/history/sync";
import { getCachedAccountId } from "@/lib/n1/account-cache";

/**
 * GET /api/cron/sync-history
 *
 * Weekly cron — incremental sync for all users.
 * Only fetches data since last cursor (set after initial bulk load or previous cron).
 * Typically ~1 week of new data per user.
 *
 * Protected by CRON_SECRET bearer token.
 * Configured via crontab: "0 3 * * 1" (Monday 3am UTC).
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret}`;
  // Timing-safe comparison — pad both to the SAME length (max of the two)
  const maxLen = Math.max(auth.length, expected.length);
  const authBuf = Buffer.from(auth.padEnd(maxLen));
  const expectedBuf = Buffer.from(expected.padEnd(maxLen));
  if (auth.length !== expected.length || !timingSafeEqual(authBuf, expectedBuf)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Get all users
    const users = await prisma.user.findMany({ select: { address: true } });

    const results: Array<{ wallet: string; status: string; inserted?: number }> = [];

    for (const user of users) {
      const wallet = user.address;

      try {
        const accountId = await getCachedAccountId(wallet);
        if (accountId === null) {
          results.push({ wallet, status: "no_account" });
          continue;
        }

        const syncResults = await syncAllHistory(accountId, wallet);
        const totalInserted = syncResults.reduce((sum, r) => sum + r.inserted, 0);
        const hasError = syncResults.some((r) => r.error);

        results.push({
          wallet,
          status: hasError ? "partial" : "ok",
          inserted: totalInserted,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[cron/sync-history] ${wallet}: ${msg}`);
        results.push({ wallet, status: "error" });
      }

      // Rate limit: 500ms between users
      await new Promise((r) => setTimeout(r, 500));
    }

    const synced = results.filter((r) => r.status === "ok" || r.status === "partial").length;
    const totalRecords = results.reduce((sum, r) => sum + (r.inserted ?? 0), 0);

    return NextResponse.json({
      users: users.length,
      synced,
      totalRecords,
      results,
    });
  } catch (error) {
    console.error("[cron/sync-history] fatal:", error);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
