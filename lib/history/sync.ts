import { historyPool, query, execute, uuid } from "@/lib/db-history";
import { N1_MAINNET_URL } from "@/lib/n1/constants";
import { ensureMarketCache, getCachedMarkets } from "@/lib/n1/constants";
import type { HistoryType, SyncResult, SyncProgress } from "./types";

// ─── 01 Exchange API Types ────────────────────────────────────────

interface ApiOrder {
  orderId: number;
  traderId: number;
  marketId: number;
  side: string;
  placedSize: number;
  filledSize: number | null;
  placedPrice: number;
  fillMode: string;
  finalizationReason: string;
  isReduceOnly: boolean;
  marketSymbol: string;
  addedAt: string;
  updatedAt: string;
}

interface ApiTrade {
  tradeId: number;
  price: number;
  baseSize: number;
  takerSide: string;
  time: string;
  marketId: number;
  takerId: number;
  makerId: number;
  actionId: number;
  orderId: number;
}

interface ApiPnl {
  tradingPnl: number;
  settledFundingPnl: number;
  positionSize: number;
  marketId: number;
  time: string;
  actionId: number;
}

interface ApiFunding {
  fundingPnl: number;
  positionSize: number;
  marketId: number;
  time: string;
  actionId: number;
}

interface ApiDeposit {
  amount: number;
  balance: number;
  tokenId: number;
  time: string;
  accountId: number;
  actionId: number;
  eventIndex: number;
}

interface ApiWithdrawal {
  amount: number;
  balance: number;
  fee: number;
  destPubkey: string;
  tokenId: number;
  time: string;
  accountId: number;
  actionId: number;
}

interface ApiLiquidation {
  fee: number;
  liquidationKind: string;
  time: string;
  actionId: number;
  liquidatorId: number;
  liquidateeId: number;
  marketId: number;
  orderPrice: number;
  orderSize: number;
  [key: string]: unknown;
}

interface PaginatedResponse<T> {
  data: T[];
  cursor?: string;
  hasMore: boolean;
}

// ─── API Fetcher ──────────────────────────────────────────────────

const API_BASE = N1_MAINNET_URL;
const PAGE_SIZE = 50;

async function fetchPage<T>(url: string): Promise<PaginatedResponse<T>> {
  const res = await fetch(url, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`01 API error: ${res.status} ${res.statusText} for ${url}`);
  }
  const body = await res.json();

  if (Array.isArray(body)) {
    return { data: body as T[], hasMore: body.length >= PAGE_SIZE, cursor: undefined };
  }
  const data = (body.items ?? body.data ?? body.results ?? []) as T[];
  const cursor = body.nextStartInclusive ?? body.cursor ?? body.nextCursor ?? undefined;
  return { data, cursor, hasMore: data.length >= PAGE_SIZE && cursor != null };
}

// ─── Market Symbol Resolver ───────────────────────────────────────

function marketSymbol(marketId: number): string {
  const markets = getCachedMarkets();
  const m = markets.find((mk) => mk.id === marketId);
  return m?.symbol ?? `MARKET-${marketId}`;
}

// ─── Sync Cursor Helpers ──────────────────────────────────────────
// Prisma-created columns are camelCase (no @map in schema)

async function getCursor(walletAddr: string, type: HistoryType): Promise<string | null> {
  const rows = await query<{ cursor: string | null }>(
    `SELECT cursor FROM sync_cursors WHERE "walletAddr" = $1 AND type = $2`,
    [walletAddr, type],
  );
  return rows[0]?.cursor ?? null;
}

async function setCursor(walletAddr: string, type: HistoryType, cursor: string): Promise<void> {
  await execute(
    `INSERT INTO sync_cursors (id, "walletAddr", type, cursor, "lastSyncAt")
     VALUES (gen_random_uuid(), $1, $2, $3, NOW())
     ON CONFLICT ("walletAddr", type) DO UPDATE SET cursor = $3, "lastSyncAt" = NOW()`,
    [walletAddr, type, cursor],
  );
}

// ─── Individual Sync Functions ────────────────────────────────────

