/**
 * refresh-leaderboard-tier — orchestrator job.
 * Selects accounts for the tier, updates membership, enqueues leaderboard-batch jobs.
 */

import { getBoss } from "../client";
import { JOB, tierPriority, type Payloads } from "../job-names";
import {
  selectAccountsForTier,
  upsertTierMembership,
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
