/**
 * refresh-leaderboard-tier — orchestrator job.
 * Selects accounts for the tier, updates membership, enqueues leaderboard-batch jobs.
 */

import { getBoss } from "../client";
import { JOB, tierPriority, type Payloads } from "../job-names";
import {
  selectAccountsForTier,
  upsertTierMembership,
  deleteTierOrphans,
  chunk,
} from "@/lib/history/tier-selector";
import { getActiveLeaders } from "@/lib/copy/queries";

const BATCH_SIZE = 20;

export async function handleRefreshTier(
  job: { id: string; name: string; data: Payloads[typeof JOB.refreshTier] },
): Promise<void> {
  const { tier } = job.data;
  console.log(`[refresh-tier] tier=${tier} starting`);

  // Tier 1 needs copy trading leaders from history DB (copy_subscriptions lives there)
  let copyLeaders: string[] = [];
  if (tier === 1) {
    try {
      copyLeaders = await getActiveLeaders();
    } catch (err) {
      console.warn(`[refresh-tier] failed to load copy leaders:`, err);
    }
  }

  const accounts = await selectAccountsForTier(tier, copyLeaders);
  if (accounts.length === 0) {
    console.log(`[refresh-tier] tier=${tier} has no accounts`);
    return;
  }

  // Persist tier membership so ranking is stable
  const tierNum = typeof tier === "number" ? tier : 4;
  await upsertTierMembership(accounts, tierNum);

  // Demote rolloff orphans — accounts that were tier=N from a previous
  // cycle but no longer meet the tier's criteria today. We delete them
  // outright; if they're still active they re-land in the right tier on
  // the next cycle. Without this step `upsertTierMembership` never
  // demotes (`LEAST(old,new)`) and stale rows accumulate forever.
  //
  // Apply for every numeric tier (1–4) — `selectTier4` reads from
  // `pnl_totals`, not from `leaderboard_tiers`, so deleting orphans
  // from tier 4 only removes accounts that no longer exist in
  // pnl_totals (e.g. ghost rows left behind by a wallet-resolver run
  // that didn't propagate to pnl_totals — 2026-05-10 found 133 such
  // rows in tier 4 with `lastRefresh` stuck on deploy day).
  //
  // Skip ONLY for "spot": its selector samples 500 random rows FROM
  // `leaderboard_tiers WHERE tier=4`, so every row outside the random
  // sample would look orphan and get nuked.
  if (typeof tier === "number") {
    const orphans = await deleteTierOrphans(
      tier,
      accounts.map((a) => a.accountId),
    );
    if (orphans > 0) {
      console.log(`[refresh-tier] tier=${tier} demoted ${orphans} rolloff orphans`);
    }
  }

  const batches = chunk(accounts, BATCH_SIZE);
  const boss = await getBoss();
  const priority = tierPriority(tier);

  const uniqueId = Date.now();
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    await boss.send(JOB.leaderboardBatch, {
      accountIds: b.map((x) => x.accountId),
      wallets:    b.map((x) => x.walletAddr),
      tier: tierNum,
    }, {
      priority,
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 15 * 60,
      singletonKey: `lbbatch-t${tierNum}-${uniqueId}-${i}`,
    });
  }

  console.log(`[refresh-tier] tier=${tier} enqueued ${batches.length} batches (${accounts.length} accounts)`);
}
