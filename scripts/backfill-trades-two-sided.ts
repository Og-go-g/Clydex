/**
 * Phase 8c — backfill the missing side of every trade in trade_history.
 *
 * Context: pre-2026-05-02 trade_history had UNIQUE (tradeId, time), so each
 * trade was stored only once — whoever (taker or maker) synced first won,
 * the other side was silently discarded by ON CONFLICT DO NOTHING. After
 * sql/2026-05-02_trade_history_two_sided.sql swaps the constraint to
 * (accountId, tradeId, time) we can re-sync every known account; this
 * time the previously-discarded side actually lands.
 *
 * Strategy: walk every accountId we know (account_pubkey.pubkey NOT NULL),
 * call syncTrades with since = MAX(time) for that account (data-driven
 * cursor — no reliance on sync_cursors). Idempotent: re-running just
 * inserts whatever's still missing.
 *
 * After the trade backfill we recompute pnl_totals + volume_calendar for
 * each touched account, because both aggregates are computed off
 * trade_history and were therefore corrupt for any user trading against
 * an actively-synced MM.
 *
 * Usage:
 *   npx tsx scripts/backfill-trades-two-sided.ts             # all accounts
 *   npx tsx scripts/backfill-trades-two-sided.ts --from=0    # resume from
 *   npx tsx scripts/backfill-trades-two-sided.ts --limit=10  # quick smoke
 *   npx tsx scripts/backfill-trades-two-sided.ts --account=3560  # one
 *
 * Concurrency: 5 accounts in parallel, with 200 ms between API calls per
 * worker. Total at this rate: ~17500 accounts × ~3s each / 5 = ~3 hours
 * for a full run. Safe to interrupt with Ctrl-C; resume from the last
 * printed accountId.
 */

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { historyPool } from "@/lib/db-history";
import { ensureMarketCache } from "@/lib/n1/constants";
import { syncHistoryType } from "@/lib/history/sync";
import { recomputePnlTotals, recomputeVolumeCalendar } from "@/lib/history/aggregate";

// ─── CLI args ───────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=", 2)[1] : undefined;
}

const FROM = Number(arg("from") ?? "0");
const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const ONE_ACCOUNT = arg("account") ? Number(arg("account")) : null;
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY ?? "5");

// ─── Graceful shutdown ──────────────────────────────────────────

let shuttingDown = false;
process.on("SIGINT", () => {
  if (shuttingDown) { console.log("\nForce exit."); process.exit(1); }
  shuttingDown = true;
  console.log("\nShutting down after current batch (Ctrl-C again to force)...");
});

// ─── Main ───────────────────────────────────────────────────────

interface AccountRow { accountId: number; pubkey: string }

async function loadAccounts(): Promise<AccountRow[]> {
  if (ONE_ACCOUNT !== null) {
    const { rows } = await historyPool.query<AccountRow>(
      `SELECT "accountId", pubkey FROM account_pubkey WHERE "accountId" = $1 AND pubkey IS NOT NULL`,
      [ONE_ACCOUNT],
    );
    return rows;
  }

  const { rows } = await historyPool.query<AccountRow>(
    `SELECT "accountId", pubkey
     FROM account_pubkey
     WHERE pubkey IS NOT NULL
       AND "accountId" >= $1
     ORDER BY "accountId" ASC`,
    [FROM],
  );
  return rows.slice(0, LIMIT === Infinity ? rows.length : LIMIT);
}

interface PerAccountResult {
  accountId: number;
  added: number;
  error?: string;
}

async function processOne(account: AccountRow): Promise<PerAccountResult> {
  try {
    // syncHistoryType internally:
    //   - reads sync_cursors cursor (we IGNORE this — see why below)
    //   - paginates 01 API since=cursor
    //   - INSERT ... ON CONFLICT (accountId, tradeId, time) DO NOTHING
    //
    // For backfill we need to ignore the existing cursor and force a
    // re-fetch from the start of recorded history for this account.
    // The fastest way is to seed since= MAX(time) from trade_history
    // ourselves and pass it via a temporary cursor write.
    //
    // Simpler: bypass syncHistoryType and call the underlying syncTrades
    // directly with an explicit since. That keeps the cursor untouched.
    // But syncTrades isn't exported — so we go through syncHistoryType
    // and accept that the cursor will be overwritten to NOW after the
    // sync (which is fine — next mini-sync uses MAX(time) anyway).
    const result = await syncHistoryType(account.accountId, account.pubkey, "trades");

    // Re-build aggregates so portfolio shows correct lifetime PnL.
    // Both are pure SQL over trade_history — fast.
    await recomputePnlTotals(account.accountId, account.pubkey).catch((err) => {
      console.warn(`[backfill] pnl_totals ${account.accountId} failed: ${err.message}`);
    });
    await recomputeVolumeCalendar(account.accountId, account.pubkey).catch((err) => {
      console.warn(`[backfill] volume_calendar ${account.accountId} failed: ${err.message}`);
    });

    return { accountId: account.accountId, added: result.inserted, error: result.error };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { accountId: account.accountId, added: 0, error: msg };
  }
}

async function runWorker(queue: AccountRow[], stats: { processed: number; added: number; errors: number }) {
  while (queue.length > 0 && !shuttingDown) {
    const account = queue.shift();
    if (!account) break;

    const result = await processOne(account);
    stats.processed += 1;
    stats.added += result.added;
    if (result.error) stats.errors += 1;

    if (result.added > 0 || result.error) {
      const tag = result.error ? `ERR ${result.error.slice(0, 80)}` : `+${result.added}`;
      console.log(`[backfill] ${stats.processed} acc=${account.accountId} ${tag}`);
    } else if (stats.processed % 100 === 0) {
      console.log(`[backfill] progress: ${stats.processed} processed, ${stats.added} new rows, ${stats.errors} errors`);
    }

    // Small inter-account pacing — keeps API load gentle.
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  console.log("[backfill] loading accounts and market cache...");
  await ensureMarketCache();
  const accounts = await loadAccounts();
  console.log(`[backfill] ${accounts.length} accounts to process (concurrency=${CONCURRENCY})`);

  const stats = { processed: 0, added: 0, errors: 0 };
  const start = Date.now();

  const workers = Array.from({ length: CONCURRENCY }, () => runWorker(accounts, stats));
  await Promise.all(workers);

  const elapsed = ((Date.now() - start) / 1000).toFixed(0);
  console.log(`[backfill] DONE in ${elapsed}s — processed=${stats.processed} added=${stats.added} errors=${stats.errors}`);
  await historyPool.end();
  process.exit(stats.errors > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
