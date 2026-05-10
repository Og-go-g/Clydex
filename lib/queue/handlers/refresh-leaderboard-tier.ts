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
  // outright; tier 4's nightly cycle (`selectTier4` = NOT IN tier<4)
  // re-picks them up at the right cadence if they still trade. Without
  // this step `upsertTierMembership` never demotes (`LEAST(old,new)`)
  // and stale rows accumulate forever — confirmed in 2026-05-10 prod
  // diagnostic: 3329 dead rows in tier 3, 5 in tier 1, all rolled off.
  // Skip for tier 4 / spot — their selectors are inclusive and treat
  // the table as input, so every row outside the current sample looks
  // orphan and would be nuked.
  if (tier === 1 || tier === 2 || tier === 3) {
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
