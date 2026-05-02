import { historyPool, query, execute, uuid } from "@/lib/db-history";
import { N1_MAINNET_URL } from "@/lib/n1/constants";
import { ensureMarketCache, getCachedMarkets } from "@/lib/n1/constants";
import type { FetchContext } from "./fetch-context";
import { retryableFetch } from "./fetch-context";
import { recomputePnlTotals, recomputeVolumeCalendar, recomputeAggregates } from "./aggregate";
import type { HistoryType, SyncResult, SyncProgress } from "./types";

// ─── 01 Exchange API Types ────────────────────────────────────────

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

async function fetchPage<T>(url: string, ctx?: FetchContext): Promise<PaginatedResponse<T>> {
  const res = ctx?.agent
    ? await retryableFetch(url, {
        headers: { "Accept": "application/json" },
        agent: ctx.agent,
        timeoutMs: 15_000,
        retries: 3,
      })
    : await fetch(url, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(15_000),
      });

  if (!res.ok) {
    throw new Error(`01 API error: ${res.status} ${res.statusText} for ${url}`);
  }
  const body = await res.json();

  if (ctx?.postDelayMs) {
    await new Promise((r) => setTimeout(r, ctx.postDelayMs));
  }

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

async function syncTrades(accountId: number, walletAddr: string, since?: string, ctx?: FetchContext): Promise<SyncResult> {
  let totalInserted = 0;

  for (const role of ["taker", "maker"] as const) {
    const param = role === "taker" ? "takerId" : "makerId";
    let cursor: string | undefined;
    let roleHasMore = true;

    while (roleHasMore) {
      let url = `${API_BASE}/trades?${param}=${accountId}&pageSize=${PAGE_SIZE}`;
      if (since) url += `&since=${encodeURIComponent(since)}`;
      if (cursor) url += `&startInclusive=${encodeURIComponent(String(cursor))}`;

      const page = await fetchPage<ApiTrade>(url, ctx);
      if (page.data.length === 0) break;

      const tradeIds = page.data.map((t) => String(t.tradeId));
      const accountIds = page.data.map(() => accountId);
      const wallets = page.data.map(() => walletAddr);
      const marketIds = page.data.map((t) => t.marketId);
      const symbols = page.data.map((t) => marketSymbol(t.marketId));
      const sides = page.data.map((t) => {
        const takerIsLong = t.takerSide === "bid";
        return role === "taker" ? (takerIsLong ? "Long" : "Short") : (takerIsLong ? "Short" : "Long");
      });
      const sizes = page.data.map((t) => String(t.baseSize ?? 0));
      const prices = page.data.map((t) => String(t.price ?? 0));
      const roles = page.data.map(() => role);
      const fees = page.data.map(() => "0");
      const times = page.data.map((t) => new Date(t.time));
      const ids = page.data.map(() => uuid());
      // orderId links trade → parent order. Used by /api/history/orders to
      // derive the "Order History" tab (GROUP BY orderId) instead of
      // maintaining a separate order_history table. The column is nullable,
      // so pre-2026-04-19 trades stay consistent; new syncs populate it.
      const orderIds = page.data.map((t) => (t.orderId != null ? String(t.orderId) : null));

      const result = await historyPool.query(
        // Explicit ON CONFLICT target = (accountId, tradeId, time).
        //
        // Pre-2026-05-02 we used target-less ON CONFLICT, which silently
        // matched the OLD (tradeId, time) UNIQUE — and that constraint
        // discarded the second participant of every multi-party trade
        // (taker dropped if maker synced first, or vice versa). Months
        // of data loss masquerading as "sync ran cleanly". See
        // sql/2026-05-02_trade_history_two_sided.sql for the full
        // post-mortem.
        //
        // The new key (accountId, tradeId, time) lets each side coexist
        // because each row has its own accountId. ON CONFLICT therefore
        // only fires on a true re-sync of the same participant's view
        // of a trade — which is what we want.
        `INSERT INTO trade_history (id, "tradeId", "accountId", "walletAddr", "marketId", symbol, side, size, price, role, fee, "time", "orderId")
         SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::int[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::text[], $11::numeric[], $12::timestamptz[], $13::text[])
         ON CONFLICT ("accountId", "tradeId", "time") DO NOTHING`,
        [ids, tradeIds, accountIds, wallets, marketIds, symbols, sides, sizes, prices, roles, fees, times, orderIds],
      );
      const insertedThisPage = result.rowCount ?? 0;
      totalInserted += insertedThisPage;
      // Surface fetched/inserted gap so a future B1-class data-loss bug
      // (silent ON CONFLICT discard) shows up in `docker compose logs`.
      // We only log when there's a discrepancy or activity worth noting —
      // a fully-deduplicated re-sync of an inactive account stays silent.
      if (page.data.length > 0 && (insertedThisPage === 0 || page.data.length !== insertedThisPage)) {
        console.log(
          `[history/sync] trades ${role}=${accountId} fetched=${page.data.length} inserted=${insertedThisPage}`,
        );
      }

      cursor = page.cursor;
      roleHasMore = page.hasMore && !!cursor;
    }
  }

  return { type: "trades", inserted: totalInserted, hasMore: false };
}

