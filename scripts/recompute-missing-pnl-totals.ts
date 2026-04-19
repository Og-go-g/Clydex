/**
 * One-off: recompute pnl_totals + volume_calendar for accounts that have
 * raw pnl_history/trade_history rows but no pnl_totals row.
 *
 * Root cause: sql/2026-04-18_propagate_wallets.sql UPDATE'd walletAddr
 * across raw tables but only UPDATED existing pnl_totals rows. Accounts
 * that had placeholder raw history AND no prior pnl_totals row (common
 * for bulk-synced accounts that never went through the tier pipeline)
 * ended up with pnl_history but no aggregate.
 *
 * Tier-4 selector reads from pnl_totals → these accounts are invisible
 * to the refresh pipeline. This script materializes them once.
 *
 * Future-proof: wallet-resolver.ts propagateWallet now calls
 * recomputeAggregates inline after a propagation, so new accounts won't
 * end up in this state.
 *
 * Usage:
 *   docker compose exec -T worker npx tsx /app/scripts/recompute-missing-pnl-totals.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { historyPool } from "@/lib/db-history";
import { recomputeAggregates } from "@/lib/history/aggregate";
import { ensureMarketCache } from "@/lib/n1/constants";

async function main(): Promise<void> {
  await ensureMarketCache();

  const { rows } = await historyPool.query<{ accountId: number; walletAddr: string }>(
    // Union both raw sources: an account is eligible for pnl_totals if it
    // has pnl_history (closed positions) OR funding_history (open positions
    // accruing funding). The original query only covered pnl_history, so
    // funding-only accounts were missed and stayed invisible to Tier-4.
    `WITH active AS (
       SELECT DISTINCT "accountId" FROM pnl_history
       UNION
       SELECT DISTINCT "accountId" FROM funding_history
     )
     SELECT a."accountId", ap.pubkey AS "walletAddr"
     FROM active a
     JOIN account_pubkey ap ON ap."accountId" = a."accountId"
     WHERE ap.pubkey IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM pnl_totals pt WHERE pt."accountId" = a."accountId"
       )
     ORDER BY a."accountId"`,
  );

  if (rows.length === 0) {
    console.log("[recompute] nothing to do — all pnl_history accounts have pnl_totals");
    await historyPool.end();
    return;
  }

  console.log(`[recompute] ${rows.length} accounts need aggregates built`);
  const start = Date.now();
  let done = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await recomputeAggregates(row.accountId, row.walletAddr);
      done++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ${row.accountId} failed: ${msg}`);
    }

    if (done % 50 === 0 || done === rows.length) {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const rate = done / Math.max(elapsed, 1);
      const eta = Math.floor((rows.length - done) / Math.max(rate, 0.1));
      console.log(
        `  ${done}/${rows.length} done, ${failed} failed, ${rate.toFixed(1)}/s, ETA ${eta}s`,
      );
    }
  }

  const elapsed = Math.floor((Date.now() - start) / 1000);
  console.log(`[recompute] done in ${elapsed}s: ${done} success, ${failed} failed`);

  await historyPool.end();
}

main().catch((err) => {
  console.error("[recompute] fatal:", err);
  process.exit(1);
});
