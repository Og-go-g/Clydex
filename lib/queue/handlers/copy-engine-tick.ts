/**
 * copy-engine-tick — replaces the legacy external host-level curl cron
 * that used to hit /api/copy/engine every 15s.
 *
 * Why in pg-boss
 * --------------
 * - Centralized scheduling visible in git (no hidden host cronfile)
 * - Survives container rolling-deploy (job state in PG)
 * - Observable via pgboss.job (same as other workers)
 * - Health endpoint reads last-tick timestamp from this table
 * - On 2026-04-19 PG died for 5h — external cron happily curl'd into the
 *   void the whole time, nobody noticed. In pg-boss, jobs queue up while
 *   PG is recovering and process on resume.
 *
 * Cadence
 * -------
 * pg-boss cron resolution is 1 minute. We want ~15s cadence for copy
 * trading (leader trades should mirror within the next cycle). Solution:
 * one schedule per minute, handler runs 4 cycles spaced 15s apart. Inside
 * each cycle the engine's `engineRunning` lock prevents re-entry if a cycle
 * overshoots.
 *
 * Safety
 * ------
 * - runCopyEngine is already idempotent and owns its own concurrency lock.
 * - Each cycle wrapped in try/catch so one crash doesn't skip the rest.
 * - singletonSeconds on the schedule prevents two workers racing on the
 *   same minute (only one runs, the other's enqueue is dropped).
 */

import { JOB, type Payloads } from "../job-names";
import { runCopyEngine } from "@/lib/copy/engine";
import { sleep } from "@/lib/util/retry";

const CYCLES_PER_MINUTE = 4;
const SLEEP_BETWEEN_CYCLES_MS = 15_000;

export async function handleCopyEngineTick(
  _job: { id: string; name: string; data: Payloads[typeof JOB.copyEngineTick] },
): Promise<void> {
  const start = Date.now();
  let totalLeaders = 0;
  let totalDiffs = 0;
  let totalPlaced = 0;
  let totalFailed = 0;
  let cyclesRun = 0;

  for (let i = 0; i < CYCLES_PER_MINUTE; i++) {
    try {
      const r = await runCopyEngine();
      totalLeaders += r.leadersProcessed;
      totalDiffs += r.diffsDetected;
      totalPlaced += r.ordersPlaced;
      totalFailed += r.ordersFailed;
      cyclesRun++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[copy-engine-tick] cycle ${i + 1}/${CYCLES_PER_MINUTE} crashed: ${msg}`);
    }

    if (i < CYCLES_PER_MINUTE - 1) {
      await sleep(SLEEP_BETWEEN_CYCLES_MS);
    }
  }

  console.log(
    `[copy-engine-tick] cycles=${cyclesRun}/${CYCLES_PER_MINUTE} ` +
    `leaders=${totalLeaders} diffs=${totalDiffs} ` +
    `placed=${totalPlaced} failed=${totalFailed} ` +
    `duration=${Date.now() - start}ms`,
  );
}
