/**
 * Clydex — Full History Sync Script
 *
 * Downloads ALL trade history for ALL 01 Exchange accounts (0 → 12000).
 * Streams data page-by-page into PostgreSQL — never holds more than 1 page in memory.
 *
 * Usage:
 *   npx tsx scripts/sync-all-history.ts                   # Resume (skip synced)
 *   npx tsx scripts/sync-all-history.ts --force            # Re-sync everything
 *   npx tsx scripts/sync-all-history.ts --from=500         # Start from account 500
 *   npx tsx scripts/sync-all-history.ts --to=1000          # Stop at account 1000
 *
 * Environment:
 *   SYNC_PROXIES       — Comma-separated proxy list (user:pass@host:port)
 *   SYNC_CONCURRENCY   — Parallel accounts (default: 3)
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
const FRONTEND_API = "https://01.xyz/api";
const MAX_ID = Number(process.argv.find(a => a.startsWith("--to="))?.split("=")[1] || "12000");
const FROM_ID = Number(process.argv.find(a => a.startsWith("--from="))?.split("=")[1] || "0");
const PAGE = 250;
const CONCURRENCY = Number(process.env.SYNC_CONCURRENCY || "1");
const FORCE = process.argv.includes("--force");

// Rate limiting — respect 01 API limits
const API_DELAY_MS = 100;          // 100ms between API calls (~10 req/s, safe with proxies)
const BETWEEN_ACCOUNTS_MS = 500;   // 500ms pause between accounts
const FRONTEND_API_DELAY_MS = 3000; // 3s between 01.xyz frontend API calls (behind Vercel WAF)
const RETRY_COUNT = 3;
const RETRY_BACKOFF_MS = 5_000;

// ═══════════════════════════════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════

let shuttingDown = false;
process.on("SIGINT", () => {
  if (shuttingDown) { console.log("\n  Force exit."); process.exit(1); }
  shuttingDown = true;
  console.log("\n\n  ⏸ Shutting down gracefully... (press Ctrl+C again to force)");
  console.log("  Waiting for current accounts to finish...");
});

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

const dbUrl = process.env.HISTORY_DATABASE_URL || "";
const wantsSsl = dbUrl.includes("sslmode=require") || process.env.DB_SSL === "true";
const db = new Pool({
  connectionString: dbUrl,
  max: 10,
  ssl: wantsSsl ? { rejectUnauthorized: true } : false,
});

// ═══════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/** Rate-limited fetch with retry + 429 backoff */
async function get(url: string): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < RETRY_COUNT; i++) {
    try {
      const agent = proxy();
      const opts: RequestInit & { agent?: Agent } = {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      };
      if (agent) (opts as Record<string, unknown>).agent = agent;
      const res = await fetch(url, opts);

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") || "10");
        const waitMs = Math.max(retryAfter * 1000, RETRY_BACKOFF_MS * (i + 1));
        process.stdout.write(`\n    [429] Rate limited on ${url.slice(0, 80)}, waiting ${Math.round(waitMs / 1000)}s... (attempt ${i + 1}/${RETRY_COUNT})\n`);
        await sleep(waitMs);
        continue;
      }
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) {
        process.stdout.write(`\n    [${res.status}] ${url.slice(0, 80)} (attempt ${i + 1}/${RETRY_COUNT})\n`);
        if (i < RETRY_COUNT - 1) { await sleep(RETRY_BACKOFF_MS); continue; }
        return null;
      }
      return await res.json() as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 60) : String(err);
      if (i < RETRY_COUNT - 1) {
        process.stdout.write(`\n    [ERR] ${msg} — ${url.slice(0, 60)} (attempt ${i + 1}/${RETRY_COUNT})\n`);
        await sleep(RETRY_BACKOFF_MS * (i + 1));
      }
    }
  }
  return null;
}

/** Rate-limited fetch for 01.xyz frontend API (behind Vercel WAF) */
const BROWSER_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Referer: "https://01.xyz/",
  Origin: "https://01.xyz",
};

