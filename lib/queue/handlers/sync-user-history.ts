/**
 * sync-user-history — per-user incremental sync.
 * Called from sync-users-enqueuer nightly. Uses proxy + advisory lock.
 */

import { JOB, type Payloads } from "../job-names";
import { withAccountLock } from "../advisory-lock";
import { syncAllHistory } from "@/lib/history/sync";
import { nextProxyAgent, type FetchContext } from "@/lib/history/fetch-context";

export async function handleSyncUserHistory(
  job: { id: string; name: string; data: Payloads[typeof JOB.syncUserHistory] },
): Promise<void> {
  const { walletAddr, accountId } = job.data;

  const result = await withAccountLock(accountId, async () => {
    const ctx: FetchContext = {
      agent: nextProxyAgent(),
      postDelayMs: 0,
      label: `user-sync-${walletAddr}`,
    };

    const results = await syncAllHistory(accountId, walletAddr, undefined, ctx);
    const total = results.reduce((sum, r) => sum + r.inserted, 0);
    const errors = results.filter((r) => r.error).length;
    console.log(`[sync-user-history] ${walletAddr} inserted=${total} errors=${errors}`);
    return true;
  });

  if (result === undefined) {
    console.log(`[sync-user-history] ${walletAddr} skipped (locked)`);
  }
}
