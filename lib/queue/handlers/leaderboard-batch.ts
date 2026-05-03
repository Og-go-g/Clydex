/**
 * leaderboard-batch — process a batch of accounts for a tier refresh.
 *
 * For each account:
 *   1. Acquire an advisory lock (skip if another job holds it).
 *   2. Incrementally sync raw history from mainnet-backend.01.xyz
 *      (trades / pnl / funding / deposits / withdrawals / liquidations).
 *      This endpoint is not WAF-protected, so no proxy rotation is needed.
 *   3. Rebuild pnl_totals + volume_calendar from the refreshed raw data.
 *      (syncAllHistory already calls recomputeAggregates as its final step.)
 *   4. Update leaderboard_tiers.lastRefresh / nextDueAt.
 *
 * Pacing between accounts is minimal — mainnet-backend tolerates our traffic,
 * and concurrency is gated by WORKER_BATCH_CONCURRENCY at the pg-boss level.
 *
 * Logging: emits a one-line summary at the end of every batch with
 * succeeded / failed / skipped counts and total inserted rows. This is the
 * only place the worker shows tier-refresh observability — without it,
 * a B1-class invisible bug (sync runs, inserts nothing) leaves no trace
 * in `docker compose logs`.
 */

import { JOB, type Payloads } from "../job-names";
import { withAccountLock } from "../advisory-lock";
import { syncAllHistory } from "@/lib/history/sync";
import { markTierRefreshed } from "@/lib/history/tier-selector";
import { withRetry, sleep } from "@/lib/util/retry";

const PACING_MS = Number(process.env.WORKER_BATCH_PACING_MS ?? "500");

export async function handleLeaderboardBatch(
  job: { id: string; name: string; data: Payloads[typeof JOB.leaderboardBatch] },
): Promise<void> {
  const { accountIds, wallets, tier } = job.data;
  const t0 = Date.now();
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let totalInserted = 0;

  for (let i = 0; i < accountIds.length; i++) {
    const aid = accountIds[i];
    const wallet = wallets[i];

    const result = await withAccountLock(aid, async () => {
      try {
        // syncAllHistory does the full raw-table refresh AND recomputes
        // pnl_totals + volume_calendar from it (see lib/history/sync.ts).
        const results = await withRetry(
          () => syncAllHistory(aid, wallet),
          2,
          5_000,
          `sync-history ${aid}`,
        );
        await markTierRefreshed(aid);
        // Sum inserted across all sync types for this account so the
        // batch summary reflects how much data actually landed.
        const inserted = results.reduce((sum, r) => sum + (r.inserted ?? 0), 0);
        return { ok: true as const, inserted };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[leaderboard-batch] ${aid} failed: ${msg}`);
        return { ok: false as const };
      }
    });

    if (result === undefined) {
      skipped += 1;
      console.log(`[leaderboard-batch] ${aid} skipped (locked elsewhere)`);
    } else if (result.ok) {
      succeeded += 1;
      totalInserted += result.inserted;
    } else {
      failed += 1;
    }

    if (PACING_MS > 0 && i < accountIds.length - 1) {
      await sleep(PACING_MS);
    }
  }

  const duration = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[leaderboard-batch] tier=${tier} done in ${duration}s — ` +
    `accounts=${accountIds.length} ok=${succeeded} failed=${failed} skipped=${skipped} inserted=${totalInserted}`,
  );
}