async function syncTrades(accountId: number, walletAddr: string, since?: string): Promise<SyncResult> {
  let totalInserted = 0;

  for (const role of ["taker", "maker"] as const) {
    const param = role === "taker" ? "takerId" : "makerId";
    let cursor: string | undefined;
    let roleHasMore = true;

    while (roleHasMore) {
      let url = `${API_BASE}/trades?${param}=${accountId}&pageSize=${PAGE_SIZE}`;
      if (since) url += `&since=${since}`;
      if (cursor) url += `&startInclusive=${encodeURIComponent(String(cursor))}`;

      const page = await fetchPage<ApiTrade>(url);
      if (page.data.length === 0) break;

      const tradeIds = page.data.map((t) => String(t.tradeId));
      const accountIds = page.data.map(() => accountId);
      const wallets = page.data.map(() => walletAddr);
      const marketIds = page.data.map((t) => t.marketId);
      const symbols = page.data.map((t) => marketSymbol(t.marketId));
      const sides = page.data.map((t) => t.takerSide === "bid" ? "Long" : "Short");
      const sizes = page.data.map((t) => String(t.baseSize ?? 0));
      const prices = page.data.map((t) => String(t.price ?? 0));
      const roles = page.data.map(() => role);
      const fees = page.data.map(() => "0");
      const times = page.data.map((t) => new Date(t.time));
      const ids = page.data.map(() => uuid());

      const result = await historyPool.query(
        `INSERT INTO trade_history (id, "tradeId", "accountId", "walletAddr", "marketId", symbol, side, size, price, role, fee, "time")
         SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::int[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::text[], $11::numeric[], $12::timestamptz[])
         ON CONFLICT ("tradeId") DO NOTHING`,
        [ids, tradeIds, accountIds, wallets, marketIds, symbols, sides, sizes, prices, roles, fees, times],
      );
      totalInserted += result.rowCount ?? 0;

      cursor = page.cursor;
      roleHasMore = page.hasMore && !!cursor;
    }
  }

  return { type: "trades", inserted: totalInserted, hasMore: false };
}

async function syncOrders(accountId: number, walletAddr: string, since?: string): Promise<SyncResult> {
  let totalInserted = 0;
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    let url = `${API_BASE}/account/${accountId}/orders?pageSize=${PAGE_SIZE}`;
    if (since) url += `&since=${since}`;
    if (cursor) url += `&startInclusive=${encodeURIComponent(String(cursor))}`;

    const page = await fetchPage<ApiOrder>(url);
    if (page.data.length === 0) break;

    const d = page.data;
    const result = await historyPool.query(
      `INSERT INTO order_history (id, "orderId", "accountId", "walletAddr", "marketId", symbol, side, "placedSize", "filledSize", "placedPrice", "orderValue", "fillMode", "fillStatus", status, "isReduceOnly", "addedAt", "updatedAt")
       SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::int[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[], $12::text[], $13::text[], $14::text[], $15::boolean[], $16::timestamptz[], $17::timestamptz[])
       ON CONFLICT ("orderId") DO NOTHING`,
      [
        d.map(() => uuid()),
        d.map((o) => String(o.orderId)),
        d.map(() => accountId),
        d.map(() => walletAddr),
        d.map((o) => o.marketId),
        d.map((o) => o.marketSymbol ?? marketSymbol(o.marketId)),
        d.map((o) => o.side === "bid" ? "Long" : "Short"),
        d.map((o) => String(o.placedSize ?? 0)),
        d.map((o) => o.filledSize != null ? String(o.filledSize) : null),
        d.map((o) => String(o.placedPrice ?? 0)),
        d.map((o) => String((o.placedPrice ?? 0) * (o.placedSize ?? 0))),
        d.map((o) => o.fillMode ?? "unknown"),
        d.map((o) => o.filledSize != null && o.filledSize > 0 ? "Filled" : "Unfilled"),
        d.map((o) => o.finalizationReason ?? "unknown"),
        d.map((o) => o.isReduceOnly ?? false),
        d.map((o) => new Date(o.addedAt)),
        d.map((o) => new Date(o.updatedAt)),
      ],
    );
    totalInserted += result.rowCount ?? 0;

    cursor = page.cursor;
    hasMore = page.hasMore && !!cursor;
  }

  return { type: "orders", inserted: totalInserted, hasMore: false };
}

