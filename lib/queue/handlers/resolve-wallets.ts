/**
 * resolve-wallets — orchestrator (cron every 15 min).
 *
 * After the one-off backfill (scripts/resolve-all-wallets.ts) fills
 * account_pubkey with all known accountIds and propagates placeholder rows,
 * this cron has three jobs:
 *
 *   1. NEW PROFILES
 *      Compare MAX(accountId) in account_pubkey against /accounts/count on
 *      01.xyz. Anything new on-chain gets enqueued for resolution.
 *
 *   2. RETRY 404
 *      notFound=true rows older than 24h — accounts that returned 404 once
 *      may have been created since.
 *
 *   3. STUCK PROPAGATION (self-heal)
 *      An accountId with a resolved pubkey but placeholder rows still lingering
 *      in raw tables — means a previous propagateWallet() rollback'd or the
 *      bulk backfill was skipped. Revisit so the worker propagates again.
 *
 * Batches of 100 → resolve-wallets-batch with priority 2.
 */

import { getBoss } from "../client";
import { JOB, type Payloads } from "../job-names";
import { query } from "@/lib/db-history";
import { fetchAccountsCount } from "@/lib/history/wallet-resolver";
import { chunk } from "@/lib/history/tier-selector";

const BATCH_SIZE = 100;
const RETRY_404_AFTER_HOURS = 24;
const MAX_NEW_IDS = 5000;   // hard cap — protects us from an /accounts/count spike
const MAX_RETRY_404 = 500;
const MAX_STUCK = 1000;

export async function handleResolveWallets(
  _job: { id: string; name: string; data: Payloads[typeof JOB.resolveWallets] },
): Promise<void> {
  // 0. Discover on-chain account count. Soft-fail — if the endpoint hiccups,
  //    we can still process retry404 + stuck this tick.
  let apiCount = 0;
  try {
    apiCount = await fetchAccountsCount();
  } catch (err) {
    console.warn(`[resolve-wallets] /accounts/count failed, skipping newIds:`, err);
  }

  const [{ maxKnown }] = await query<{ maxKnown: number }>(
    `SELECT COALESCE(MAX("accountId"), 0)::int AS "maxKnown" FROM account_pubkey`,
  );

  // 1. New profiles since last pass. Capped to avoid runaway batch counts
  //    if somehow /accounts/count jumps (we'll catch up on subsequent ticks).
  const newIds: number[] = [];
  const from = maxKnown + 1;
  if (apiCount >= from) {
    const upTo = Math.min(apiCount, from + MAX_NEW_IDS - 1);
    for (let i = from; i <= upTo; i++) newIds.push(i);
  }

  // 2. 404 retry. Accounts that didn't exist when we first looked — give
  //    them another chance after 24h in case they've since been created.
  const retryRows = await query<{ accountId: number }>(
    `SELECT "accountId" FROM account_pubkey
     WHERE "notFound" = TRUE
       AND "lastCheckedAt" < NOW() - ($1 || ' hours')::interval
     ORDER BY "lastCheckedAt" ASC
     LIMIT $2`,
    [String(RETRY_404_AFTER_HOURS), MAX_RETRY_404],
  );

  // 3. Self-heal: resolved pubkey exists but placeholder rows still sit in
  //    pnl_history / trade_history / pnl_totals. Means propagation lost a
  //    race earlier (or the bulk backfill wasn't run). Worker re-propagates.
  const stuckRows = await query<{ accountId: number }>(
    `SELECT ap."accountId"
     FROM account_pubkey ap
     WHERE ap.pubkey IS NOT NULL
       AND (
         EXISTS (SELECT 1 FROM pnl_history
                 WHERE "accountId" = ap."accountId"
                   AND "walletAddr" LIKE 'account:%')
         OR EXISTS (SELECT 1 FROM trade_history
                    WHERE "accountId" = ap."accountId"
                      AND "walletAddr" LIKE 'account:%')
         OR EXISTS (SELECT 1 FROM pnl_totals
                    WHERE "accountId" = ap."accountId"
                      AND "walletAddr" LIKE 'account:%')
       )
     LIMIT $1`,
    [MAX_STUCK],
  );

  const merged = new Set<number>([
    ...newIds,
    ...retryRows.map((r) => r.accountId),
    ...stuckRows.map((r) => r.accountId),
  ]);

  if (merged.size === 0) {
    console.log(
      `[resolve-wallets] nothing to do (apiCount=${apiCount} maxKnown=${maxKnown})`,
    );
    return;
  }

  const ids = Array.from(merged).sort((a, b) => a - b);
  const batches = chunk(ids, BATCH_SIZE);

  const boss = await getBoss();
  const uniqueId = Date.now();
  for (let i = 0; i < batches.length; i++) {
    await boss.send(
      JOB.resolveWalletsBatch,
      { accountIds: batches[i] },
      {
        priority: 2,
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        expireInSeconds: 20 * 60,
        singletonKey: `resolve-wallets-${uniqueId}-${i}`,
      },
    );
  }

  console.log(
    `[resolve-wallets] enqueued ${batches.length} batches (${ids.length} accounts: ` +
    `new=${newIds.length}, retry404=${retryRows.length}, stuck=${stuckRows.length}) ` +
    `apiCount=${apiCount} maxKnown=${maxKnown}`,
  );
}
