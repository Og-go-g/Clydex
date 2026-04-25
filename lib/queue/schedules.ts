/**
 * Declarative cron schedules — managed by pg-boss.
 *
 * Schedules persist in pg-boss DB and survive worker restarts.
 * Calling registerSchedules() is idempotent (boss.schedule upserts).
 *
 * Set WORKER_SCHEDULES_ENABLED=false to skip (shadow mode deployment).
 */

import type { PgBoss } from "pg-boss";
import { JOB, TIER_IDS, tierScheduleName, type TierId } from "./job-names";

// Cron per tier. Each tier gets its own pg-boss queue + schedule row
// (see `tierScheduleName` rationale in job-names.ts). Offsets between
// tiers (7, 13, etc.) keep their executions from clashing inside the
// same minute on a small worker.
const TIER_CRONS: Record<string, string> = {
  "1":     "*/30 * * * *", // top 500 + copy leaders
  "2":     "7 * * * *",    // interacted accounts
  "3":     "13 */6 * * *", // active traders
  "4":     "0 3 * * *",    // everyone else
  "spot":  "0 6 * * *",    // 500 random T4 spot check
};

export async function registerSchedules(boss: PgBoss): Promise<void> {
  if (process.env.WORKER_SCHEDULES_ENABLED === "false") {
    console.log("[worker] schedules disabled via WORKER_SCHEDULES_ENABLED=false");
    return;
  }

  // Tiered leaderboard refresh — one queue + schedule per tier.
  for (const tier of TIER_IDS) {
    const cron = TIER_CRONS[String(tier)];
    if (!cron) throw new Error(`[schedules] no cron defined for tier=${tier}`);
    await boss.schedule(tierScheduleName(tier), cron, { tier });
  }

  // Cleanup legacy single-row schedule from the pre-fix deploy. The old
  // code registered every tier under `JOB.refreshTier`, so only the last
  // tier (spot) survived in `pgboss.schedule`. Now that real schedules
  // live under `refresh-leaderboard-tier-{tier}`, drop the orphan row so
  // it stops firing duplicates.
  try {
    await boss.unschedule(JOB.refreshTier);
  } catch {
    /* fine on fresh DBs that never had the legacy row */
  }

  // Per-user history fan-out — nightly 02:00 UTC
  await boss.schedule(JOB.syncUsersEnqueuer, "0 2 * * *", {});

  // Wallet resolver — every 15 min. Picks up new accounts (delta against
  // /accounts/count) and retries 404-marked rows. Delta is tiny once the
  // one-off backfill has run, so cadence can stay frequent.
  await boss.schedule(JOB.resolveWallets, "*/15 * * * *", {});

  // Copy trading engine — every minute. Handler internally runs 4 cycles
  // of runCopyEngine() spaced 15s apart, giving ~15s mirror-lag for copy
  // traders. Replaces the legacy host-level curl cron that was invisible
  // to code review and silently stopped when PG died on 2026-04-19.
  await boss.schedule(JOB.copyEngineTick, "* * * * *", {});

  console.log("[worker] schedules registered");
}

/**
 * Remove all schedules — used by rollback.
 */
export async function clearSchedules(boss: PgBoss): Promise<void> {
  for (const tier of TIER_IDS) {
    await boss.unschedule(tierScheduleName(tier));
  }
  // Legacy name (in case it persisted from the pre-fix deploy).
  await boss.unschedule(JOB.refreshTier);
  await boss.unschedule(JOB.syncUsersEnqueuer);
  await boss.unschedule(JOB.resolveWallets);
  await boss.unschedule(JOB.copyEngineTick);
  console.log("[worker] schedules cleared");
}
