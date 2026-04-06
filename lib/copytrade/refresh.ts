import { query } from "@/lib/db-history";
import { syncPnlTotals, syncVolumeCalendar } from "@/lib/history/sync";

// ─── Types ──────────────────────────────────────────────────────

export interface RefreshResult {
  totalAccounts: number;
  updated: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

// ─── Rate limiting ──────────────────────────────────────────────

const DELAY_BETWEEN_ACCOUNTS_MS = 3_000; // 01.xyz WAF needs ~3s between calls

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Refresh all pnl_totals from 01.xyz API ─────────────────────
//
// Iterates all unique (accountId, walletAddr) pairs in trade_history,
// fetches fresh pnl-totals from 01.xyz frontend API, upserts into DB.
// Skips account:* entries (not real wallets, can't query pnl-totals).
//
// Rate limited at 3s per account (01.xyz WAF).
// For 100 accounts = ~5 min. For 1000 = ~50 min.

export async function refreshAllPnlTotals(
  onProgress?: (done: number, total: number) => void,
): Promise<RefreshResult> {
  const t0 = Date.now();

  // Get distinct accounts that have trades (skip account:* keys)
  const accounts = await query<{ accountId: number; walletAddr: string }>(
    `SELECT DISTINCT "accountId", "walletAddr"
     FROM pnl_totals
     WHERE "walletAddr" NOT LIKE 'account:%'
     ORDER BY "accountId" ASC`,
  );

  // If pnl_totals is empty, fall back to trade_history accounts
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

    // Skip invalid entries
    if (!accountId || !walletAddr) {
      skipped++;
      continue;
    }

    try {
      const [pnlOk, volCount] = await Promise.all([
        syncPnlTotals(accountId, walletAddr),
        syncVolumeCalendar(accountId, walletAddr),
      ]);

      if (pnlOk) {
        updated++;
      } else {
        failed++;
      }
    } catch (err) {
      console.error(`[refreshPnlTotals] account ${accountId} (${walletAddr}) failed:`, err);
      failed++;
    }

    onProgress?.(i + 1, accountList.length);

    // Rate limit between accounts (01.xyz WAF)
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