async function getFrontend(url: string): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < RETRY_COUNT; i++) {
    try {
      const res = await fetch(url, {
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429 || res.status === 403) {
        const waitMs = FRONTEND_API_DELAY_MS * (i + 2);
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) return null;
      return await res.json() as Record<string, unknown>;
    } catch {
      if (i < RETRY_COUNT - 1) await sleep(RETRY_BACKOFF_MS);
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
  if (!info) throw new Error("Cannot load markets from 01 Exchange API");
  for (const m of (info.markets as Array<{ marketId: number; symbol: string }>) || []) {
    syms[m.marketId] = m.symbol;
  }
  console.log(`  Loaded ${Object.keys(syms).length} markets`);
}

function sym(id: number): string { return syms[id] || `MKT-${id}`; }

function safeDate(v: unknown): Date {
  if (!v) return new Date(0);
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? new Date(0) : d;
}

// ═══════════════════════════════════════════════════════════════════
//  STREAMING PAGE PROCESSOR
// ═══════════════════════════════════════════════════════════════════

type R = Record<string, unknown>;

async function streamPages(
  baseUrl: string,
  sql: string,
  toParams: (page: R[]) => unknown[],
  label?: string,
): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  let pages = 0;

  while (!shuttingDown) {
    let url = baseUrl + (baseUrl.includes("?") ? "&" : "?") + `pageSize=${PAGE}`;
    if (cursor) url += `&startInclusive=${encodeURIComponent(cursor)}`;

    const body = await get(url);
    if (!body) {
      if (pages === 0 && label) {
        process.stdout.write(`\n    [!] ${label}: API returned null on first page\n`);
      }
      break;
    }

    const items: R[] = Array.isArray(body) ? body as R[] : ((body.items ?? body.data ?? body.results ?? []) as R[]);
    if (items.length === 0) break;

    try {
      const result = await db.query(sql, toParams(items));
      total += result.rowCount ?? 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 100) : String(err);
      // Log and continue — don't crash the entire sync
      if (label) {
        process.stdout.write(`\n    [!] ${label} page ${pages + 1} skipped: ${msg.slice(0, 60)}\n`);
      }
    }

    pages++;
    cursor = (body.nextStartInclusive ?? body.cursor ?? body.nextCursor) as string | undefined;
    if (!cursor || items.length < PAGE) break;

    await sleep(API_DELAY_MS); // Rate limit between pages
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
      `INSERT INTO trade_history (id, "tradeId", "accountId", "walletAddr", "marketId", symbol, side, size, price, role, fee, "time")
       SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::int[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::text[], $11::numeric[], $12::timestamptz[])
       ON CONFLICT ("tradeId") DO NOTHING`,
      (p) => [
        p.map(() => crypto.randomUUID()),
        p.map(t => String(t.tradeId)),
        p.map(() => id), p.map(() => w),
        p.map(t => Number(t.marketId)), p.map(t => sym(Number(t.marketId))),
        p.map(t => {
          const takerIsLong = t.takerSide === "bid";
          return role === "taker" ? (takerIsLong ? "Long" : "Short") : (takerIsLong ? "Short" : "Long");
        }),
        p.map(t => String(t.baseSize ?? 0)), p.map(t => String(t.price ?? 0)),
        p.map(() => role), p.map(() => "0"),
        p.map(t => safeDate(t.time)),
      ],
      `trades(${role})`,
    );
    await sleep(API_DELAY_MS);
  }
  return total;
}

async function syncOrders(id: number, w: string): Promise<number> {
  return streamPages(
    `${API}/account/${id}/orders`,
    `INSERT INTO order_history (id, "orderId", "accountId", "walletAddr", "marketId", symbol, side, "placedSize", "filledSize", "placedPrice", "orderValue", "fillMode", "fillStatus", status, "isReduceOnly", "addedAt", "updatedAt")
     SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::int[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[], $12::text[], $13::text[], $14::text[], $15::boolean[], $16::timestamptz[], $17::timestamptz[])
     ON CONFLICT ("orderId") DO NOTHING`,
    (p) => [
      p.map(() => crypto.randomUUID()),
      p.map(o => String(o.orderId)),
      p.map(() => id), p.map(() => w),
      p.map(o => Number(o.marketId)), p.map(o => String(o.marketSymbol ?? sym(Number(o.marketId)))),
      p.map(o => o.side === "bid" ? "Long" : "Short"),
      p.map(o => String(o.placedSize ?? 0)),
      p.map(o => o.filledSize != null ? String(o.filledSize) : null),
      p.map(o => String(o.placedPrice ?? 0)),
      p.map(o => String((Number(o.placedPrice) || 0) * (Number(o.placedSize) || 0))),
      p.map(o => String(o.fillMode ?? "unknown")),
      p.map(o => o.filledSize != null && Number(o.filledSize) > 0 ? "Filled" : "Unfilled"),
      p.map(o => String(o.finalizationReason ?? "unknown")),
      p.map(o => Boolean(o.isReduceOnly)),
      p.map(o => safeDate(o.addedAt)), p.map(o => safeDate(o.updatedAt)),
    ],
    "orders",
  );
}

