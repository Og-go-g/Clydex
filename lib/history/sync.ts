import { historyPool, query, execute } from "@/lib/db-history";
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

async function getCursor(walletAddr: string, type: HistoryType): Promise<string | null> {
  const rows = await query<{ cursor: string | null }>(
    `SELECT cursor FROM sync_cursors WHERE wallet_addr = $1 AND type = $2`,
    [walletAddr, type],
  );
  return rows[0]?.cursor ?? null;
}

async function setCursor(walletAddr: string, type: HistoryType, cursor: string): Promise<void> {
  await execute(
    `INSERT INTO sync_cursors (wallet_addr, type, cursor, last_sync_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (wallet_addr, type) DO UPDATE SET cursor = $3, last_sync_at = NOW()`,
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

      const result = await historyPool.query(
        `INSERT INTO trade_history (trade_id, account_id, wallet_addr, market_id, symbol, side, size, price, role, fee, "time")
         SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::int[], $5::text[], $6::text[], $7::numeric[], $8::numeric[], $9::text[], $10::numeric[], $11::timestamptz[])
         ON CONFLICT (trade_id, "time") DO NOTHING`,
        [tradeIds, accountIds, wallets, marketIds, symbols, sides, sizes, prices, roles, fees, times],
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
      `INSERT INTO order_history (order_id, account_id, wallet_addr, market_id, symbol, side, placed_size, filled_size, placed_price, order_value, fill_mode, fill_status, status, is_reduce_only, added_at, updated_at)
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::int[], $5::text[], $6::text[], $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[], $11::text[], $12::text[], $13::text[], $14::boolean[], $15::timestamptz[], $16::timestamptz[])
       ON CONFLICT (order_id, added_at) DO NOTHING`,
      [
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
      `INSERT INTO pnl_history (account_id, wallet_addr, market_id, symbol, trading_pnl, settled_funding_pnl, position_size, "time")
       SELECT * FROM unnest($1::int[], $2::text[], $3::int[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[], $8::timestamptz[])
       ON CONFLICT (wallet_addr, market_id, "time") DO NOTHING`,
      [
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
      `INSERT INTO funding_history (account_id, wallet_addr, market_id, symbol, funding_pnl, position_size, "time")
       SELECT * FROM unnest($1::int[], $2::text[], $3::int[], $4::text[], $5::numeric[], $6::numeric[], $7::timestamptz[])
       ON CONFLICT (wallet_addr, market_id, "time") DO NOTHING`,
      [
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
      `INSERT INTO deposit_history (account_id, wallet_addr, amount, balance, token_id, "time")
       SELECT * FROM unnest($1::int[], $2::text[], $3::numeric[], $4::numeric[], $5::int[], $6::timestamptz[])
       ON CONFLICT (wallet_addr, "time", amount) DO NOTHING`,
      [
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
      `INSERT INTO withdrawal_history (account_id, wallet_addr, amount, balance, fee, dest_pubkey, "time")
       SELECT * FROM unnest($1::int[], $2::text[], $3::numeric[], $4::numeric[], $5::numeric[], $6::text[], $7::timestamptz[])
       ON CONFLICT (wallet_addr, "time", amount) DO NOTHING`,
      [
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
      `INSERT INTO liquidation_history (account_id, wallet_addr, fee, liquidation_kind, margins, "time")
       SELECT * FROM unnest($1::int[], $2::text[], $3::numeric[], $4::text[], $5::jsonb[], $6::timestamptz[])
       ON CONFLICT (wallet_addr, "time", fee) DO NOTHING`,
      [
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
    `SELECT count(*) > 0 AS synced FROM sync_cursors WHERE wallet_addr = $1`,
    [walletAddr],
  );
  return rows[0]?.synced ?? false;
}

export async function getLastSyncTime(walletAddr: string): Promise<Date | null> {
  const rows = await query<{ last_sync_at: Date }>(
    `SELECT last_sync_at FROM sync_cursors WHERE wallet_addr = $1 ORDER BY last_sync_at DESC LIMIT 1`,
    [walletAddr],
  );
  return rows[0]?.last_sync_at ?? null;
}

export type { HistoryType, SyncResult, SyncProgress };
