/**
 * on-demand-refresh — high-priority single-account refresh.
 *
 * Triggered from API routes when a user opens a profile or clicks Copy.
 * Does the same work as leaderboard-batch but for exactly one account,
 * with no pacing (priority 10 in the queue ordering).
 *
 * If the scheduled tier job already holds the advisory lock, we skip —
 * the user will see fresh data once the scheduled refresh finishes.
 */

import { JOB, type Payloads } from "../job-names";
import { withAccountLock } from "../advisory-lock";
import { syncAllHistory } from "@/lib/history/sync";
import { markTierRefreshed } from "@/lib/history/tier-selector";

export async function handleOnDemandRefresh(
  job: { id: string; name: string; data: Payloads[typeof JOB.onDemandRefresh] },
): Promise<void> {
  const { accountId, walletAddr } = job.data;

  const result = await withAccountLock(accountId, async () => {
    await syncAllHistory(accountId, walletAddr);
    await markTierRefreshed(accountId);
    return true;
  });

  if (result === undefined) {
    console.log(`[on-demand-refresh] ${accountId} skipped (scheduled refresh in progress)`);
  }
}
