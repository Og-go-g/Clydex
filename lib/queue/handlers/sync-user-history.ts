/**
 * sync-user-history — per-user nightly incremental sync.
 *
 * Fan-out producer (sync-users-enqueuer) enqueues one job per user with a
 * random startAfter 0..4h. This handler runs the full refresh cycle for
 * one account: raw history from mainnet-backend.01.xyz, then aggregate
 * rebuild of pnl_totals + volume_calendar (done inside syncAllHistory).
 *
 * Proxy rotation is no longer needed — mainnet-backend tolerates our
 * traffic and is not WAF-protected, unlike the old 01.xyz frontend API.
 */

import { JOB, type Payloads } from "../job-names";
import { withAccountLock } from "../advisory-lock";
import { syncAllHistory } from "@/lib/history/sync";

export async function handleSyncUserHistory(
  job: { id: string; name: string; data: Payloads[typeof JOB.syncUserHistory] },
): Promise<void> {
  const { walletAddr, accountId } = job.data;

  const result = await withAccountLock(accountId, async () => {
    const results = await syncAllHistory(accountId, walletAddr);
    const total = results.reduce((sum, r) => sum + r.inserted, 0);
    const errors = results.filter((r) => r.error).length;
    console.log(`[sync-user-history] ${walletAddr} inserted=${total} errors=${errors}`);
    return true;
  });

  if (result === undefined) {
    console.log(`[sync-user-history] ${walletAddr} skipped (locked)`);
  }
}
