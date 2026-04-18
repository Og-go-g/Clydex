/**
 * leaderboard-batch — processes a batch of accounts.
 * For each: lock, fetch pnl-totals + volume-calendar via proxy, mark refreshed, unlock.
 */

import { JOB, type Payloads } from "../job-names";
import { withAccountLock } from "../advisory-lock";
import { syncPnlTotals, syncVolumeCalendar } from "@/lib/history/sync";
import { nextProxyAgent, type FetchContext } from "@/lib/history/fetch-context";
import { markTierRefreshed } from "@/lib/history/tier-selector";
import { withRetry, sleep } from "@/lib/util/retry";

const WAF_PACING_MS = 3000;

export async function handleLeaderboardBatch(
  job: { id: string; name: string; data: Payloads[typeof JOB.leaderboardBatch] },
): Promise<void> {
  const { accountIds, wallets } = job.data;

  for (let i = 0; i < accountIds.length; i++) {
    const aid = accountIds[i];
    const wallet = wallets[i];

    const result = await withAccountLock(aid, async () => {
      const ctx: FetchContext = {
        agent: nextProxyAgent(),
        postDelayMs: 0, // we do pacing between accounts, not between calls
        label: `lb-batch-${aid}`,
      };

      try {
        await withRetry(
          () => syncPnlTotals(aid, wallet, ctx),
          2,
          5000,
          `pnl-totals ${aid}`,
        );
        await withRetry(
          () => syncVolumeCalendar(aid, wallet, ctx),
          2,
          5000,
          `vol-cal ${aid}`,
        );
        await markTierRefreshed(aid);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[leaderboard-batch] ${aid} failed: ${msg}`);
        return false;
      }
    });

    if (result === undefined) {
      // Lock not acquired — another worker has this account
      console.log(`[leaderboard-batch] ${aid} skipped (locked elsewhere)`);
    }

    // Pace between accounts regardless of success
    if (i < accountIds.length - 1) {
      await sleep(WAF_PACING_MS);
    }
  }
}
