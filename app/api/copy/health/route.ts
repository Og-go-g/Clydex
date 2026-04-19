/**
 * GET /api/copy/health
 * Copy trading engine health snapshot.
 *
 * Polled by CopyTradingPanel every 30s — if engine is silent > HEALTHY_MAX_AGE_SEC,
 * UI shows a red banner warning followers that their mirror-lag is unbounded
 * (leader trades might not be copied right now).
 *
 * Public endpoint — only returns aggregate timing info, no secrets.
 *
 * Reads from pgboss.job — the copy-engine-tick job runs once per minute,
 * each running 4 x 15s engine cycles inside. Completion rows in the job
 * table are our source of truth.
 */

import { NextResponse } from "next/server";
import { query } from "@/lib/db-history";

const HEALTHY_MAX_AGE_SEC = 90; // 1 min cron + 30s grace

interface TickRow extends Record<string, unknown> {
  created_on: Date;
  completed_on: Date | null;
  state: string;
  duration_ms: string | null;
}

export async function GET() {
  try {
    const rows = await query<TickRow>(
      `SELECT created_on, completed_on, state,
              EXTRACT(MILLISECONDS FROM (completed_on - started_on))::text AS duration_ms
       FROM pgboss.job
       WHERE name = 'copy-engine-tick'
         AND created_on > NOW() - interval '30 minutes'
       ORDER BY created_on DESC
       LIMIT 30`,
    );

    const completed = rows.filter((r) => r.state === "completed" && r.completed_on);
    const lastCompleted = completed[0];

    const now = Date.now();
    const lastRunAt = lastCompleted?.completed_on ?? null;
    const lastRunAgoSec = lastRunAt
      ? Math.floor((now - new Date(lastRunAt).getTime()) / 1000)
      : null;

    const recentDurations = completed
      .map((r) => (r.duration_ms ? parseFloat(r.duration_ms) : NaN))
      .filter((n) => Number.isFinite(n));

    const avgDurationMs =
      recentDurations.length > 0
        ? Math.round(recentDurations.reduce((s, n) => s + n, 0) / recentDurations.length)
        : null;

    const recentFailed = rows.filter((r) => r.state === "failed").length;

    const isHealthy =
      lastRunAgoSec !== null && lastRunAgoSec <= HEALTHY_MAX_AGE_SEC;

    return NextResponse.json(
      {
        isHealthy,
        lastRunAt,
        lastRunAgoSec,
        avgDurationMs,
        recentCompleted: completed.length,
        recentFailed,
        healthyMaxAgeSec: HEALTHY_MAX_AGE_SEC,
      },
      {
        headers: {
          // Cache-Control: 10s SWR — browsers / Vercel edge can revalidate
          "Cache-Control": "public, s-maxage=10, stale-while-revalidate=20",
        },
      },
    );
  } catch (err) {
    console.error("[copy/health]", err);
    return NextResponse.json(
      { isHealthy: false, error: err instanceof Error ? err.message : "health query failed" },
      { status: 500 },
    );
  }
}
