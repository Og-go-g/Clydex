/**
 * resolve-wallets-batch — worker.
 *
 * Per accountId:
 *   1. GET /account/{id}/pubkey on 01.xyz mainnet backend.
 *   2. Record resolution outcome in account_pubkey (resolved | notFound | failure).
 *   3. Decide downstream action based on DB state:
 *        placeholder rows exist  → propagate walletAddr across history tables
 *        no history at all       → enqueue sync-user-history for first-time sync
 *        already real-wallet     → skip (healthy state)
 *
 * All three decisions are idempotent: they read the current DB state, so
 * retrying after partial failure always converges.
 *
 * Advisory lock prevents concurrent leaderboard-batch / sync-user-history
 * from racing us on the same accountId.
 */

import { getBoss } from "../client";
import { JOB, type Payloads } from "../job-names";
import { withAccountLock } from "../advisory-lock";
import {
  fetchPubkey,
  recordResolved,
  recordNotFound,
  recordFailure,
  propagateWallet,
} from "@/lib/history/wallet-resolver";
import { sleep } from "@/lib/util/retry";
import { query } from "@/lib/db-history";

const PACING_MS = Number(process.env.RESOLVE_WALLETS_PACING_MS ?? "50");

type PostResolveState = "placeholder" | "empty" | "synced";

async function classifyAccount(accountId: number): Promise<PostResolveState> {
  const [{ placeholder, hasAny }] = await query<{
    placeholder: boolean;
    hasAny: boolean;
  }>(
    `SELECT
       (EXISTS (SELECT 1 FROM pnl_history
                WHERE "accountId" = $1 AND "walletAddr" LIKE 'account:%')
        OR EXISTS (SELECT 1 FROM trade_history
                   WHERE "accountId" = $1 AND "walletAddr" LIKE 'account:%')
        OR EXISTS (SELECT 1 FROM pnl_totals
                   WHERE "accountId" = $1 AND "walletAddr" LIKE 'account:%'))
         AS placeholder,
       (EXISTS (SELECT 1 FROM pnl_history   WHERE "accountId" = $1)
        OR EXISTS (SELECT 1 FROM trade_history WHERE "accountId" = $1))
         AS "hasAny"`,
    [accountId],
  );

  if (placeholder) return "placeholder";
  if (!hasAny) return "empty";
  return "synced";
}

export async function handleResolveWalletsBatch(
  job: { id: string; name: string; data: Payloads[typeof JOB.resolveWalletsBatch] },
): Promise<void> {
  const { accountIds } = job.data;
  let resolved = 0;
  let notFound = 0;
  let failed = 0;
  let propagated = 0;
  let syncEnqueued = 0;

  const boss = await getBoss();

  for (let i = 0; i < accountIds.length; i++) {
    const id = accountIds[i];

    await withAccountLock(id, async () => {
      try {
        const result = await fetchPubkey(id);

        if (result.notFound) {
          await recordNotFound(id);
          notFound++;
          return;
        }

        const pubkey = result.pubkey!;
        await recordResolved(id, pubkey);
        resolved++;

        const state = await classifyAccount(id);

        if (state === "placeholder") {
          // Existing history under `account:<id>` — rewrite to real wallet.
          const r = await propagateWallet(id, pubkey);
          propagated++;
          console.log(
            `[resolve-wallets-batch] ${id} → ${pubkey.slice(0, 8)}… propagated ` +
            `updated=${JSON.stringify(r.tablesUpdated)} cleaned=${JSON.stringify(r.tablesCleaned)}`,
          );
          return;
        }

        if (state === "empty") {
          // Brand-new account on-chain, no history ever pulled. Enqueue a
          // first-time sync under the real wallet. Tier-4 will pick it up
          // on the next nightly pass once pnl_totals has a row.
          await boss.send(
            JOB.syncUserHistory,
            { walletAddr: pubkey, accountId: id },
            {
              priority: 3,
              retryLimit: 3,
              retryDelay: 120,
              retryBackoff: true,
              expireInSeconds: 30 * 60,
              singletonKey: `user-sync-${pubkey}`,
              singletonSeconds: 12 * 3600,
            },
          );
          syncEnqueued++;
          return;
        }

        // state === "synced" — nothing to do, wallet already real.
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[resolve-wallets-batch] ${id} failed: ${msg}`);
        await recordFailure(id);
        failed++;
      }
    });

    if (PACING_MS > 0 && i < accountIds.length - 1) {
      await sleep(PACING_MS);
    }
  }

  console.log(
    `[resolve-wallets-batch] done: resolved=${resolved} notFound=${notFound} ` +
    `failed=${failed} propagated=${propagated} syncEnqueued=${syncEnqueued} ` +
    `(total=${accountIds.length})`,
  );
}
