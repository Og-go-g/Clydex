/**
 * Bulk sync script — downloads ALL trade history for ALL 01 Exchange accounts.
 *
 * Run once:  npm run sync:history
 * Resume:    npm run sync:history          (skips already-synced accounts)
 * Force:     npm run sync:history -- --force (re-syncs everything)
 */

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { Pool } from "pg";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Agent } from "http";

// ─── Config ───────────────────────────────────────────────────────

const API_BASE = "https://zo-mainnet.n1.xyz";
const FRONTEND_API = "https://01.xyz/api";
const MAX_ACCOUNT_ID = 12000;
const PAGE_SIZE = 250;
const DELAY_BETWEEN_PAGES = 100;
const MAX_RETRIES = 3;
const RETRY_BACKOFF = 5_000;
const CONCURRENCY = Number(process.env.SYNC_CONCURRENCY || "5");
const FORCE = process.argv.includes("--force");

// ─── Proxy rotation ──────────────────────────────────────────────

const PROXY_LIST = (process.env.SYNC_PROXIES || "").split(",").map((s) => s.trim()).filter(Boolean);
let proxyIdx = 0;

function getNextProxy(): Agent | undefined {
  if (PROXY_LIST.length === 0) return undefined;
  const raw = PROXY_LIST[proxyIdx % PROXY_LIST.length];
  proxyIdx++;
  const url = raw.startsWith("http") ? raw : `http://${raw}`;
  return new HttpsProxyAgent(url) as unknown as Agent;
}

const BROWSER_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Referer: "https://01.xyz/",
  Origin: "https://01.xyz",
};

// ─── DB Pool ──────────────────────────────────────────────────────

function createPool(): Pool {
  const url = process.env.HISTORY_DATABASE_URL;
  if (!url) throw new Error("HISTORY_DATABASE_URL not set");
  return new Pool({
    connectionString: url,
    max: 3,
    ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
  });
}

// ─── API Helpers ──────────────────────────────────────────────────

interface AccountInfo {
  orders: unknown[];
  positions: unknown[];
  balances: unknown[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<Response | null> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const agent = getNextProxy();
      const options: RequestInit & { agent?: Agent } = {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      };
      if (agent) (options as Record<string, unknown>).agent = agent;

      const res = await fetch(url, options);
      if (res.status === 429) {
        const wait = RETRY_BACKOFF * (attempt + 1);
        process.stdout.write(`\r  Rate limited! Waiting ${wait / 1000}s...                          `);
        await sleep(wait);
        continue;
      }
      return res;
    } catch {
      if (attempt < retries - 1) await sleep(RETRY_BACKOFF * (attempt + 1));
    }
  }
  return null;
}

async function getAccount(accountId: number): Promise<AccountInfo | null> {
  const res = await fetchWithRetry(`${API_BASE}/account/${accountId}`);
  if (!res || !res.ok) return null;
  try {
    const text = await res.text();
    if (text === "null" || !text) return null;
    return JSON.parse(text) as AccountInfo;
  } catch {
    return null;
  }
}

let marketSymbols: Record<number, string> = {};