async function syncPnl(accountId: number, walletAddr: string, since?: string): Promise<SyncResult> {
  let totalInserted = 0;
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    let url = `${API_BASE}/account/${accountId}/history/pnl?pageSize=${PAGE_SIZE}`;
    if (since) url += `&since=${since}`;
    if (cursor) url += `&startInclusive=${encodeURIComponent(String(cursor))}`;

    const page = await fetchPage<ApiPnl>(url);
    if (page.data.length === 0) break;

    const d = page.data;
    const result = await historyPool.query(
      `INSERT INTO pnl_history (id, "accountId", "walletAddr", "marketId", symbol, "tradingPnl", "settledFundingPnl", "positionSize", "time")
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::int[], $5::text[], $6::numeric[], $7::numeric[], $8::numeric[], $9::timestamptz[])
       ON CONFLICT ("walletAddr", "marketId", "time") DO NOTHING`,
      [
        d.map(() => uuid()),
        d.map(() => accountId),
        d.map(() => walletAddr),
        d.map((p) => p.marketId),
        d.map((p) => marketSymbol(p.marketId)),
        d.map((p) => String(p.tradingPnl ?? 0)),
        d.map((p) => String(p.settledFundingPnl ?? 0)),
        d.map((p) => String(p.positionSize ?? 0)),
        d.map((p) => new Date(p.time)),
      ],
    );
    totalInserted += result.rowCount ?? 0;

    cursor = page.cursor;
    hasMore = page.hasMore && !!cursor;
  }

  return { type: "pnl", inserted: totalInserted, hasMore: false };
}

async function syncFunding(accountId: number, walletAddr: string, since?: string): Promise<SyncResult> {
  let totalInserted = 0;
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    let url = `${API_BASE}/account/${accountId}/history/funding?pageSize=${PAGE_SIZE}`;
    if (since) url += `&since=${since}`;
    if (cursor) url += `&startInclusive=${encodeURIComponent(String(cursor))}`;

    const page = await fetchPage<ApiFunding>(url);
    if (page.data.length === 0) break;

    const d = page.data;
    const result = await historyPool.query(
      `INSERT INTO funding_history (id, "accountId", "walletAddr", "marketId", symbol, "fundingPnl", "positionSize", "time")
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::int[], $5::text[], $6::numeric[], $7::numeric[], $8::timestamptz[])
       ON CONFLICT ("walletAddr", "marketId", "time") DO NOTHING`,
      [
        d.map(() => uuid()),
        d.map(() => accountId),
        d.map(() => walletAddr),
        d.map((f) => f.marketId),
        d.map((f) => marketSymbol(f.marketId)),
        d.map((f) => String(f.fundingPnl ?? 0)),
        d.map((f) => String(f.positionSize ?? 0)),
        d.map((f) => new Date(f.time)),
      ],
    );
    totalInserted += result.rowCount ?? 0;

    cursor = page.cursor;
    hasMore = page.hasMore && !!cursor;
  }

  return { type: "funding", inserted: totalInserted, hasMore: false };
}

async function syncDeposits(accountId: number, walletAddr: string, since?: string): Promise<SyncResult> {
  let totalInserted = 0;
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    let url = `${API_BASE}/account/${accountId}/history/deposit?pageSize=${PAGE_SIZE}`;
    if (since) url += `&since=${since}`;
    if (cursor) url += `&startInclusive=${encodeURIComponent(String(cursor))}`;

    const page = await fetchPage<ApiDeposit>(url);
    if (page.data.length === 0) break;

    const d = page.data;
    const result = await historyPool.query(
      `INSERT INTO deposit_history (id, "accountId", "walletAddr", amount, balance, "tokenId", "time")
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::numeric[], $5::numeric[], $6::int[], $7::timestamptz[])
       ON CONFLICT ("walletAddr", "time", amount) DO NOTHING`,
      [
        d.map(() => uuid()),
        d.map(() => accountId),
        d.map(() => walletAddr),
        d.map((dep) => String(dep.amount ?? 0)),
        d.map((dep) => String(dep.balance ?? 0)),
        d.map((dep) => dep.tokenId ?? 0),
        d.map((dep) => new Date(dep.time)),
      ],
    );
    totalInserted += result.rowCount ?? 0;

    cursor = page.cursor;
    hasMore = page.hasMore && !!cursor;
  }

  return { type: "deposits", inserted: totalInserted, hasMore: false };
}