// syncOrders removed on 2026-04-19. /account/{id}/orders is no longer hit;
// the "Order History" tab is derived from trade_history GROUP BY orderId
// (see lib/history/queries.ts#getOrderHistoryFromTrades).

async function syncPnl(accountId: number, walletAddr: string, since?: string, ctx?: FetchContext): Promise<SyncResult> {
  let totalInserted = 0;
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    let url = `${API_BASE}/account/${accountId}/history/pnl?pageSize=${PAGE_SIZE}`;
    if (since) url += `&since=${encodeURIComponent(since)}`;
    if (cursor) url += `&startInclusive=${encodeURIComponent(String(cursor))}`;

    const page = await fetchPage<ApiPnl>(url, ctx);
    if (page.data.length === 0) break;

    const d = page.data;
    const result = await historyPool.query(
      // Unique constraint is on ("accountId", "marketId", "time") after the
      // 2026-04-18 schema fix. ON CONFLICT ("walletAddr", "marketId", "time")
      // here used to crash every insert once the wallet-scoped index was
      // dropped — see sql/2026-04-18_unique_by_accountid.sql.
      `INSERT INTO pnl_history (id, "accountId", "walletAddr", "marketId", symbol, "tradingPnl", "settledFundingPnl", "positionSize", "time")
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::int[], $5::text[], $6::numeric[], $7::numeric[], $8::numeric[], $9::timestamptz[])
       ON CONFLICT ("accountId", "marketId", "time") DO NOTHING`,
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

async function syncFunding(accountId: number, walletAddr: string, since?: string, ctx?: FetchContext): Promise<SyncResult> {
  // Pagination strategy for /account/{id}/history/funding:
  //
  // The 01 API returns a `nextStartInclusive` cursor that LOOKS pagey
  // ("2026-05-02 9:00:01.717604 +00:00:00_0") but rejects with 400 when
  // passed back via &startInclusive=. Confirmed empirically 2026-05-02
  // — the URL form the API returns is not consumable by the same API.
  //
  // We sidestep it: the funding endpoint is "ordered from present to
  // past" and supports `since` (lower bound, inclusive) and `until`
  // (upper bound, defaults to now). For each subsequent page we set
  // `until = MIN(time)` of the previous page to walk further into the
  // past while keeping the same `since`. Events at exactly that
  // boundary time get re-fetched and are absorbed by ON CONFLICT.
  //
  // Loop guards:
  //   - MAX_PAGES caps runaway pagination (a stuck cursor would otherwise
  //     spin forever — possible if every event in a page shares the
  //     same `time`).
  //   - If a page produces ZERO new inserts AND the boundary time
  //     hasn't moved, we break — no further progress possible.
  const MAX_PAGES = 200; // 200 × 50 = 10k events per single sync, plenty
  let totalInserted = 0;
  let until: string | undefined;
  let prevUntil: string | undefined;

  for (let page_i = 0; page_i < MAX_PAGES; page_i++) {
    let url = `${API_BASE}/account/${accountId}/history/funding?pageSize=${PAGE_SIZE}`;
    if (since) url += `&since=${encodeURIComponent(since)}`;
    if (until) url += `&until=${encodeURIComponent(until)}`;

    const page = await fetchPage<ApiFunding>(url, ctx);
    if (page.data.length === 0) break;

    const d = page.data;
    const result = await historyPool.query(
      `INSERT INTO funding_history (id, "accountId", "walletAddr", "marketId", symbol, "fundingPnl", "positionSize", "time")
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::int[], $5::text[], $6::numeric[], $7::numeric[], $8::timestamptz[])
       ON CONFLICT ("accountId", "marketId", "time") DO NOTHING`,
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
    const insertedThisPage = result.rowCount ?? 0;
    totalInserted += insertedThisPage;

    // Find the oldest `time` in this page → next page's `until`.
    let oldest: string | undefined;
    for (const f of d) {
      if (oldest === undefined || f.time < oldest) oldest = f.time;
    }

    // Termination: API returned data older than what we already covered
    // AND no new rows landed → boundary is stuck, nothing more to do.
    if (insertedThisPage === 0 && oldest === prevUntil) break;

    prevUntil = until;
    until = oldest;
  }

  return { type: "funding", inserted: totalInserted, hasMore: false };
}

async function syncDeposits(accountId: number, walletAddr: string, since?: string, ctx?: FetchContext): Promise<SyncResult> {
  let totalInserted = 0;
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    let url = `${API_BASE}/account/${accountId}/history/deposit?pageSize=${PAGE_SIZE}`;
    if (since) url += `&since=${encodeURIComponent(since)}`;
    if (cursor) url += `&startInclusive=${encodeURIComponent(String(cursor))}`;

    const page = await fetchPage<ApiDeposit>(url, ctx);
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

async function syncWithdrawals(accountId: number, walletAddr: string, since?: string, ctx?: FetchContext): Promise<SyncResult> {
  let totalInserted = 0;
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    let url = `${API_BASE}/account/${accountId}/history/withdrawal?pageSize=${PAGE_SIZE}`;
    if (since) url += `&since=${encodeURIComponent(since)}`;
    if (cursor) url += `&startInclusive=${encodeURIComponent(String(cursor))}`;

    const page = await fetchPage<ApiWithdrawal>(url, ctx);
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

async function syncLiquidations(accountId: number, walletAddr: string, since?: string, ctx?: FetchContext): Promise<SyncResult> {
  let totalInserted = 0;
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    let url = `${API_BASE}/account/${accountId}/history/liquidation?pageSize=${PAGE_SIZE}`;
    if (since) url += `&since=${encodeURIComponent(since)}`;
    if (cursor) url += `&startInclusive=${encodeURIComponent(String(cursor))}`;

    const page = await fetchPage<ApiLiquidation>(url, ctx);
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

// ─── Aggregated views: pnl_totals + volume_calendar ───────────────
// Historically fetched from the 01.xyz frontend API (/api/pnl-totals/:id,
// /api/volume-calendar/:id), which is now behind a Vercel WAF JS challenge.
// Both values are pure aggregations over the raw tables above, so we
// recompute them locally. Callers keep the same signatures for backward
// compatibility — the `ctx` argument is accepted and ignored (no HTTP).
// See lib/history/aggregate.ts for the actual SQL and funding-model options.

export async function syncVolumeCalendar(
  accountId: number,
  walletAddr: string,
  _ctx?: FetchContext,
): Promise<number> {
  try {
    return await recomputeVolumeCalendar(accountId, walletAddr);
  } catch (err) {
    console.error(`[sync] recompute volume-calendar/${accountId} failed:`, err);
    return 0;
  }
}

export async function syncPnlTotals(
  accountId: number,
  walletAddr: string,
  _ctx?: FetchContext,
): Promise<boolean> {
  try {
    await recomputePnlTotals(accountId, walletAddr);
    return true;
  } catch (err) {
    console.error(`[sync] recompute pnl-totals/${accountId} failed:`, err);
    return false;
  }
}

// ─── Sync Dispatcher ──────────────────────────────────────────────

type SyncFn = (accountId: number, walletAddr: string, since?: string, ctx?: FetchContext) => Promise<SyncResult>;

const SYNC_FNS: Record<HistoryType, SyncFn> = {
  trades: syncTrades,
  pnl: syncPnl,
  funding: syncFunding,
  deposits: syncDeposits,
  withdrawals: syncWithdrawals,
  liquidations: syncLiquidations,
};

// ─── Public API ───────────────────────────────────────────────────

/**
 * Sync all relevant history types for one account.
 *
 * `orders` was previously a sync type of its own but has been removed as of
 * 2026-04-19. Market-maker accounts have 25M+ orders each, which blew up a
 * 75 GB disk on the Hetzner box (see commit e32b66b and the disk-crash
 * incident). Orders are now derived from trade_history grouped by orderId
 * — that covers every filled order for zero extra sync cost. See
 * lib/history/queries.ts#getOrderHistoryFromTrades.
 */
export async function syncAllHistory(
  accountId: number,
  walletAddr: string,
  onProgress?: (progress: SyncProgress) => void,
  ctx?: FetchContext,
): Promise<SyncResult[]> {
  await ensureMarketCache();

  const types: HistoryType[] = ["trades", "pnl", "funding", "deposits", "withdrawals", "liquidations"];
  const results: SyncResult[] = [];

  for (const type of types) {
    const since = await getCursor(walletAddr, type);
    const syncFn = SYNC_FNS[type];

    try {
      const result = await syncFn(accountId, walletAddr, since ?? undefined, ctx);
      results.push(result);
      await setCursor(walletAddr, type, new Date().toISOString());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[history/sync] ${type} sync failed for ${walletAddr}:`, msg);
      results.push({ type, inserted: 0, hasMore: false, error: msg });
    }

    onProgress?.({ total: types.length, completed: results.length, results });
  }

  // Rebuild aggregated tables (pnl_totals + volume_calendar) from the raw
  // data we just synced. Pure SQL, no external HTTP — replaces the old
  // Vercel frontend API fetch that now sits behind a WAF challenge.
  try {
    await recomputeAggregates(accountId, walletAddr);
  } catch (err) {
    console.error(`[history/sync] aggregate recompute failed for ${walletAddr}:`, err);
  }

  return results;
}

export async function syncHistoryType(
  accountId: number,
  walletAddr: string,
  type: HistoryType,
  ctx?: FetchContext,
): Promise<SyncResult> {
  await ensureMarketCache();

  const since = await getCursor(walletAddr, type);
  const syncFn = SYNC_FNS[type];

  try {
    const result = await syncFn(accountId, walletAddr, since ?? undefined, ctx);
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
