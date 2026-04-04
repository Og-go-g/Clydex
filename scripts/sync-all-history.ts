/**
 * Clydex — Full History Sync Script
 *
 * Downloads ALL trade history for ALL 01 Exchange accounts (0 → 12000).
 * Streams data page-by-page into PostgreSQL — never holds more than 1 page in memory.
 *
 * Usage:
 *   npx tsx scripts/sync-all-history.ts --force          # Re-sync everything
 *   npx tsx scripts/sync-all-history.ts                   # Resume (skip synced)
 *
 * Environment:
 *   SYNC_PROXIES     — Comma-separated proxy list (user:pass@host:port)
 *   SYNC_CONCURRENCY — Parallel accounts (default: 5)
 *   HISTORY_DATABASE_URL — PostgreSQL connection string
 */

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { Pool } from "pg";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Agent } from "http";

// ═══════════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════════

const API = "https://zo-mainnet.n1.xyz";
const MAX_ID = 12000;
const PAGE = 250;
const CONCURRENCY = Number(process.env.SYNC_CONCURRENCY || "5");
const FORCE = process.argv.includes("--force");
const RETRIES = 3;
const BACKOFF = 5_000;

// ═══════════════════════════════════════════════════════════════════
//  PROXY ROTATION
// ═══════════════════════════════════════════════════════════════════

const PROXIES = (process.env.SYNC_PROXIES || "").split(",").map(s => s.trim()).filter(Boolean);
let pIdx = 0;
function proxy(): Agent | undefined {
  if (!PROXIES.length) return undefined;
  const p = PROXIES[pIdx++ % PROXIES.length];
  return new HttpsProxyAgent(p.startsWith("http") ? p : `http://${p}`) as unknown as Agent;
}

// ═══════════════════════════════════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════════════════════════════════

const db = new Pool({
  connectionString: process.env.HISTORY_DATABASE_URL,
  max: 10,
  ssl: (process.env.HISTORY_DATABASE_URL || "").includes("localhost") ? false : { rejectUnauthorized: false },
});