async function syncWithdrawals(accountId: number, walletAddr: string, since?: string): Promise<SyncResult> {
  let totalInserted = 0;
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    let url = `${API_BASE}/account/${accountId}/history/withdrawal?pageSize=${PAGE_SIZE}`;
    if (since) url += `&since=${since}`;
    if (cursor) url += `&startInclusive=${encodeURIComponent(String(cursor))}`;

    const page = await fetchPage<ApiWithdrawal>(url);
    if (page.data.length === 0) break;

    const d = page.data;
    const result = await historyPool.query(
      `INSERT INTO withdrawal_history (id, "accountId", "walletAddr", amount, balance, fee, "destPubkey", "time")
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::numeric[], $5::numeric[], $6::numeric[], $7::text[], $8::timestamptz[])
       ON CONFLICT ("walletAddr", "time", amount) DO NOTHING`,
      [
        d.map(() => uuid()),
        d.map(() => accountId),
        d.map(() => walletAddr),
        d.map((w) => String(w.amount ?? 0)),
        d.map((w) => String(w.balance ?? 0)),
        d.map((w) => String(w.fee ?? 0)),
        d.map((w) => w.destPubkey ?? ""),
        d.map((w) => new Date(w.time)),
      ],
    );
    totalInserted += result.rowCount ?? 0;

    cursor = page.cursor;
    hasMore = page.hasMore && !!cursor;
  }

  return { type: "withdrawals", inserted: totalInserted, hasMore: false };
}

async function syncLiquidations(accountId: number, walletAddr: string, since?: string): Promise<SyncResult> {
  let totalInserted = 0;
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    let url = `${API_BASE}/account/${accountId}/history/liquidation?pageSize=${PAGE_SIZE}`;
    if (since) url += `&since=${since}`;
    if (cursor) url += `&startInclusive=${encodeURIComponent(String(cursor))}`;

    const page = await fetchPage<ApiLiquidation>(url);
    if (page.data.length === 0) break;

    const d = page.data;
    const result = await historyPool.query(
      `INSERT INTO liquidation_history (id, "accountId", "walletAddr", fee, "liquidationKind", margins, "time")
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::numeric[], $5::text[], $6::jsonb[], $7::timestamptz[])
       ON CONFLICT ("walletAddr", "time", fee) DO NOTHING`,
      [
        d.map(() => uuid()),
        d.map(() => accountId),
        d.map(() => walletAddr),
        d.map((l) => String(l.fee ?? 0)),
        d.map((l) => String(l.liquidationKind ?? "unknown")),
        d.map((l) => {
          const { time: _t, fee: _f, liquidationKind: _lk, ...rest } = l;
          return JSON.stringify(rest);
        }),
        d.map((l) => new Date(l.time)),
      ],
    );
    totalInserted += result.rowCount ?? 0;

    cursor = page.cursor;
    hasMore = page.hasMore && !!cursor;
  }

  return { type: "liquidations", inserted: totalInserted, hasMore: false };
}

// ─── 01.xyz Frontend API Sync ────────────────────────────────────

const FRONTEND_API = "https://01.xyz/api";
const BROWSER_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Referer: "https://01.xyz/",
  Origin: "https://01.xyz",
};