async function syncPnl(id: number, w: string): Promise<number> {
  return streamPages(
    `${API}/account/${id}/history/pnl`,
    `INSERT INTO pnl_history (id, "accountId", "walletAddr", "marketId", symbol, "tradingPnl", "settledFundingPnl", "positionSize", "time")
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::int[], $5::text[], $6::numeric[], $7::numeric[], $8::numeric[], $9::timestamptz[])
     ON CONFLICT ("walletAddr", "marketId", "time") DO NOTHING`,
    (p) => [
      p.map(() => crypto.randomUUID()),
      p.map(() => id), p.map(() => w),
      p.map(x => Number(x.marketId)), p.map(x => sym(Number(x.marketId))),
      p.map(x => String(x.tradingPnl ?? 0)), p.map(x => String(x.settledFundingPnl ?? 0)),
      p.map(x => String(x.positionSize ?? 0)), p.map(x => safeDate(x.time)),
    ],
    "pnl",
  );
}

async function syncFunding(id: number, w: string): Promise<number> {
  return streamPages(
    `${API}/account/${id}/history/funding`,
    `INSERT INTO funding_history (id, "accountId", "walletAddr", "marketId", symbol, "fundingPnl", "positionSize", "time")
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::int[], $5::text[], $6::numeric[], $7::numeric[], $8::timestamptz[])
     ON CONFLICT ("walletAddr", "marketId", "time") DO NOTHING`,
    (p) => [
      p.map(() => crypto.randomUUID()),
      p.map(() => id), p.map(() => w),
      p.map(x => Number(x.marketId)), p.map(x => sym(Number(x.marketId))),
      p.map(x => String(x.fundingPnl ?? 0)), p.map(x => String(x.positionSize ?? 0)),
      p.map(x => safeDate(x.time)),
    ],
    "funding",
  );
}

async function syncDeposits(id: number, w: string): Promise<number> {
  return streamPages(
    `${API}/account/${id}/history/deposit`,
    `INSERT INTO deposit_history (id, "accountId", "walletAddr", amount, balance, "tokenId", "time")
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::numeric[], $5::numeric[], $6::int[], $7::timestamptz[])
     ON CONFLICT ("walletAddr", "time", amount) DO NOTHING`,
    (p) => [
      p.map(() => crypto.randomUUID()),
      p.map(() => id), p.map(() => w),
      p.map(x => String(x.amount ?? 0)), p.map(x => String(x.balance ?? 0)),
      p.map(x => Number(x.tokenId ?? 0)), p.map(x => safeDate(x.time)),
    ],
    "deposits",
  );
}

async function syncWithdrawals(id: number, w: string): Promise<number> {
  return streamPages(
    `${API}/account/${id}/history/withdrawal`,
    `INSERT INTO withdrawal_history (id, "accountId", "walletAddr", amount, balance, fee, "destPubkey", "time")
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::numeric[], $5::numeric[], $6::numeric[], $7::text[], $8::timestamptz[])
     ON CONFLICT ("walletAddr", "time", amount) DO NOTHING`,
    (p) => [
      p.map(() => crypto.randomUUID()),
      p.map(() => id), p.map(() => w),
      p.map(x => String(x.amount ?? 0)), p.map(x => String(x.balance ?? 0)),
      p.map(x => String(x.fee ?? 0)), p.map(x => String(x.destPubkey ?? "")),
      p.map(x => safeDate(x.time)),
    ],
    "withdrawals",
  );
}