async function loadMarkets(): Promise<void> {
  const res = await fetch(`${API_BASE}/info`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error("Failed to fetch markets");
  const info = await res.json();
  for (const m of info.markets ?? []) {
    marketSymbols[m.marketId] = m.symbol;
  }
  console.log(`  Loaded ${Object.keys(marketSymbols).length} markets`);
}

function sym(marketId: number): string {
  return marketSymbols[marketId] ?? `MARKET-${marketId}`;
}

async function fetchAllPages<T>(baseUrl: string): Promise<T[]> {
  const all: T[] = [];
  let cursor: unknown;
  let hasMore = true;

  while (hasMore) {
    let url = baseUrl + (baseUrl.includes("?") ? "&" : "?") + `pageSize=${PAGE_SIZE}`;
    if (cursor) url += `&startInclusive=${encodeURIComponent(String(cursor))}`;

    const res = await fetchWithRetry(url);
    if (!res || !res.ok) break;

    try {
      const body = await res.json();
      const data: T[] = Array.isArray(body) ? body : (body.items ?? body.data ?? body.results ?? []);
      all.push(...data);

      cursor = body.nextStartInclusive ?? body.cursor ?? body.nextCursor ?? undefined;
      hasMore = data.length >= PAGE_SIZE && cursor != null;

      if (hasMore) {
        process.stdout.write(`\r    ... fetched ${all.length} records so far                    `);
        await sleep(DELAY_BETWEEN_PAGES);
      }
    } catch {
      break;
    }
  }

  return all;
}

// ─── Sync Functions (raw SQL, Prisma camelCase columns) ──────────

type R = Record<string, unknown>;

async function syncTrades(pool: Pool, accountId: number, wallet: string): Promise<number> {
  let total = 0;
  for (const role of ["taker", "maker"] as const) {
    const param = role === "taker" ? "takerId" : "makerId";
    const trades = await fetchAllPages<R>(`${API_BASE}/trades?${param}=${accountId}`);
    if (trades.length === 0) continue;

    const result = await pool.query(
      `INSERT INTO trade_history (id, "tradeId", "accountId", "walletAddr", "marketId", symbol, side, size, price, role, fee, "time")
       SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::int[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::text[], $11::numeric[], $12::timestamptz[])
       ON CONFLICT ("tradeId") DO NOTHING`,
      [
        trades.map(() => crypto.randomUUID()),
        trades.map((t) => String(t.tradeId)),
        trades.map(() => accountId),
        trades.map(() => wallet),
        trades.map((t) => Number(t.marketId)),
        trades.map((t) => sym(Number(t.marketId))),
        trades.map((t) => t.takerSide === "bid" ? "Long" : "Short"),
        trades.map((t) => String(t.baseSize ?? 0)),
        trades.map((t) => String(t.price ?? 0)),
        trades.map(() => role),
        trades.map(() => "0"),
        trades.map((t) => new Date(String(t.time))),
      ],
    );
    total += result.rowCount ?? 0;
  }
  return total;
}

async function syncOrders(pool: Pool, accountId: number, wallet: string): Promise<number> {
  const orders = await fetchAllPages<R>(`${API_BASE}/account/${accountId}/orders`);
  if (orders.length === 0) return 0;

  const result = await pool.query(
    `INSERT INTO order_history (id, "orderId", "accountId", "walletAddr", "marketId", symbol, side, "placedSize", "filledSize", "placedPrice", "orderValue", "fillMode", "fillStatus", status, "isReduceOnly", "addedAt", "updatedAt")
     SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::int[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[], $12::text[], $13::text[], $14::text[], $15::boolean[], $16::timestamptz[], $17::timestamptz[])
     ON CONFLICT ("orderId") DO NOTHING`,
    [
      orders.map(() => crypto.randomUUID()),
      orders.map((o) => String(o.orderId)),
      orders.map(() => accountId),
      orders.map(() => wallet),
      orders.map((o) => Number(o.marketId)),
      orders.map((o) => String(o.marketSymbol ?? sym(Number(o.marketId)))),
      orders.map((o) => o.side === "bid" ? "Long" : "Short"),
      orders.map((o) => String(o.placedSize ?? 0)),
      orders.map((o) => o.filledSize != null ? String(o.filledSize) : null),
      orders.map((o) => String(o.placedPrice ?? 0)),
      orders.map((o) => String((Number(o.placedPrice) || 0) * (Number(o.placedSize) || 0))),
      orders.map((o) => String(o.fillMode ?? "unknown")),
      orders.map((o) => o.filledSize != null && Number(o.filledSize) > 0 ? "Filled" : "Unfilled"),
      orders.map((o) => String(o.finalizationReason ?? "unknown")),
      orders.map((o) => Boolean(o.isReduceOnly)),
      orders.map((o) => new Date(String(o.addedAt))),
      orders.map((o) => new Date(String(o.updatedAt))),
    ],
  );
  return result.rowCount ?? 0;
}

async function syncPnl(pool: Pool, accountId: number, wallet: string): Promise<number> {
  const items = await fetchAllPages<R>(`${API_BASE}/account/${accountId}/history/pnl`);
  if (items.length === 0) return 0;

  const result = await pool.query(
    `INSERT INTO pnl_history (id, "accountId", "walletAddr", "marketId", symbol, "tradingPnl", "settledFundingPnl", "positionSize", "time")
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::int[], $5::text[], $6::numeric[], $7::numeric[], $8::numeric[], $9::timestamptz[])
     ON CONFLICT ("walletAddr", "marketId", "time") DO NOTHING`,
    [
      items.map(() => crypto.randomUUID()),
      items.map(() => accountId),
      items.map(() => wallet),
      items.map((p) => Number(p.marketId)),
      items.map((p) => sym(Number(p.marketId))),
      items.map((p) => String(p.tradingPnl ?? 0)),
      items.map((p) => String(p.settledFundingPnl ?? 0)),
      items.map((p) => String(p.positionSize ?? 0)),
      items.map((p) => new Date(String(p.time))),
    ],
  );
  return result.rowCount ?? 0;
}

async function syncFunding(pool: Pool, accountId: number, wallet: string): Promise<number> {
  const items = await fetchAllPages<R>(`${API_BASE}/account/${accountId}/history/funding`);
  if (items.length === 0) return 0;

  const result = await pool.query(
    `INSERT INTO funding_history (id, "accountId", "walletAddr", "marketId", symbol, "fundingPnl", "positionSize", "time")
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::int[], $5::text[], $6::numeric[], $7::numeric[], $8::timestamptz[])
     ON CONFLICT ("walletAddr", "marketId", "time") DO NOTHING`,
    [
      items.map(() => crypto.randomUUID()),
      items.map(() => accountId),
      items.map(() => wallet),
      items.map((f) => Number(f.marketId)),
      items.map((f) => sym(Number(f.marketId))),
      items.map((f) => String(f.fundingPnl ?? 0)),
      items.map((f) => String(f.positionSize ?? 0)),
      items.map((f) => new Date(String(f.time))),
    ],
  );
  return result.rowCount ?? 0;
}

async function syncDeposits(pool: Pool, accountId: number, wallet: string): Promise<number> {
  const items = await fetchAllPages<R>(`${API_BASE}/account/${accountId}/history/deposit`);
  if (items.length === 0) return 0;

  const result = await pool.query(
    `INSERT INTO deposit_history (id, "accountId", "walletAddr", amount, balance, "tokenId", "time")
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::numeric[], $5::numeric[], $6::int[], $7::timestamptz[])
     ON CONFLICT ("walletAddr", "time", amount) DO NOTHING`,
    [
      items.map(() => crypto.randomUUID()),
      items.map(() => accountId),
      items.map(() => wallet),
      items.map((d) => String(d.amount ?? 0)),
      items.map((d) => String(d.balance ?? 0)),
      items.map((d) => Number(d.tokenId ?? 0)),
      items.map((d) => new Date(String(d.time))),
    ],
  );
  return result.rowCount ?? 0;
}

async function syncWithdrawals(pool: Pool, accountId: number, wallet: string): Promise<number> {
  const items = await fetchAllPages<R>(`${API_BASE}/account/${accountId}/history/withdrawal`);
  if (items.length === 0) return 0;

  const result = await pool.query(
    `INSERT INTO withdrawal_history (id, "accountId", "walletAddr", amount, balance, fee, "destPubkey", "time")
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::numeric[], $5::numeric[], $6::numeric[], $7::text[], $8::timestamptz[])
     ON CONFLICT ("walletAddr", "time", amount) DO NOTHING`,
    [
      items.map(() => crypto.randomUUID()),
      items.map(() => accountId),
      items.map(() => wallet),
      items.map((w) => String(w.amount ?? 0)),
      items.map((w) => String(w.balance ?? 0)),
      items.map((w) => String(w.fee ?? 0)),
      items.map((w) => String(w.destPubkey ?? "")),
      items.map((w) => new Date(String(w.time))),
    ],
  );
  return result.rowCount ?? 0;
}

async function syncLiquidations(pool: Pool, accountId: number, wallet: string): Promise<number> {
  const items = await fetchAllPages<R>(`${API_BASE}/account/${accountId}/history/liquidation`);
  if (items.length === 0) return 0;

  const result = await pool.query(
    `INSERT INTO liquidation_history (id, "accountId", "walletAddr", fee, "liquidationKind", margins, "time")
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::numeric[], $5::text[], $6::jsonb[], $7::timestamptz[])
     ON CONFLICT ("walletAddr", "time", fee) DO NOTHING`,
    [
      items.map(() => crypto.randomUUID()),
      items.map(() => accountId),
      items.map(() => wallet),
      items.map((l) => String(l.fee ?? 0)),
      items.map((l) => String(l.liquidationKind ?? "unknown")),
      items.map((l) => {
        const { time: _t, fee: _f, liquidationKind: _lk, ...rest } = l;
        return JSON.stringify(rest);
      }),
      items.map((l) => new Date(String(l.time))),
    ],
  );
  return result.rowCount ?? 0;
}

// ─── 01.xyz Frontend API Sync ─────────────────────────────────────

async function syncVolumeCalendar(pool: Pool, accountId: number, wallet: string): Promise<number> {
  try {
    const res = await fetchWithRetry(`${FRONTEND_API}/volume-calendar/${accountId}`);
    if (!res || !res.ok) return 0;
    const body = await res.json();
    const entries = Object.entries(body.days ?? {}) as [string, Record<string, number>][];
    if (entries.length === 0) return 0;

    const result = await pool.query(
      `INSERT INTO volume_calendar (id, "accountId", "walletAddr", date, volume, "makerVolume", "takerVolume", "makerFees", "takerFees", "totalFees")
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[])
       ON CONFLICT ("walletAddr", date) DO UPDATE SET
         volume = EXCLUDED.volume, "makerVolume" = EXCLUDED."makerVolume", "takerVolume" = EXCLUDED."takerVolume",
         "makerFees" = EXCLUDED."makerFees", "takerFees" = EXCLUDED."takerFees", "totalFees" = EXCLUDED."totalFees"`,
      [
        entries.map(() => crypto.randomUUID()),
        entries.map(() => accountId),
        entries.map(() => wallet),
        entries.map(([date]) => date),
        entries.map(([, d]) => String(d.volume ?? 0)),
        entries.map(([, d]) => String(d.makerVolume ?? 0)),
        entries.map(([, d]) => String(d.takerVolume ?? 0)),
        entries.map(([, d]) => String(d.makerFees ?? 0)),
        entries.map(([, d]) => String(d.takerFees ?? 0)),
        entries.map(([, d]) => String(d.totalFees ?? 0)),
      ],
    );
    return result.rowCount ?? 0;
  } catch { return 0; }
}

async function syncPnlTotals(pool: Pool, accountId: number, wallet: string): Promise<boolean> {
  try {
    const res = await fetchWithRetry(`${FRONTEND_API}/pnl-totals/${accountId}`);
    if (!res || !res.ok) return false;
    const body = await res.json();

    await pool.query(
      `INSERT INTO pnl_totals (id, "accountId", "walletAddr", "totalPnl", "totalTradingPnl", "totalFundingPnl", "fetchedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ("walletAddr") DO UPDATE SET
         "totalPnl" = EXCLUDED."totalPnl", "totalTradingPnl" = EXCLUDED."totalTradingPnl",
         "totalFundingPnl" = EXCLUDED."totalFundingPnl", "fetchedAt" = EXCLUDED."fetchedAt"`,
      [
        crypto.randomUUID(), accountId, wallet,
        String(body.totalPnl ?? 0), String(body.totalTradingPnl ?? 0),
        String(body.totalFundingPnl ?? 0), new Date(body.fetchedAt ?? new Date().toISOString()),
      ],
    );
    return true;
  } catch { return false; }
}

// ─── Cursor Helpers ───────────────────────────────────────────────

const ALL_TYPES = ["trades", "orders", "pnl", "funding", "deposits", "withdrawals", "liquidations"];

async function isAlreadySynced(pool: Pool, wallet: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT count(*) > 0 AS synced FROM sync_cursors WHERE "walletAddr" = $1`,
    [wallet],
  );
  return result.rows[0]?.synced ?? false;
}

async function setCursorsToNow(pool: Pool, wallet: string): Promise<void> {
  const now = new Date().toISOString();
  for (const type of ALL_TYPES) {
    await pool.query(
      `INSERT INTO sync_cursors (id, "walletAddr", type, cursor, "lastSyncAt")
       VALUES (gen_random_uuid(), $1, $2, $3, NOW())
       ON CONFLICT ("walletAddr", type) DO UPDATE SET cursor = $3, "lastSyncAt" = NOW()`,
      [wallet, type, now],
    );
  }
}

// ─── Progress Display ─────────────────────────────────────────────

function progressBar(current: number, total: number, width = 30): string {
  const pct = current / total;
  const filled = Math.round(pct * width);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
  return `[${bar}] ${(pct * 100).toFixed(1)}%`;
}

function elapsed(startMs: number): string {
  const s = Math.floor((Date.now() - startMs) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function eta(startMs: number, current: number, total: number): string {
  if (current === 0) return "calculating...";
  const elapsedMs = Date.now() - startMs;
  const msPerItem = elapsedMs / current;
  const remainingMs = msPerItem * (total - current);
  const s = Math.floor(remainingMs / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `~${h}h ${m}m`;
  if (m > 0) return `~${m}m`;
  return `~${s}s`;
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log("\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557");
  console.log("\u2551   Clydex \u2014 01 Exchange Full History Sync \u2551");
  console.log("\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\n");

  if (FORCE) console.log("  Mode: FORCE (re-syncing all accounts)");
  else console.log("  Mode: RESUME (skipping already-synced accounts)");
  console.log(`  Concurrency: ${CONCURRENCY}`);
  if (PROXY_LIST.length > 0) console.log(`  Proxies: ${PROXY_LIST.length} rotating`);
  console.log("");

  const pool = createPool();

  console.log("[1/3] Loading markets...");
  await loadMarkets();

  console.log(`[2/3] Scanning accounts 0 \u2192 ${MAX_ACCOUNT_ID} (${CONCURRENCY} parallel)...\n`);

  const startTime = Date.now();
  let processed = 0;
  let exists = 0;
  let synced = 0;
  let skippedEmpty = 0;
  let skippedDone = 0;
  let failed = 0;
  let totalRecords = 0;

  async function processAccount(id: number): Promise<void> {
    const account = await getAccount(id);
    if (!account) {
      skippedEmpty++;
      processed++;
      return;
    }
    exists++;

    const wallet = `account:${id}`;

    if (!FORCE && await isAlreadySynced(pool, wallet)) {
      skippedDone++;
      processed++;
      return;
    }

    try {
      const trades = await syncTrades(pool, id, wallet);
      const orders = await syncOrders(pool, id, wallet);
      const pnl = await syncPnl(pool, id, wallet);
      const funding = await syncFunding(pool, id, wallet);
      const deposits = await syncDeposits(pool, id, wallet);
      const withdrawals = await syncWithdrawals(pool, id, wallet);
      const liquidations = await syncLiquidations(pool, id, wallet);

      // 01.xyz frontend data
      const [vcRows] = await Promise.all([
        syncVolumeCalendar(pool, id, wallet),
        syncPnlTotals(pool, id, wallet),
      ]);

      const sum = trades + orders + pnl + funding + deposits + withdrawals + liquidations + vcRows;
      totalRecords += sum;

      await setCursorsToNow(pool, wallet);
      synced++;
      processed++;

      if (sum > 0) {
        console.log(
          `  Account ${id}: +${sum} records ` +
          `(t:${trades} o:${orders} p:${pnl} f:${funding} d:${deposits} w:${withdrawals} l:${liquidations} vc:${vcRows})`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  Account ${id}: FAIL \u2014 ${msg}`);
      failed++;
      processed++;
    }
  }

  for (let batchStart = 0; batchStart <= MAX_ACCOUNT_ID; batchStart += CONCURRENCY) {
    const batchEnd = Math.min(batchStart + CONCURRENCY, MAX_ACCOUNT_ID + 1);
    const batch = [];
    for (let id = batchStart; id < batchEnd; id++) {
      batch.push(processAccount(id));
    }
    await Promise.all(batch);

    process.stdout.write(
      `\r  ${progressBar(processed, MAX_ACCOUNT_ID)} | ${processed}/${MAX_ACCOUNT_ID} | ` +
      `found:${exists} synced:${synced} skip:${skippedEmpty + skippedDone} fail:${failed} | ` +
      `records:${totalRecords} | elapsed:${elapsed(startTime)} ETA:${eta(startTime, processed || 1, MAX_ACCOUNT_ID)}   `
    );
  }

  process.stdout.write(
    `\r  ${progressBar(MAX_ACCOUNT_ID, MAX_ACCOUNT_ID)} | DONE                                                                    \n`
  );

  console.log(`\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557`);
  console.log(`\u2551  Results                                 \u2551`);
  console.log(`\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563`);
  console.log(`\u2551  Accounts found:    ${String(exists).padStart(6)}              \u2551`);
  console.log(`\u2551  Synced:            ${String(synced).padStart(6)}              \u2551`);
  console.log(`\u2551  Skipped (empty):   ${String(skippedEmpty).padStart(6)}              \u2551`);
  console.log(`\u2551  Skipped (done):    ${String(skippedDone).padStart(6)}              \u2551`);
  console.log(`\u2551  Failed:            ${String(failed).padStart(6)}              \u2551`);
  console.log(`\u2551  Total records:     ${String(totalRecords).padStart(6)}              \u2551`);
  console.log(`\u2551  Time:              ${elapsed(startTime).padStart(6)}              \u2551`);
  console.log(`\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d`);

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFatal:", err);
  process.exit(1);
});