export async function syncVolumeCalendar(accountId: number, walletAddr: string): Promise<number> {
  try {
    const res = await fetch(`${FRONTEND_API}/volume-calendar/${accountId}`, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return 0;
    const body = await res.json();
    const days = body.days ?? {};
    const entries = Object.entries(days) as [string, Record<string, number>][];
    if (entries.length === 0) return 0;

    const result = await historyPool.query(
      `INSERT INTO volume_calendar (id, "accountId", "walletAddr", date, volume, "makerVolume", "takerVolume", "makerFees", "takerFees", "totalFees")
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[])
       ON CONFLICT ("walletAddr", date) DO UPDATE SET
         volume = EXCLUDED.volume, "makerVolume" = EXCLUDED."makerVolume", "takerVolume" = EXCLUDED."takerVolume",
         "makerFees" = EXCLUDED."makerFees", "takerFees" = EXCLUDED."takerFees", "totalFees" = EXCLUDED."totalFees"`,
      [
        entries.map(() => uuid()),
        entries.map(() => accountId),
        entries.map(() => walletAddr),
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
    console.error(`[sync] volume-calendar/${accountId} failed:`, err);
    return 0;
  }
}

export async function syncPnlTotals(accountId: number, walletAddr: string): Promise<boolean> {
  try {
    const res = await fetch(`${FRONTEND_API}/pnl-totals/${accountId}`, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const body = await res.json();

    await historyPool.query(
      `INSERT INTO pnl_totals (id, "accountId", "walletAddr", "totalPnl", "totalTradingPnl", "totalFundingPnl", "fetchedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ("walletAddr") DO UPDATE SET
         "totalPnl" = EXCLUDED."totalPnl", "totalTradingPnl" = EXCLUDED."totalTradingPnl",
         "totalFundingPnl" = EXCLUDED."totalFundingPnl", "fetchedAt" = EXCLUDED."fetchedAt"`,
      [
        uuid(),
        accountId,
        walletAddr,
        String(body.totalPnl ?? 0),
        String(body.totalTradingPnl ?? 0),
        String(body.totalFundingPnl ?? 0),
        new Date(body.fetchedAt ?? new Date().toISOString()),
      ],
    );
    return true;
  } catch (err) {
    console.error(`[sync] pnl-totals/${accountId} failed:`, err);
    return false;
  }
}

// ─── Sync Dispatcher ──────────────────────────────────────────────

const SYNC_FNS: Record<HistoryType, (accountId: number, walletAddr: string, since?: string) => Promise<SyncResult>> = {
  trades: syncTrades,
  orders: syncOrders,
  pnl: syncPnl,
  funding: syncFunding,
  deposits: syncDeposits,
  withdrawals: syncWithdrawals,
  liquidations: syncLiquidations,
};

// ─── Public API ───────────────────────────────────────────────────

export async function syncAllHistory(
  accountId: number,
  walletAddr: string,
  onProgress?: (progress: SyncProgress) => void,
): Promise<SyncResult[]> {
  await ensureMarketCache();

  const types: HistoryType[] = ["trades", "orders", "pnl", "funding", "deposits", "withdrawals", "liquidations"];
  const results: SyncResult[] = [];

  for (const type of types) {
    const since = await getCursor(walletAddr, type);
    const syncFn = SYNC_FNS[type];

    try {
      const result = await syncFn(accountId, walletAddr, since ?? undefined);
      results.push(result);
      await setCursor(walletAddr, type, new Date().toISOString());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[history/sync] ${type} sync failed for ${walletAddr}:`, msg);
      results.push({ type, inserted: 0, hasMore: false, error: msg });
    }

    onProgress?.({ total: types.length, completed: results.length, results });
  }

  // Also sync 01.xyz frontend data (volume-calendar + pnl-totals)
  try {
    await Promise.all([
      syncVolumeCalendar(accountId, walletAddr),
      syncPnlTotals(accountId, walletAddr),
    ]);
  } catch (err) {
    console.error(`[history/sync] frontend API sync failed for ${walletAddr}:`, err);
  }

  return results;
}

export async function syncHistoryType(
  accountId: number,
  walletAddr: string,
  type: HistoryType,
): Promise<SyncResult> {
  await ensureMarketCache();

  const since = await getCursor(walletAddr, type);
  const syncFn = SYNC_FNS[type];

  try {
    const result = await syncFn(accountId, walletAddr, since ?? undefined);
    await setCursor(walletAddr, type, new Date().toISOString());
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[history/sync] ${type} sync failed for ${walletAddr}:`, msg);
    return { type, inserted: 0, hasMore: false, error: msg };
  }
}

export async function hasBeenSynced(walletAddr: string): Promise<boolean> {
  const rows = await query<{ synced: boolean }>(
    `SELECT count(*) > 0 AS synced FROM sync_cursors WHERE "walletAddr" = $1`,
    [walletAddr],
  );
  return rows[0]?.synced ?? false;
}

export async function getLastSyncTime(walletAddr: string): Promise<Date | null> {
  const rows = await query<{ lastSyncAt: Date }>(
    `SELECT "lastSyncAt" FROM sync_cursors WHERE "walletAddr" = $1 ORDER BY "lastSyncAt" DESC LIMIT 1`,
    [walletAddr],
  );
  return rows[0]?.lastSyncAt ?? null;
}

export type { HistoryType, SyncResult, SyncProgress };