// ═══════════════════════════════════════════════════════════════════
//  FETCH WITH RETRY
// ═══════════════════════════════════════════════════════════════════

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function get(url: string): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < RETRIES; i++) {
    try {
      const agent = proxy();
      const opts: RequestInit & { agent?: Agent } = {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      };
      if (agent) (opts as Record<string, unknown>).agent = agent;
      const res = await fetch(url, opts);
      if (res.status === 429) {
        await sleep(BACKOFF * (i + 1));
        continue;
      }
      if (!res.ok) return null;
      return await res.json() as Record<string, unknown>;
    } catch {
      if (i < RETRIES - 1) await sleep(BACKOFF);
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
//  MARKET SYMBOLS
// ═══════════════════════════════════════════════════════════════════

const syms: Record<number, string> = {};

async function loadMarkets() {
  const info = await get(`${API}/info`);
  if (!info) throw new Error("Cannot load markets");
  for (const m of (info.markets as Array<{ marketId: number; symbol: string }>) || []) {
    syms[m.marketId] = m.symbol;
  }
  console.log(`  Loaded ${Object.keys(syms).length} markets`);
}

function sym(id: number): string { return syms[id] || `MKT-${id}`; }

// ═══════════════════════════════════════════════════════════════════
//  STREAMING PAGE PROCESSOR
//  Fetches one page at a time, inserts into DB, frees memory.
// ═══════════════════════════════════════════════════════════════════

type R = Record<string, unknown>;

async function streamPages(
  baseUrl: string,
  sql: string,
  toParams: (page: R[]) => unknown[],
): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  let pages = 0;

  while (true) {
    let url = baseUrl + (baseUrl.includes("?") ? "&" : "?") + `pageSize=${PAGE}`;
    if (cursor) url += `&startInclusive=${encodeURIComponent(cursor)}`;

    const body = await get(url);
    if (!body) break;

    const items: R[] = Array.isArray(body) ? body as R[] : ((body.items ?? body.data ?? body.results ?? []) as R[]);
    if (items.length === 0) break;

    try {
      const result = await db.query(sql, toParams(items));
      total += result.rowCount ?? 0;
    } catch (err) {
      // Log but continue — don't crash on one bad page
      const msg = err instanceof Error ? err.message.slice(0, 80) : String(err);
      if (!msg.includes("duplicate") && !msg.includes("conflict")) {
        throw err; // Re-throw real errors
      }
    }

    pages++;
    if (pages % 10 === 0) {
      process.stdout.write(`\r    ... ${total} records inserted (${pages} pages)                    `);
    }

    cursor = (body.nextStartInclusive ?? body.cursor ?? body.nextCursor) as string | undefined;
    if (!cursor || items.length < PAGE) break;

    await sleep(50); // Gentle rate limit
  }

  return total;
}

// ═══════════════════════════════════════════════════════════════════
//  SYNC FUNCTIONS — one per data type
// ═══════════════════════════════════════════════════════════════════

async function syncTrades(id: number, w: string): Promise<number> {
  let total = 0;
  for (const role of ["taker", "maker"] as const) {
    const param = role === "taker" ? "takerId" : "makerId";
    total += await streamPages(
      `${API}/trades?${param}=${id}`,
      `INSERT INTO trade_history (trade_id, account_id, wallet_addr, market_id, symbol, side, size, price, role, fee, "time")
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::int[], $5::text[], $6::text[], $7::numeric[], $8::numeric[], $9::text[], $10::numeric[], $11::timestamptz[])
       ON CONFLICT (trade_id, "time") DO NOTHING`,
      (p) => [
        p.map(t => String(t.tradeId)),
        p.map(() => id),
        p.map(() => w),
        p.map(t => Number(t.marketId)),
        p.map(t => sym(Number(t.marketId))),
        p.map(t => t.takerSide === "bid" ? "Long" : "Short"),
        p.map(t => String(t.baseSize ?? 0)),
        p.map(t => String(t.price ?? 0)),
        p.map(() => role),
        p.map(() => "0"),
        p.map(t => new Date(String(t.time))),
      ],
    );
  }
  return total;
}

async function syncOrders(id: number, w: string): Promise<number> {
  return streamPages(
    `${API}/account/${id}/orders`,
    `INSERT INTO order_history (order_id, account_id, wallet_addr, market_id, symbol, side, placed_size, filled_size, placed_price, order_value, fill_mode, fill_status, status, is_reduce_only, added_at, updated_at)
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::int[], $5::text[], $6::text[], $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[], $11::text[], $12::text[], $13::text[], $14::boolean[], $15::timestamptz[], $16::timestamptz[])
     ON CONFLICT (order_id, added_at) DO NOTHING`,
    (p) => [
      p.map(o => String(o.orderId)),
      p.map(() => id),
      p.map(() => w),
      p.map(o => Number(o.marketId)),
      p.map(o => String(o.marketSymbol ?? sym(Number(o.marketId)))),
      p.map(o => o.side === "bid" ? "Long" : "Short"),
      p.map(o => String(o.placedSize ?? 0)),
      p.map(o => o.filledSize != null ? String(o.filledSize) : null),
      p.map(o => String(o.placedPrice ?? 0)),
      p.map(o => String((Number(o.placedPrice) || 0) * (Number(o.placedSize) || 0))),
      p.map(o => String(o.fillMode ?? "unknown")),
      p.map(o => o.filledSize != null && Number(o.filledSize) > 0 ? "Filled" : "Unfilled"),
      p.map(o => String(o.finalizationReason ?? "unknown")),
      p.map(o => Boolean(o.isReduceOnly)),
      p.map(o => new Date(String(o.addedAt))),
      p.map(o => new Date(String(o.updatedAt))),
    ],
  );
}

async function syncPnl(id: number, w: string): Promise<number> {
  return streamPages(
    `${API}/account/${id}/history/pnl`,
    `INSERT INTO pnl_history (account_id, wallet_addr, market_id, symbol, trading_pnl, settled_funding_pnl, position_size, "time")
     SELECT * FROM unnest($1::int[], $2::text[], $3::int[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[], $8::timestamptz[])
     ON CONFLICT (wallet_addr, market_id, "time") DO NOTHING`,
    (p) => [
      p.map(() => id), p.map(() => w),
      p.map(x => Number(x.marketId)), p.map(x => sym(Number(x.marketId))),
      p.map(x => String(x.tradingPnl ?? 0)), p.map(x => String(x.settledFundingPnl ?? 0)),
      p.map(x => String(x.positionSize ?? 0)), p.map(x => new Date(String(x.time))),
    ],
  );
}

async function syncFunding(id: number, w: string): Promise<number> {
  return streamPages(
    `${API}/account/${id}/history/funding`,
    `INSERT INTO funding_history (account_id, wallet_addr, market_id, symbol, funding_pnl, position_size, "time")
     SELECT * FROM unnest($1::int[], $2::text[], $3::int[], $4::text[], $5::numeric[], $6::numeric[], $7::timestamptz[])
     ON CONFLICT (wallet_addr, market_id, "time") DO NOTHING`,
    (p) => [
      p.map(() => id), p.map(() => w),
      p.map(x => Number(x.marketId)), p.map(x => sym(Number(x.marketId))),
      p.map(x => String(x.fundingPnl ?? 0)), p.map(x => String(x.positionSize ?? 0)),
      p.map(x => new Date(String(x.time))),
    ],
  );
}

async function syncDeposits(id: number, w: string): Promise<number> {
  return streamPages(
    `${API}/account/${id}/history/deposit`,
    `INSERT INTO deposit_history (account_id, wallet_addr, amount, balance, token_id, "time")
     SELECT * FROM unnest($1::int[], $2::text[], $3::numeric[], $4::numeric[], $5::int[], $6::timestamptz[])
     ON CONFLICT (wallet_addr, "time", amount) DO NOTHING`,
    (p) => [
      p.map(() => id), p.map(() => w),
      p.map(x => String(x.amount ?? 0)), p.map(x => String(x.balance ?? 0)),
      p.map(x => Number(x.tokenId ?? 0)), p.map(x => new Date(String(x.time))),
    ],
  );
}

async function syncWithdrawals(id: number, w: string): Promise<number> {
  return streamPages(
    `${API}/account/${id}/history/withdrawal`,
    `INSERT INTO withdrawal_history (account_id, wallet_addr, amount, balance, fee, dest_pubkey, "time")
     SELECT * FROM unnest($1::int[], $2::text[], $3::numeric[], $4::numeric[], $5::numeric[], $6::text[], $7::timestamptz[])
     ON CONFLICT (wallet_addr, "time", amount) DO NOTHING`,
    (p) => [
      p.map(() => id), p.map(() => w),
      p.map(x => String(x.amount ?? 0)), p.map(x => String(x.balance ?? 0)),
      p.map(x => String(x.fee ?? 0)), p.map(x => String(x.destPubkey ?? "")),
      p.map(x => new Date(String(x.time))),
    ],
  );
}

async function syncLiquidations(id: number, w: string): Promise<number> {
  return streamPages(
    `${API}/account/${id}/history/liquidation`,
    `INSERT INTO liquidation_history (account_id, wallet_addr, fee, liquidation_kind, margins, "time")
     SELECT * FROM unnest($1::int[], $2::text[], $3::numeric[], $4::text[], $5::jsonb[], $6::timestamptz[])
     ON CONFLICT (wallet_addr, "time", fee) DO NOTHING`,
    (p) => [
      p.map(() => id), p.map(() => w),
      p.map(x => String(x.fee ?? 0)), p.map(x => String(x.liquidationKind ?? "unknown")),
      p.map(x => { const { time: _, fee: __, liquidationKind: ___, ...r } = x; return JSON.stringify(r); }),
      p.map(x => new Date(String(x.time))),
    ],
  );
}

// ═══════════════════════════════════════════════════════════════════
//  CURSOR MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

async function isSynced(w: string): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM sync_cursors WHERE wallet_addr = $1 LIMIT 1`, [w]);
  return r.rowCount !== null && r.rowCount > 0;
}

async function markSynced(w: string): Promise<void> {
  const now = new Date().toISOString();
  for (const t of ["trades", "orders", "pnl", "funding", "deposits", "withdrawals", "liquidations"]) {
    await db.query(
      `INSERT INTO sync_cursors (wallet_addr, type, cursor, last_sync_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (wallet_addr, type) DO UPDATE SET cursor = $3, last_sync_at = NOW()`,
      [w, t, now],
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
//  ACCOUNT EXISTENCE CHECK
// ═══════════════════════════════════════════════════════════════════

async function accountExists(id: number): Promise<boolean> {
  const body = await get(`${API}/account/${id}`);
  if (!body) return false;
  // Empty or null response means account doesn't exist
  if (typeof body === "object" && Object.keys(body).length === 0) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════════
//  PROGRESS DISPLAY
// ═══════════════════════════════════════════════════════════════════

function bar(cur: number, tot: number, w = 30): string {
  const pct = cur / tot;
  const f = Math.round(pct * w);
  return `[${"█".repeat(f)}${"░".repeat(w - f)}] ${(pct * 100).toFixed(1)}%`;
}

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function eta(start: number, cur: number, tot: number): string {
  if (cur === 0) return "...";
  const ms = (Date.now() - start) / cur * (tot - cur);
  return elapsed(ms);
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   Clydex — 01 Exchange Full History Sync ║");
  console.log("╚══════════════════════════════════════════╝\n");
  console.log(`  Mode: ${FORCE ? "FORCE" : "RESUME"}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`  Page size: ${PAGE}`);
  if (PROXIES.length) console.log(`  Proxies: ${PROXIES.length} rotating`);
  console.log("");

  console.log("[1/3] Loading markets...");
  await loadMarkets();

  console.log(`[2/3] Scanning accounts 0 → ${MAX_ID}...\n`);

  const t0 = Date.now();
  let processed = 0, found = 0, synced = 0, skipped = 0, failed = 0, totalRec = 0;
  const failedIds: number[] = [];

  async function processAccount(id: number) {
    const w = `account:${id}`;

    // Skip non-existent accounts
    const exists = await accountExists(id);
    if (!exists) { processed++; return; }
    found++;

    // Skip already synced (unless --force)
    if (!FORCE && await isSynced(w)) { skipped++; processed++; return; }

    // Retry up to 3 times on failure — no account gets skipped without a fight
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const t = await syncTrades(id, w);
        const o = await syncOrders(id, w);
        const p = await syncPnl(id, w);
        const f = await syncFunding(id, w);
        const d = await syncDeposits(id, w);
        const wd = await syncWithdrawals(id, w);
        const l = await syncLiquidations(id, w);

        const sum = t + o + p + f + d + wd + l;
        totalRec += sum;

        await markSynced(w);
        synced++;

        if (sum > 0) {
          console.log(`\n  Account ${id}: +${sum} (t:${t} o:${o} p:${p} f:${f} d:${d} w:${wd} l:${l})`);
        }
        break; // Success — exit retry loop
      } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 80) : String(err);
        if (attempt < 3) {
          console.log(`\n  Account ${id}: attempt ${attempt}/3 failed — ${msg}, retrying in ${attempt * 10}s...`);
          await sleep(attempt * 10_000);
        } else {
          console.log(`\n  Account ${id}: FAILED after 3 attempts — ${msg}`);
          failedIds.push(id);
          failed++;
        }
      }
    }
    processed++;
  }

  // Process in batches
  for (let start = 0; start <= MAX_ID; start += CONCURRENCY) {
    const batch: Promise<void>[] = [];
    for (let id = start; id < Math.min(start + CONCURRENCY, MAX_ID + 1); id++) {
      batch.push(processAccount(id));
    }
    await Promise.all(batch);

    process.stdout.write(
      `\r  ${bar(processed, MAX_ID)} | ${processed}/${MAX_ID} | ` +
      `found:${found} ok:${synced} skip:${skipped} fail:${failed} | ` +
      `${totalRec} records | ${elapsed(Date.now() - t0)} ETA:${eta(t0, processed, MAX_ID)}   `
    );
  }

  // ─── Final retry pass for any failed accounts ─────────────────
  if (failedIds.length > 0) {
    console.log(`\n\n[3/3] Retrying ${failedIds.length} failed accounts one more time...\n`);
    const stillFailed: number[] = [];
    for (const id of failedIds) {
      const w = `account:${id}`;
      try {
        const t = await syncTrades(id, w);
        const o = await syncOrders(id, w);
        const p = await syncPnl(id, w);
        const f = await syncFunding(id, w);
        const d = await syncDeposits(id, w);
        const wd = await syncWithdrawals(id, w);
        const l = await syncLiquidations(id, w);

        const sum = t + o + p + f + d + wd + l;
        totalRec += sum;
        await markSynced(w);
        synced++;
        failed--;
        console.log(`  Account ${id}: RECOVERED +${sum} records`);
      } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 60) : String(err);
        console.log(`  Account ${id}: STILL FAILED — ${msg}`);
        stillFailed.push(id);
      }
    }
    if (stillFailed.length > 0) {
      console.log(`\n  ⚠ Permanently failed accounts: [${stillFailed.join(", ")}]`);
      console.log(`  Re-run with: npx tsx scripts/sync-all-history.ts --force`);
    }
  }

  console.log(`\n\n  ═══ DONE ═══`);
  console.log(`  Accounts found: ${found}`);
  console.log(`  Synced: ${synced}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total records: ${totalRec}`);
  console.log(`  Time: ${elapsed(Date.now() - t0)}`);

  await db.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error("\nFatal:", err); process.exit(1); });
