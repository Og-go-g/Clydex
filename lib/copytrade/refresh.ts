/**
 * Leaderboard refresh — legacy entry point.
 *
 * This used to iterate every account in pnl_totals and fetch fresh totals
 * from the 01.xyz frontend API at ~3s/account. That path is now dead weight:
 *
 *   - 01.xyz/api/* sits behind a Vercel WAF JS challenge that blocks all
 *     automated clients.
 *   - The pg-boss worker (Tier 1 every 30 min) handles refresh incrementally
 *     via mainnet-backend.01.xyz + local SQL aggregation.
 *
 * Kept as a thin iterator so anything still calling it (a stray cron route,
 * a debug script) gets the new behaviour: sync raw history from
 * mainnet-backend and rebuild pnl_totals + volume_calendar locally.
 *
 * Prefer enqueuing via pg-boss for production refreshes. This function is
 * only useful for one-off manual re-indexing or scripted backfills.
 */

import { query } from "@/lib/db-history";
import { syncAllHistory } from "@/lib/history/sync";

export interface RefreshResult {
  totalAccounts: number;
  updated: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

const DELAY_BETWEEN_ACCOUNTS_MS = 250;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function refreshAllPnlTotals(
  onProgress?: (done: number, total: number) => void,
): Promise<RefreshResult> {
  const t0 = Date.now();

  const accounts = await query<{ accountId: number; walletAddr: string }>(
    `SELECT DISTINCT "accountId", "walletAddr"
     FROM pnl_totals
     WHERE "walletAddr" NOT LIKE 'account:%'
     ORDER BY "accountId" ASC`,
  );

  const accountList = accounts.length > 0
    ? accounts
    : await query<{ accountId: number; walletAddr: string }>(
        `SELECT DISTINCT "accountId",
                MIN("walletAddr") AS "walletAddr"
         FROM trade_history
         WHERE "walletAddr" NOT LIKE 'account:%'
         GROUP BY "accountId"
         ORDER BY "accountId" ASC`,
      );

  let updated = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < accountList.length; i++) {
    const { accountId, walletAddr } = accountList[i];

    if (!accountId || !walletAddr) {
      skipped++;
      continue;
    }

    try {
      // syncAllHistory pulls incremental raw data from mainnet-backend,
      // then recomputes pnl_totals + volume_calendar from it.
      const results = await syncAllHistory(accountId, walletAddr);
      const hadErrors = results.some((r) => r.error);
      if (hadErrors) {
        failed++;
      } else {
        updated++;
      }
    } catch (err) {
      console.error(`[refreshPnlTotals] account ${accountId} (${walletAddr}) failed:`, err);
      failed++;
    }

    onProgress?.(i + 1, accountList.length);

    if (i < accountList.length - 1) {
      await sleep(DELAY_BETWEEN_ACCOUNTS_MS);
    }
  }

  return {
    totalAccounts: accountList.length,
    updated,
    failed,
    skipped,
    durationMs: Date.now() - t0,
  };
}