async function syncLiquidations(id: number, w: string): Promise<number> {
  return streamPages(
    `${API}/account/${id}/history/liquidation`,
    `INSERT INTO liquidation_history (id, "accountId", "walletAddr", fee, "liquidationKind", margins, "time")
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::numeric[], $5::text[], $6::jsonb[], $7::timestamptz[])
     ON CONFLICT ("walletAddr", "time", fee) DO NOTHING`,
    (p) => [
      p.map(() => crypto.randomUUID()),
      p.map(() => id), p.map(() => w),
      p.map(x => String(x.fee ?? 0)), p.map(x => String(x.liquidationKind ?? "unknown")),
      p.map(x => { const { time: _, fee: __, liquidationKind: ___, ...r } = x; return JSON.stringify(r); }),
      p.map(x => safeDate(x.time)),
    ],
    "liquidations",
  );
}

// ═══════════════════════════════════════════════════════════════════
//  01.XYZ FRONTEND API — volume calendar + PnL totals
// ═══════════════════════════════════════════════════════════════════

async function syncVolumeCalendar(id: number, w: string): Promise<number> {
  const body = await getFrontend(`${FRONTEND_API}/volume-calendar/${id}`);
  if (!body) return 0;

  const days = (body.days ?? {}) as Record<string, Record<string, number>>;
  const entries = Object.entries(days);
  if (entries.length === 0) return 0;

  try {
    const result = await db.query(
      `INSERT INTO volume_calendar (id, "accountId", "walletAddr", date, volume, "makerVolume", "takerVolume", "makerFees", "takerFees", "totalFees")
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[])
       ON CONFLICT ("walletAddr", date) DO UPDATE SET
         volume = EXCLUDED.volume, "makerVolume" = EXCLUDED."makerVolume", "takerVolume" = EXCLUDED."takerVolume",
         "makerFees" = EXCLUDED."makerFees", "takerFees" = EXCLUDED."takerFees", "totalFees" = EXCLUDED."totalFees"`,
      [
        entries.map(() => crypto.randomUUID()),
        entries.map(() => id), entries.map(() => w),
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
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 60) : String(err);
    process.stdout.write(`\n    [!] volume-calendar DB insert failed: ${msg}\n`);
    return 0;
  }
}

async function syncPnlTotals(id: number, w: string): Promise<boolean> {
  const body = await getFrontend(`${FRONTEND_API}/pnl-totals/${id}`);
  if (!body) return false;

  try {
    await db.query(
      `INSERT INTO pnl_totals (id, "accountId", "walletAddr", "totalPnl", "totalTradingPnl", "totalFundingPnl", "fetchedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ("walletAddr") DO UPDATE SET
         "totalPnl" = EXCLUDED."totalPnl", "totalTradingPnl" = EXCLUDED."totalTradingPnl",
         "totalFundingPnl" = EXCLUDED."totalFundingPnl", "fetchedAt" = EXCLUDED."fetchedAt"`,
      [
        crypto.randomUUID(), id, w,
        String(body.totalPnl ?? 0),
        String(body.totalTradingPnl ?? 0),
        String(body.totalFundingPnl ?? 0),
        new Date(),
      ],
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 60) : String(err);
    process.stdout.write(`\n    [!] pnl-totals DB insert failed: ${msg}\n`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  CURSOR MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

async function isSynced(w: string): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM sync_cursors WHERE "walletAddr" = $1 LIMIT 1`, [w]);
  return r.rowCount !== null && r.rowCount > 0;
}

async function markSynced(w: string): Promise<void> {
  const now = new Date().toISOString();
  for (const t of ["trades", "orders", "pnl", "funding", "deposits", "withdrawals", "liquidations"]) {
    await db.query(
      `INSERT INTO sync_cursors (id, "walletAddr", type, cursor, "lastSyncAt")
       VALUES (gen_random_uuid(), $1, $2, $3, NOW())
       ON CONFLICT ("walletAddr", type) DO UPDATE SET cursor = $3, "lastSyncAt" = NOW()`,
      [w, t, now],
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
//  ACCOUNT RESOLUTION
// ═══════════════════════════════════════════════════════════════════

/**
 * Check if account exists on 01 Exchange.
 * Returns "account:{id}" as walletAddr key for bulk storage.
 * When a user logs in, link.ts re-labels data to their real Solana address.
 */
async function getAccountKey(id: number): Promise<string | null> {
  // Retry up to 3 times — a single 429/timeout should not skip an account
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = await get(`${API}/account/${id}`);
    if (body && typeof body === "object" && Object.keys(body).length > 0) {
      return `account:${id}`;
    }
    // null means API error or empty account — retry once to be sure
    if (attempt < 2) await sleep(2000);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
//  PROGRESS DISPLAY
// ═══════════════════════════════════════════════════════════════════

function bar(cur: number, tot: number, w = 25): string {
  const pct = tot > 0 ? cur / tot : 0;
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

const STEPS = ["trades", "orders", "pnl", "funding", "deposits", "withdrawals", "liquidations", "volume", "pnl-totals"] as const;

async function processAccount(id: number, logPrefix: string): Promise<{
  ok: boolean; records: number; wallet: string | null;
}> {
  // Step 1: Get wallet address
  const wallet = await getAccountKey(id);
  if (!wallet) return { ok: true, records: 0, wallet: null }; // doesn't exist

  // Step 2: Check if already synced
  if (!FORCE && await isSynced(wallet)) {
    return { ok: true, records: 0, wallet };
  }

  // Step 3: Sync each data type sequentially with progress
  const counts: Record<string, number> = {};

  const syncFns: Array<{ name: string; fn: () => Promise<number> }> = [
    { name: "trades", fn: () => syncTrades(id, wallet) },
    { name: "orders", fn: () => syncOrders(id, wallet) },
    { name: "pnl", fn: () => syncPnl(id, wallet) },
    { name: "funding", fn: () => syncFunding(id, wallet) },
    { name: "deposits", fn: () => syncDeposits(id, wallet) },
    { name: "withdrawals", fn: () => syncWithdrawals(id, wallet) },
    { name: "liquidations", fn: () => syncLiquidations(id, wallet) },
  ];

  for (const { name, fn } of syncFns) {
    if (shuttingDown) break;
    process.stdout.write(`\r${logPrefix} syncing ${name.padEnd(14)}                              `);
    try {
      counts[name] = await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 60) : String(err);
      process.stdout.write(`\n    [!] ${name} failed: ${msg}\n`);
      counts[name] = 0;
    }
    await sleep(API_DELAY_MS);
  }

  const sdkTotal = Object.values(counts).reduce((a, b) => a + b, 0);

  // 01.xyz frontend API — only for accounts that have actual trading data
  // Skip empty accounts to avoid hammering Vercel WAF for nothing
  if (!shuttingDown && sdkTotal > 0) {
    process.stdout.write(`\r${logPrefix} syncing volume-calendar    `);
    try { counts.volume = await syncVolumeCalendar(id, wallet); } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 60) : String(err);
      process.stdout.write(`\n    [!] volume-calendar failed: ${msg}\n`);
      counts.volume = 0;
    }
    await sleep(FRONTEND_API_DELAY_MS);

    if (!shuttingDown) {
      process.stdout.write(`\r${logPrefix} syncing pnl-totals         `);
      try { await syncPnlTotals(id, wallet); } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 60) : String(err);
        process.stdout.write(`\n    [!] pnl-totals failed: ${msg}\n`);
      }
      await sleep(FRONTEND_API_DELAY_MS);
    }
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  // Mark synced only if we completed everything and actually processed data
  // (or confirmed the account truly has no history)
  if (!shuttingDown) {
    if (total > 0 || sdkTotal === 0) {
      await markSynced(wallet);
    } else {
      process.stdout.write(`\n    [!] Account ${id} had data but 0 records inserted — NOT marking synced\n`);
    }
  }

  return { ok: true, records: total, wallet };
}

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   Clydex — 01 Exchange Full History Sync ║");
  console.log("╚══════════════════════════════════════════╝\n");
  console.log(`  Mode:        ${FORCE ? "FORCE (re-sync all)" : "RESUME (skip synced)"}`);
  console.log(`  Range:       ${FROM_ID} → ${MAX_ID}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`  Page size:   ${PAGE}`);
  console.log(`  API delay:   ${API_DELAY_MS}ms (SDK) / ${FRONTEND_API_DELAY_MS}ms (01.xyz)`);
  if (PROXIES.length) console.log(`  Proxies:     ${PROXIES.length} rotating`);
  console.log("");

  // Verify DB connection
  try {
    await db.query("SELECT 1");
    console.log("  DB connection: OK");
  } catch (err) {
    console.error("  DB connection FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  console.log("\n[1/3] Loading markets...");
  await loadMarkets();

  const totalAccounts = MAX_ID - FROM_ID + 1;
  console.log(`\n[2/3] Scanning accounts ${FROM_ID} → ${MAX_ID} (${totalAccounts} accounts)...\n`);

  const t0 = Date.now();
  let processed = 0, found = 0, synced = 0, skipped = 0, failed = 0, totalRec = 0;
  const failedIds: number[] = [];

  // Process sequentially in batches — concurrency is within a batch
  for (let start = FROM_ID; start <= MAX_ID && !shuttingDown; start += CONCURRENCY) {
    const batchEnd = Math.min(start + CONCURRENCY, MAX_ID + 1);
    const batch: Promise<{ id: number; result: { ok: boolean; records: number; wallet: string | null } }>[] = [];

    for (let id = start; id < batchEnd; id++) {
      const prefix = `  [${id}]`;
      batch.push(
        (async () => {
          // Retry up to 3 times
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const result = await processAccount(id, prefix);
              return { id, result };
            } catch (err) {
              if (attempt < 3 && !shuttingDown) {
                const msg = err instanceof Error ? err.message.slice(0, 60) : String(err);
                process.stdout.write(`\n  [${id}] attempt ${attempt}/3 failed: ${msg} — retrying in ${attempt * 10}s\n`);
                await sleep(attempt * 10_000);
              } else {
                return { id, result: { ok: false, records: 0, wallet: null } };
              }
            }
          }
          return { id, result: { ok: false, records: 0, wallet: null } };
        })()
      );
    }

    const results = await Promise.all(batch);

    for (const { id, result } of results) {
      processed++;
      if (!result.wallet) continue; // account doesn't exist
      found++;

      if (!result.ok) {
        failed++;
        failedIds.push(id);
        continue;
      }

      if (result.records === 0) {
        skipped++;
      } else {
        synced++;
        totalRec += result.records;
        process.stdout.write(`\n  [${id}] ${result.wallet.slice(0, 8)}... +${result.records} records\n`);
      }
    }

    // Progress bar after each batch
    process.stdout.write(
      `\r  ${bar(processed, totalAccounts)} ${processed}/${totalAccounts} ` +
      `| found:${found} ok:${synced} skip:${skipped} fail:${failed} ` +
      `| ${totalRec} rec | ${elapsed(Date.now() - t0)} ETA:${eta(t0, processed, totalAccounts)}   `
    );

    // Pause between batches
    if (!shuttingDown) await sleep(BETWEEN_ACCOUNTS_MS);
  }

  // ─── Final retry pass ─────────────────────────────────────────
  if (failedIds.length > 0 && !shuttingDown) {
    console.log(`\n\n[3/3] Retrying ${failedIds.length} failed accounts...\n`);
    const stillFailed: number[] = [];
    for (const id of failedIds) {
      if (shuttingDown) { stillFailed.push(id); continue; }
      try {
        const result = await processAccount(id, `  [${id}]`);
        if (result.ok && result.records > 0) {
          totalRec += result.records;
          synced++;
          failed--;
          console.log(`  [${id}] RECOVERED +${result.records} records`);
        } else if (!result.ok) {
          stillFailed.push(id);
        }
      } catch {
        stillFailed.push(id);
      }
      await sleep(BETWEEN_ACCOUNTS_MS);
    }
    if (stillFailed.length > 0) {
      console.log(`\n  Permanently failed: [${stillFailed.join(", ")}]`);
      console.log(`  Re-run: npx tsx scripts/sync-all-history.ts --force`);
    }
  }

  console.log(`\n\n  ═══ ${shuttingDown ? "PAUSED" : "DONE"} ═══`);
  console.log(`  Accounts found: ${found}`);
  console.log(`  Synced:         ${synced}`);
  console.log(`  Skipped:        ${skipped}`);
  console.log(`  Failed:         ${failed}`);
  console.log(`  Total records:  ${totalRec}`);
  console.log(`  Time:           ${elapsed(Date.now() - t0)}`);
  if (shuttingDown) {
    console.log(`\n  Resume with: npx tsx scripts/sync-all-history.ts`);
  }

  await db.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error("\nFatal:", err); process.exit(1); });
