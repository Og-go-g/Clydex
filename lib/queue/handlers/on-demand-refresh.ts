/**
 * on-demand-refresh — high priority single account refresh.
 * Triggered from API routes when user opens profile or clicks Copy.
 */

import { JOB, type Payloads } from "../job-names";
import { withAccountLock } from "../advisory-lock";
import { syncPnlTotals, syncVolumeCalendar } from "@/lib/history/sync";
import { nextProxyAgent, type FetchContext } from "@/lib/history/fetch-context";
import { markTierRefreshed } from "@/lib/history/tier-selector";

export async function handleOnDemandRefresh(
  job: { id: string; name: string; data: Payloads[typeof JOB.onDemandRefresh] },
): Promise<void> {
  const { accountId, walletAddr } = job.data;

  const result = await withAccountLock(accountId, async () => {
    const ctx: FetchContext = {
      agent: nextProxyAgent(),
      postDelayMs: 1000,
      label: `on-demand-${accountId}`,
    };

    await syncPnlTotals(accountId, walletAddr, ctx);
    await syncVolumeCalendar(accountId, walletAddr, ctx);
    await markTierRefreshed(accountId);
    return true;
  });

  if (result === undefined) {
    console.log(`[on-demand-refresh] ${accountId} skipped (scheduled refresh in progress)`);
  }
}
