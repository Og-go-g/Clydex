/**
 * One-off wallet resolver + propagator.
 *
 * Walks account IDs [1 … /accounts/count], resolves each via
 * GET /account/{id}/pubkey on 01.xyz mainnet backend, populates the
 * account_pubkey table, then runs one SQL pass that rewrites the
 * placeholder `account:<id>` walletAddr across all history tables using
 * the canonical mapping.
 *
 * Two-phase design beats per-account propagation here: the bulk 17838
 * placeholder-only accounts already exist in raw tables, and a single
 * JOIN-driven UPDATE is orders of magnitude faster than 17838 transactions.
 *
 * Usage:
 *   npx tsx scripts/resolve-all-wallets.ts                  # full pass
 *   npx tsx scripts/resolve-all-wallets.ts --from=5000      # resume
 *   npx tsx scripts/resolve-all-wallets.ts --skip-propagate # resolve only
 *   npx tsx scripts/resolve-all-wallets.ts --skip-fetch     # propagate only
 *
 * Environment:
 *   HISTORY_DATABASE_URL    — required
 *   RESOLVE_CONCURRENCY     — parallel API calls (default 5)
 *   RESOLVE_PACING_MS       — delay between requests per worker (default 50)
 */

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { historyPool } from "@/lib/db-history";
import {
  fetchPubkey,
  fetchAccountsCount,
  recordResolved,
  recordNotFound,
  recordFailure,
} from "@/lib/history/wallet-resolver";

const CONCURRENCY = Number(process.env.RESOLVE_CONCURRENCY || "5");
const PACING_MS = Number(process.env.RESOLVE_PACING_MS || "50");
const FROM_ID = Number(process.argv.find((a) => a.startsWith("--from="))?.split("=")[1] || "1");
const TO_ARG = process.argv.find((a) => a.startsWith("--to="))?.split("=")[1];
const SKIP_FETCH = process.argv.includes("--skip-fetch");
const SKIP_PROPAGATE = process.argv.includes("--skip-propagate");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bar(cur: number, tot: number, w = 30): string {
  const pct = tot > 0 ? cur / tot : 0;
  const f = Math.round(pct * w);
  return `[${"█".repeat(f)}${"░".repeat(w - f)}] ${(pct * 100).toFixed(1)}%`;
}

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// ───────────────────────── Phase 1: fetch pubkeys ─────────────────────────

async function resolveOne(id: number): Promise<"resolved" | "notFound" | "failed"> {
  try {
    const r = await fetchPubkey(id);
    if (r.notFound) {
      await recordNotFound(id);
      return "notFound";
    }
    await recordResolved(id, r.pubkey!);
    return "resolved";
  } catch {
    await recordFailure(id);
    return "failed";
  }
}

