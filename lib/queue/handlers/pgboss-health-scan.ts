/**
 * pg-boss handler for the `pgboss-health-scan` job (every 5 min).
 *
 * Why this exists:
 *   On 2026-05-21 we discovered `refresh-leaderboard-tier-2` had been
 *   silently failing every hour for >24 h, hidden because the failure
 *   path produced no Sentry event — pg-boss just kept the row at
 *   `state=failed` and moved on. With ~10 cron jobs running and only
 *   manual `psql pgboss.job` audits, a silent stall can go unnoticed
 *   for days. This scan converts pg-boss's quiet state machine into
 *   actionable Sentry alerts.
 *
 * What it detects (MVP):
 *
 *   (A) Recently-failed jobs that pg-boss did not recover from.
 *       Query: pgboss.job WHERE state='failed' AND
 *              created_on > NOW() - INTERVAL '1 hour'.
 *       Group by (name, error_message) so each distinct failure shape
 *       produces one Sentry event, not N. Sentry's own dedup then
 *       collapses repeat occurrences into a single issue with a count.
 *
 *   (B) Cron jobs that look stalled.
 *       For each known schedule, check the latest `completed_on`. If it
 *       is older than 2× the cron's expected interval, the worker is
 *       likely not picking the job up — e.g. queue stuck, worker
 *       crash-looped before processing, or the schedule was unregistered
 *       by a deploy mishap (this exact bug bit us on 2026-04-25 when
 *       4 of 5 tier schedules got silently overwritten).
 *
 * Idempotent by Sentry-side dedup: same message + tags coalesces into
 * one issue. Re-running the scan during an ongoing outage just
 * increments the issue count, doesn't create new noise.
 *
 * Cheap query set — five SELECTs over indexed pgboss tables, all under
 * 5 ms. Safe to run every 5 min.
 */

import * as Sentry from "@sentry/nextjs";
import { query } from "@/lib/db-history";

interface Job<T> {
  id: string;
  name: string;
  data: T;
}

// Expected interval for each scheduled job, in milliseconds. Kept in
// sync with lib/queue/schedules.ts cron expressions. Hardcoded so we
// don't parse cron at runtime — cheaper and less brittle than a
// general parser, and the schedule set is small.
const EXPECTED_INTERVAL_MS: Record<string, number> = {
  "copy-engine-tick": 60_000, // * * * * *
  "anomaly-scan": 60_000, // * * * * *
  "refresh-leaderboard-tier-1": 30 * 60_000, // */30 * * * *
  "refresh-leaderboard-tier-2": 60 * 60_000, // 7 * * * *
  "refresh-leaderboard-tier-3": 6 * 60 * 60_000, // 13 */6 * * *
  "refresh-leaderboard-tier-4": 24 * 60 * 60_000, // 0 3 * * *
  "refresh-leaderboard-tier-spot": 24 * 60 * 60_000, // 0 6 * * *
  "resolve-wallets": 15 * 60_000, // */15 * * * *
  "sync-users-enqueuer": 24 * 60 * 60_000, // 0 2 * * *
  "pgboss-health-scan": 5 * 60_000, // */5 * * * * (self — meta-monitoring)
};

interface FailedGroupRow extends Record<string, unknown> {
  name: string;
  error_message: string | null;
  failure_count: number;
  last_failed_at: Date;
}

interface StalledRow extends Record<string, unknown> {
  name: string;
  last_completed_at: Date | null;
}

/**
 * Find (A) — failed jobs grouped by (name, error_message) in the last
 * 1 hour. Each group becomes one Sentry alert.
 */
async function detectRecentFailures(): Promise<FailedGroupRow[]> {
  return query<FailedGroupRow>(
    `SELECT
       name,
       output->>'message' AS error_message,
       COUNT(*)::int AS failure_count,
       MAX(completed_on) AS last_failed_at
     FROM pgboss.job
     WHERE state = 'failed'
       AND created_on > NOW() - INTERVAL '1 hour'
     GROUP BY name, output->>'message'
     HAVING COUNT(*) > 0`,
  );
}

/**
 * Find (B) — cron jobs whose latest completed_on is older than 2× the
 * expected cadence. Means the schedule fired but the handler is
 * either crashing on every run OR the schedule is no longer
 * registered.
 *
 * We pull one row per scheduled name. NULL `last_completed_at` means
 * the schedule has never produced a completed job — alert too (likely
 * a fresh deploy that hasn't tickered the schedule yet, but better to
 * see than ignore).
 */
async function detectStalledSchedules(): Promise<StalledRow[]> {
  const names = Object.keys(EXPECTED_INTERVAL_MS);
  const rows = await query<StalledRow>(
    `SELECT
       n.name,
       (SELECT MAX(completed_on) FROM pgboss.job
        WHERE name = n.name AND state = 'completed') AS last_completed_at
     FROM UNNEST($1::text[]) AS n(name)`,
    [names],
  );

  const now = Date.now();
  return rows.filter((r) => {
    const interval = EXPECTED_INTERVAL_MS[r.name];
    if (!interval) return false; // unknown name — skip rather than alert
    const ageMs = r.last_completed_at
      ? now - r.last_completed_at.getTime()
      : Infinity;
    return ageMs > 2 * interval;
  });
}

export async function handlePgbossHealthScan(
  _job: Job<Record<string, never>>,
): Promise<void> {
  const t0 = Date.now();
  let failures = 0;
  let stalled = 0;

  try {
    // (A) Recently-failed jobs
    const failed = await detectRecentFailures();
    failures = failed.length;
    for (const group of failed) {
      Sentry.captureMessage(
        `[pgboss] ${group.name} failed ${group.failure_count}× in last 1h: ${group.error_message ?? "(no error message)"}`,
        {
          level: "warning",
          tags: {
            component: "pgboss-health",
            event: "job-failed",
            // Sentry tag value limit is 200 chars — trim the job name
            // defensively even though all current names are <40 chars.
            job: group.name.slice(0, 200),
          },
          extra: {
            failureCount: group.failure_count,
            lastFailedAt: group.last_failed_at.toISOString(),
            errorMessage: group.error_message,
          },
        },
      );
    }

    // (B) Stalled schedules
    const stalledRows = await detectStalledSchedules();
    stalled = stalledRows.length;
    for (const row of stalledRows) {
      const interval = EXPECTED_INTERVAL_MS[row.name];
      const expectedEveryMin = Math.round(interval / 60_000);
      const lastSeen = row.last_completed_at
        ? row.last_completed_at.toISOString()
        : "never";
      Sentry.captureMessage(
        `[pgboss] ${row.name} stalled — expected every ${expectedEveryMin}min, last completed: ${lastSeen}`,
        {
          level: "warning",
          tags: {
            component: "pgboss-health",
            event: "schedule-stalled",
            job: row.name.slice(0, 200),
          },
          extra: {
            expectedIntervalMs: interval,
            lastCompletedAt: lastSeen,
          },
        },
      );
    }

    if (failures > 0 || stalled > 0) {
      console.warn(
        `[pgboss-health-scan] failures=${failures} stalled=${stalled} duration=${Date.now() - t0}ms`,
      );
    }
  } catch (err) {
    // Don't let our own monitoring crash the worker; emit and move on.
    Sentry.captureException(err, {
      tags: { component: "pgboss-health", event: "scan-failed" },
    });
    console.error("[pgboss-health-scan] failed:", err);
  }
}
