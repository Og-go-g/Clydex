/**
 * Register all job handlers with pg-boss.
 *
 * pg-boss v12: handler receives Job<T>[] (array, even when batchSize=1).
 * We process sequentially inside each handler invocation; concurrency is
 * controlled via localConcurrency option (N pollers running in parallel).
 */

import type { PgBoss } from "pg-boss";
import { JOB, TIER_IDS, tierScheduleName, type Payloads } from "../job-names";
import { handleRefreshTier } from "./refresh-leaderboard-tier";
import { handleLeaderboardBatch } from "./leaderboard-batch";
import { handleSyncUserHistory } from "./sync-user-history";
import { handleOnDemandRefresh } from "./on-demand-refresh";
import { handleSyncUsersEnqueuer } from "./sync-users-enqueuer";
import { handleResolveWallets } from "./resolve-wallets";
import { handleResolveWalletsBatch } from "./resolve-wallets-batch";
import { handleCopyEngineTick } from "./copy-engine-tick";

const BATCH_CONCURRENCY = Number(process.env.WORKER_BATCH_CONCURRENCY || "5");
const RESOLVE_CONCURRENCY = Number(process.env.RESOLVE_WALLETS_CONCURRENCY || "3");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyJob<T = any> = { id: string; name: string; data: T };

export async function registerHandlers(boss: PgBoss): Promise<void> {
  // Tier orchestrator — one queue per tier (pg-boss v12 schedules are
  // keyed by queue name, see `tierScheduleName` rationale in job-names.ts).
  // All five queues route to the same `handleRefreshTier`, which reads
  // `data.tier` to do the right thing.
  for (const tier of TIER_IDS) {
    await boss.work<Payloads[typeof JOB.refreshTier]>(
      tierScheduleName(tier),
      { localConcurrency: 1 },
      async (jobs) => {
        for (const j of jobs) {
          await handleRefreshTier(j as AnyJob<Payloads[typeof JOB.refreshTier]>);
        }
      },
    );
  }

  // Batch workers — N parallel (one per proxy slot)
  await boss.work<Payloads[typeof JOB.leaderboardBatch]>(
    JOB.leaderboardBatch,
    { localConcurrency: BATCH_CONCURRENCY },
    async (jobs) => {
      for (const j of jobs) {
        await handleLeaderboardBatch(j as AnyJob<Payloads[typeof JOB.leaderboardBatch]>);
      }
    },
  );

  // Per-user sync
  await boss.work<Payloads[typeof JOB.syncUserHistory]>(
    JOB.syncUserHistory,
    { localConcurrency: 2 },
    async (jobs) => {
      for (const j of jobs) {
        await handleSyncUserHistory(j as AnyJob<Payloads[typeof JOB.syncUserHistory]>);
      }
    },
  );

  // On-demand — highest priority
  await boss.work<Payloads[typeof JOB.onDemandRefresh]>(
    JOB.onDemandRefresh,
    { localConcurrency: 5 },
    async (jobs) => {
      for (const j of jobs) {
        await handleOnDemandRefresh(j as AnyJob<Payloads[typeof JOB.onDemandRefresh]>);
      }
    },
  );

  // Nightly fan-out
  await boss.work<Payloads[typeof JOB.syncUsersEnqueuer]>(
    JOB.syncUsersEnqueuer,
    { localConcurrency: 1 },
    async (jobs) => {
      for (const j of jobs) {
        await handleSyncUsersEnqueuer(j as AnyJob<Payloads[typeof JOB.syncUsersEnqueuer]>);
      }
    },
  );

  // Wallet resolver — orchestrator (one at a time)
  await boss.work<Payloads[typeof JOB.resolveWallets]>(
    JOB.resolveWallets,
    { localConcurrency: 1 },
    async (jobs) => {
      for (const j of jobs) {
        await handleResolveWallets(j as AnyJob<Payloads[typeof JOB.resolveWallets]>);
      }
    },
  );

  // Wallet resolver — batch workers
  await boss.work<Payloads[typeof JOB.resolveWalletsBatch]>(
    JOB.resolveWalletsBatch,
    { localConcurrency: RESOLVE_CONCURRENCY },
    async (jobs) => {
      for (const j of jobs) {
        await handleResolveWalletsBatch(j as AnyJob<Payloads[typeof JOB.resolveWalletsBatch]>);
      }
    },
  );

  // Copy trading engine — 1 job/min, each runs 4 x 15s cycles
  await boss.work<Payloads[typeof JOB.copyEngineTick]>(
    JOB.copyEngineTick,
    { localConcurrency: 1 },
    async (jobs) => {
      for (const j of jobs) {
        await handleCopyEngineTick(j as AnyJob<Payloads[typeof JOB.copyEngineTick]>);
      }
    },
  );

  console.log(
    `[worker] handlers registered (batch concurrency: ${BATCH_CONCURRENCY}, ` +
    `resolve concurrency: ${RESOLVE_CONCURRENCY})`,
  );
}