async function fetchPhase(toId: number): Promise<void> {
  // Skip IDs already resolved non-stale. Still retry notFound after 24h.
  const skipRows = await historyPool.query<{ accountId: number }>(
    `SELECT "accountId" FROM account_pubkey
     WHERE pubkey IS NOT NULL OR ("notFound" = TRUE AND "lastCheckedAt" > NOW() - interval '24 hours')`,
  );
  const skip = new Set<number>(skipRows.rows.map((r) => r.accountId));

  const queue: number[] = [];
  for (let i = FROM_ID; i <= toId; i++) {
    if (!skip.has(i)) queue.push(i);
  }

  const total = queue.length;
  if (total === 0) {
    console.log(`[phase 1] nothing to resolve in range [${FROM_ID}…${toId}]`);
    return;
  }

  console.log(`[phase 1] resolving ${total} accounts (${CONCURRENCY} workers, ${PACING_MS}ms pacing)`);
  const start = Date.now();
  const counters = { resolved: 0, notFound: 0, failed: 0 };
  let next = 0;

  const progressTimer = setInterval(() => {
    const done = counters.resolved + counters.notFound + counters.failed;
    const ms = Date.now() - start;
    const rate = done > 0 ? done / (ms / 1000) : 0;
    const eta = rate > 0 ? Math.floor((total - done) / rate) : 0;
    process.stdout.write(
      `\r  ${bar(done, total)} ${done}/${total} | ` +
      `resolved=${counters.resolved} 404=${counters.notFound} failed=${counters.failed} | ` +
      `${rate.toFixed(1)}/s | ETA ${elapsed(eta * 1000)}        `,
    );
  }, 500);

  async function worker() {
    while (next < queue.length) {
      const idx = next++;
      if (idx >= queue.length) break;
      const id = queue[idx];
      const result = await resolveOne(id);
      counters[result]++;
      if (PACING_MS > 0) await sleep(PACING_MS);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  clearInterval(progressTimer);

  console.log(
    `\n[phase 1] done in ${elapsed(Date.now() - start)} — ` +
    `resolved=${counters.resolved} notFound=${counters.notFound} failed=${counters.failed}`,
  );
}

// ─────────────────────── Phase 2: SQL-only propagation ──────────────────────
//
// Runs the same delete-twin + update strategy as the consolidation migration
// but driven by account_pubkey instead of a temp table built from raw tables.
// One transaction, JOINs against account_pubkey — orders of magnitude faster
// than calling propagateWallet() per accountId.

async function propagatePhase(): Promise<void> {
  console.log(`[phase 2] propagating walletAddr from account_pubkey across history tables`);
  const start = Date.now();
  const client = await historyPool.connect();

  try {
    await client.query("BEGIN");

    const report: Record<string, { updated: number; deleted: number }> = {};

    // Accounts to act on — those with a resolved pubkey.
    const eligibleCountRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM account_pubkey WHERE pubkey IS NOT NULL`,
    );
    const eligible = eligibleCountRes.rows[0].n;
    console.log(`  eligible accounts (pubkey IS NOT NULL): ${eligible}`);

    // 1. pnl_history — unique(accountId, marketId, time), plain UPDATE.
    {
      const r = await client.query(
        `UPDATE pnl_history p
         SET "walletAddr" = ap.pubkey
         FROM account_pubkey ap
         WHERE p."accountId" = ap."accountId"
           AND p."walletAddr" = 'account:' || ap."accountId"
           AND ap.pubkey IS NOT NULL`,
      );
      report.pnl_history = { updated: r.rowCount ?? 0, deleted: 0 };
    }

    // 2. funding_history — unique(accountId, marketId, time), plain UPDATE.
    {
      const r = await client.query(
        `UPDATE funding_history p
         SET "walletAddr" = ap.pubkey
         FROM account_pubkey ap
         WHERE p."accountId" = ap."accountId"
           AND p."walletAddr" = 'account:' || ap."accountId"
           AND ap.pubkey IS NOT NULL`,
      );
      report.funding_history = { updated: r.rowCount ?? 0, deleted: 0 };
    }

    // 3. trade_history — unique(tradeId).
    {
      const r = await client.query(
        `UPDATE trade_history p
         SET "walletAddr" = ap.pubkey
         FROM account_pubkey ap
         WHERE p."accountId" = ap."accountId"
           AND p."walletAddr" = 'account:' || ap."accountId"
           AND ap.pubkey IS NOT NULL`,
      );
      report.trade_history = { updated: r.rowCount ?? 0, deleted: 0 };
    }

    // 4. order_history — unique(orderId).
    {
      const r = await client.query(
        `UPDATE order_history p
         SET "walletAddr" = ap.pubkey
         FROM account_pubkey ap
         WHERE p."accountId" = ap."accountId"
           AND p."walletAddr" = 'account:' || ap."accountId"
           AND ap.pubkey IS NOT NULL`,
      );
      report.order_history = { updated: r.rowCount ?? 0, deleted: 0 };
    }

    // 5. deposit_history — unique(walletAddr, time, amount): kill placeholder twins first.
    for (const table of ["deposit_history", "withdrawal_history"]) {
      const d = await client.query(
        `DELETE FROM ${table} p
         USING ${table} r, account_pubkey ap
         WHERE ap.pubkey IS NOT NULL
           AND p."accountId"   = ap."accountId"
           AND p."walletAddr"  = 'account:' || ap."accountId"
           AND r."accountId"   = p."accountId"
           AND r."time"        = p."time"
           AND r."amount"      = p."amount"
           AND r."walletAddr"  = ap.pubkey`,
      );
      const u = await client.query(
        `UPDATE ${table} p
         SET "walletAddr" = ap.pubkey
         FROM account_pubkey ap
         WHERE p."accountId" = ap."accountId"
           AND p."walletAddr" = 'account:' || ap."accountId"
           AND ap.pubkey IS NOT NULL`,
      );
      report[table] = { updated: u.rowCount ?? 0, deleted: d.rowCount ?? 0 };
    }

    // 6. liquidation_history — unique(walletAddr, time, fee).
    {
      const d = await client.query(
        `DELETE FROM liquidation_history p
         USING liquidation_history r, account_pubkey ap
         WHERE ap.pubkey IS NOT NULL
           AND p."accountId"   = ap."accountId"
           AND p."walletAddr"  = 'account:' || ap."accountId"
           AND r."accountId"   = p."accountId"
           AND r."time"        = p."time"
           AND r."fee"         = p."fee"
           AND r."walletAddr"  = ap.pubkey`,
      );
      const u = await client.query(
        `UPDATE liquidation_history p
         SET "walletAddr" = ap.pubkey
         FROM account_pubkey ap
         WHERE p."accountId" = ap."accountId"
           AND p."walletAddr" = 'account:' || ap."accountId"
           AND ap.pubkey IS NOT NULL`,
      );
      report.liquidation_history = { updated: u.rowCount ?? 0, deleted: d.rowCount ?? 0 };
    }

    // 7. pnl_totals — walletAddr unique.
    {
      const d = await client.query(
        `DELETE FROM pnl_totals p
         USING pnl_totals r, account_pubkey ap
         WHERE ap.pubkey IS NOT NULL
           AND p."accountId"   = ap."accountId"
           AND p."walletAddr"  = 'account:' || ap."accountId"
           AND r."accountId"   = p."accountId"
           AND r."walletAddr"  = ap.pubkey`,
      );
      const u = await client.query(
        `UPDATE pnl_totals p
         SET "walletAddr" = ap.pubkey
         FROM account_pubkey ap
         WHERE p."accountId" = ap."accountId"
           AND p."walletAddr" = 'account:' || ap."accountId"
           AND ap.pubkey IS NOT NULL`,
      );
      report.pnl_totals = { updated: u.rowCount ?? 0, deleted: d.rowCount ?? 0 };
    }

    // 8. volume_calendar — unique(walletAddr, date).
    {
      const d = await client.query(
        `DELETE FROM volume_calendar p
         USING volume_calendar r, account_pubkey ap
         WHERE ap.pubkey IS NOT NULL
           AND p."accountId"   = ap."accountId"
           AND p."walletAddr"  = 'account:' || ap."accountId"
           AND r."accountId"   = p."accountId"
           AND r."date"        = p."date"
           AND r."walletAddr"  = ap.pubkey`,
      );
      const u = await client.query(
        `UPDATE volume_calendar p
         SET "walletAddr" = ap.pubkey
         FROM account_pubkey ap
         WHERE p."accountId" = ap."accountId"
           AND p."walletAddr" = 'account:' || ap."accountId"
           AND ap.pubkey IS NOT NULL`,
      );
      report.volume_calendar = { updated: u.rowCount ?? 0, deleted: d.rowCount ?? 0 };
    }

    // 9. sync_cursors — drop placeholders; real cursors live by accountId now.
    {
      const d = await client.query(
        `DELETE FROM sync_cursors sc
         USING account_pubkey ap
         WHERE ap.pubkey IS NOT NULL
           AND sc."walletAddr" = 'account:' || ap."accountId"`,
      );
      report.sync_cursors = { updated: 0, deleted: d.rowCount ?? 0 };
    }

    // 10. leaderboard_tiers — walletAddr denormalized, refresh it.
    {
      const u = await client.query(
        `UPDATE leaderboard_tiers lt
         SET "walletAddr" = ap.pubkey
         FROM account_pubkey ap
         WHERE lt."accountId" = ap."accountId"
           AND lt."walletAddr" = 'account:' || ap."accountId"
           AND ap.pubkey IS NOT NULL`,
      );
      report.leaderboard_tiers = { updated: u.rowCount ?? 0, deleted: 0 };
    }

    await client.query("COMMIT");

    console.log(`[phase 2] done in ${elapsed(Date.now() - start)}:`);
    for (const [table, c] of Object.entries(report)) {
      console.log(`  ${table.padEnd(22)} updated=${c.updated}  deleted=${c.deleted}`);
    }

    // Sanity — placeholder rows left over (accounts still in notFound state).
    const leftover = await client.query(
      `SELECT 'pnl_history' AS t, COUNT(*)::int AS n FROM pnl_history WHERE "walletAddr" LIKE 'account:%'
       UNION ALL SELECT 'trade_history', COUNT(*)::int FROM trade_history WHERE "walletAddr" LIKE 'account:%'
       UNION ALL SELECT 'pnl_totals', COUNT(*)::int FROM pnl_totals WHERE "walletAddr" LIKE 'account:%'`,
    );
    console.log(`[phase 2] placeholder rows remaining (unresolvable accounts):`);
    for (const row of leftover.rows) console.log(`  ${row.t.padEnd(22)} ${row.n}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────── main ────────────────────────────────────

async function main(): Promise<void> {
  const toId = TO_ARG ? Number(TO_ARG) : await fetchAccountsCount();
  console.log(`[resolve-all-wallets] range [${FROM_ID}…${toId}]`);

  if (!SKIP_FETCH) {
    await fetchPhase(toId);
  } else {
    console.log(`[phase 1] skipped (--skip-fetch)`);
  }

  if (!SKIP_PROPAGATE) {
    await propagatePhase();
  } else {
    console.log(`[phase 2] skipped (--skip-propagate)`);
  }

  await historyPool.end();
  console.log(`[resolve-all-wallets] all done`);
}

main().catch((err) => {
  console.error(`[resolve-all-wallets] fatal:`, err);
  process.exit(1);
});
