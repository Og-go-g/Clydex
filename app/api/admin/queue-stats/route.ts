/**
 * GET /api/admin/queue-stats
 * Admin-only: queue state, tier stats, worker heartbeat.
 * Auth: Bearer CRON_SECRET (reusing existing admin auth)
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { query } from "@/lib/db-history";

interface QueueRow extends Record<string, unknown> {
  name: string;
  state: string;
  count: string;
}

interface TierRow extends Record<string, unknown> {
  tier: number;
  total: string;
  stale_count: string;
  oldest_refresh: Date | null;
}

interface HeartbeatRow extends Record<string, unknown> {
  lastBeat: Date;
  pid: number | null;
  host: string | null;
}

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
    // Queue state counts (pg-boss.job is the single source of truth)
    const queues = await query<QueueRow>(
      `SELECT name, state, COUNT(*)::text AS count
       FROM pgboss.job
       WHERE state IN ('created', 'active', 'retry', 'failed')
       GROUP BY name, state
       ORDER BY name, state`,
    ).catch(() => []);

    // Tier membership + staleness
    const tiers = await query<TierRow>(
      `SELECT tier,
              COUNT(*)::text AS total,
              COUNT(*) FILTER (
                WHERE "nextDueAt" < NOW()
              )::text AS stale_count,
              MIN("lastRefresh") AS oldest_refresh
       FROM leaderboard_tiers
       GROUP BY tier
       ORDER BY tier`,
    ).catch(() => []);

    // Worker heartbeat
    const heartbeat = await query<HeartbeatRow>(
      `SELECT "lastBeat", pid, host FROM worker_heartbeat WHERE id = 1`,
    ).catch(() => []);

    const hb = heartbeat[0];
    const heartbeatAgeSec = hb?.lastBeat
      ? Math.floor((Date.now() - new Date(hb.lastBeat).getTime()) / 1000)
      : null;

    return NextResponse.json({
      queues: queues.map((q) => ({
        name: q.name,
        state: q.state,
        count: parseInt(q.count),
      })),
      tiers: tiers.map((t) => ({
        tier: t.tier,
        total: parseInt(t.total),
        staleCount: parseInt(t.stale_count),
        oldestRefresh: t.oldest_refresh,
      })),
      worker: hb
        ? {
            lastBeat: hb.lastBeat,
            ageSeconds: heartbeatAgeSec,
            alive: heartbeatAgeSec !== null && heartbeatAgeSec < 120,
            pid: hb.pid,
            host: hb.host,
          }
        : { alive: false, lastBeat: null, ageSeconds: null },
    });
  } catch (err) {
    console.error("[queue-stats]", err);
    return NextResponse.json({ error: "Stats query failed" }, { status: 500 });
  }
}
