/**
 * Declarative cron schedules — managed by pg-boss.
 *
 * Schedules persist in pg-boss DB and survive worker restarts.
 * Calling registerSchedules() is idempotent (boss.schedule upserts).
 *
 * Set WORKER_SCHEDULES_ENABLED=false to skip (shadow mode deployment).
 */

import type { PgBoss } from "pg-boss";
import { JOB } from "./job-names";

export async function registerSchedules(boss: PgBoss): Promise<void> {
  if (process.env.WORKER_SCHEDULES_ENABLED === "false") {
    console.log("[worker] schedules disabled via WORKER_SCHEDULES_ENABLED=false");
    return;
  }

  // Tier 1: top 500 + copy leaders — every 30 min
  await boss.schedule(JOB.refreshTier, "*/30 * * * *", { tier: 1 });

  // Tier 2: interacted accounts — hourly, offset 7 min to avoid clash with T1
  await boss.schedule(JOB.refreshTier, "7 * * * *", { tier: 2 });

  // Tier 3: active traders — every 6 hours, offset 13 min
  await boss.schedule(JOB.refreshTier, "13 */6 * * *", { tier: 3 });

  // Tier 4: everyone else — nightly 03:00 UTC
  await boss.schedule(JOB.refreshTier, "0 3 * * *", { tier: 4 });

  // Spot check — daily 06:00 UTC
  await boss.schedule(JOB.refreshTier, "0 6 * * *", { tier: "spot" });

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
  await boss.unschedule(JOB.refreshTier);
  await boss.unschedule(JOB.syncUsersEnqueuer);
  await boss.unschedule(JOB.resolveWallets);
  await boss.unschedule(JOB.copyEngineTick);
  console.log("[worker] schedules cleared");
}
