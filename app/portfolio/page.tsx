"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useWallet } from "@/lib/wallet/context";
import { useAuth } from "@/lib/auth/context";
import { DepositWithdrawModal } from "@/components/collateral/DepositWithdrawModal";
import { ClosePositionModal } from "@/components/collateral/ClosePositionModal";
import { EquityChart, invalidateEquityCache } from "@/components/charts/EquityChart";
import { useRealtimePrices } from "@/hooks/useRealtimePrices";
import { usePageActive } from "@/hooks/usePageActive";
import { useOrderActions } from "@/hooks/useOrderActions";

// Minimum position size threshold — positions below this are treated as dust/zero
const MIN_POS_SIZE = 1e-12;

// ─── History Types ──────────────────────────────────────────────

interface OrderRow { id: string; orderId: string; marketId: number; symbol: string; side: string; placedSize: string; filledSize: string | null; placedPrice: string; orderValue: string; fillMode: string; fillStatus: string; status: string; addedAt: string }
interface TradeRow { id: string; tradeId: string; marketId: number; symbol: string; side: string; size: string; price: string; role: string; fee: string; closedPnl: string | null; time: string }
interface FundingRow { id: string; marketId: number; symbol: string; fundingPnl: string; positionSize: string; time: string }
interface DepositRow { id: string; amount: string; balance: string; time: string }
interface WithdrawalRow { id: string; amount: string; balance: string; fee: string; destPubkey: string; time: string }
interface PagedResult<T> { data: T[]; total: number; limit: number; offset: number }
interface TransferResult { deposits: PagedResult<DepositRow>; withdrawals: PagedResult<WithdrawalRow> }
interface SyncStatus { synced: boolean; lastSyncAt: string | null }
interface SyncResultItem { type: string; inserted: number; error?: string }

// ─── History Formatters ─────────────────────────────────────────

function hFmtUsd(v: string | number, decimals = 2): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!isFinite(n) || n === 0) return "--";
  return (n < 0 ? "-" : "") + "$" + Math.abs(n).toFixed(decimals);
}
function hFmtPrice(v: string | number): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!isFinite(n)) return "$0.00";
  const d = Math.abs(n) < 1 ? 6 : Math.abs(n) < 100 ? 4 : 2;
  return "$" + n.toFixed(d).replace(/0+$/, "").replace(/\.$/, "");
}
function hFmtSize(v: string | number): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!isFinite(n)) return "0";
  const d = Math.abs(n) < 0.01 ? 6 : Math.abs(n) < 1 ? 4 : 2;
  return n.toFixed(d);
}
function hFmtDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} - ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
function hFmtAddr(a: string): string { return !a || a.length <= 10 ? a || "--" : a.slice(0, 4) + "..." + a.slice(-4); }
function hPnlColor(v: string | number): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return n > 0.001 ? "text-emerald-400" : n < -0.001 ? "text-red-400" : "text-muted";
}
function hTradeValue(price: string, size: string): number {
  const p = parseFloat(price), s = parseFloat(size);
  return isFinite(p) && isFinite(s) ? Math.abs(p * s) : 0;
}
const TAKER_FEE = 0.00035, MAKER_FEE = 0.0001;
function hEstFee(tv: number, role: string, dbFee: string): number {
  const f = parseFloat(dbFee);
  if (isFinite(f) && f !== 0) return f;
  return tv > 0 ? tv * (role === "taker" ? TAKER_FEE : MAKER_FEE) : 0;
}

function HDateCell({ iso, className }: { iso: string; className: string }) {
  const [text, setText] = React.useState("");
  React.useEffect(() => { setText(hFmtDate(iso)); }, [iso]);
  return <td className={className}>{text || "\u00A0"}</td>;
}

const HISTORY_PAGE = 50;
const HTH = "px-4 py-3 text-left text-xs font-medium text-muted";
const HTD = "whitespace-nowrap px-4 py-3 text-sm";

type PortfolioTab = "positions" | "orders" | "trades" | "orderHistory" | "funding" | "transfers";

// ─── Types matching the normalized /api/account response ────────

interface Position {
  marketId: number;
  symbol: string;
  openOrders: number;
  marketImf: number;
  marketMmf: number;
  marketCmf?: number;
  maxLeverage: number;
  markPrice: number | null;
  perp?: {
    baseSize: number;
    price: number;
    isLong: boolean;
    sizePricePnl: number;
    fundingPaymentPnl: number;
  };
}

interface OpenOrder {
  orderId: number;
  marketId: number;
  symbol: string;
  side: "bid" | "ask";
  size: number;
  price: number;
  /** Real placement time from 01 Exchange order history (RFC3339 string) */
  placedAt?: string | null;
}

interface Balance {
  tokenId: number;
  symbol?: string;
  amount: number;
}

interface Margins {
  omf: number;   // order margin fraction
  mf: number;    // margin fraction
  imf: number;   // initial margin fraction
  cmf: number;   // cancel margin fraction
  mmf: number;   // maintenance margin fraction
  pon: number;   // position + orders notional
  pn: number;    // position notional
  bankruptcy: boolean;
}

interface Trigger {
  marketId: number;
  triggerPrice?: number;
  price?: number;
  kind: string;
}

interface AccountData {
  exists: boolean;
  accountId?: number;
  positions?: Position[];
  balances?: Balance[];
  margins?: Margins;
  openOrders?: OpenOrder[];
  triggers?: Trigger[];
  marketSymbols?: Record<string, string>;
  message?: string;
}

// ─── Formatters ─────────────────────────────────────────────────

function formatUsd(n: number | null | undefined, decimals = 2): string {
  if (n == null || !isFinite(n)) return "$0.00";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return sign + "$" + (abs / 1_000_000).toFixed(2) + "M";
  if (abs >= 10_000) return sign + "$" + (abs / 1_000).toFixed(1) + "K";
  return sign + "$" + abs.toFixed(decimals);
}

/** Format price with appropriate precision, strip trailing zeros */
function formatPrice(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "$0.00";
  const decimals = Math.abs(n) < 1 ? 6 : Math.abs(n) < 100 ? 3 : 2;
  return "$" + n.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

function formatSize(n: number | null | undefined, decimals = 2): string {
  if (n == null || !isFinite(n)) return "0";
  return n.toFixed(decimals);
}

/** Format elapsed time from milliseconds into human-readable string */
function fmtElapsed(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Self-ticking elapsed time display — re-renders only itself, not the parent */
function ElapsedTime({ since }: { since: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="text-[10px] text-muted">{fmtElapsed(Date.now() - since)}</span>;
}

// ─── Page ───────────────────────────────────────────────────────

export default function PortfolioPage() {
  const { address } = useWallet();
  const { isAuthenticated, signIn, isSigningIn } = useAuth();
  const [data, setData] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collateralModalOpen, setCollateralModalOpen] = useState(false);
  const [closeModalPos, setCloseModalPos] = useState<{
    symbol: string; displaySymbol: string; side: "Long" | "Short"; isLong: boolean;
    absSize: number; entryPrice: number; markPrice: number; totalPnl: number; positionValue: number;
  } | null>(null);

  const refreshingRef = useRef(false);

  // Real-time prices via WebSocket — subscribe to positions AND open orders
  // N1 WS limit: max ~10 streams per connection, so chunk into groups
  const allWsSymbols = useMemo(() => {
    const syms = new Set<string>();
    if (data?.positions) {
      for (const p of data.positions) {
        if (p.perp && p.perp.baseSize !== 0) syms.add(p.symbol.replace("/", ""));
      }
    }
    if (data?.openOrders) {
      for (const o of data.openOrders) syms.add(o.symbol.replace("/", ""));
    }
    return [...syms];
  }, [data?.positions, data?.openOrders]);
  // Pause WS when tab is hidden (portfolio = visibility only, no idle timeout)
  const pageVisible = usePageActive(0);
  const activeSymbols = pageVisible ? allWsSymbols : [];
  const wsChunk1 = useMemo(() => activeSymbols.slice(0, 10), [activeSymbols]);
  const wsChunk2 = useMemo(() => activeSymbols.slice(10, 20), [activeSymbols]);
  const wsChunk3 = useMemo(() => activeSymbols.slice(20), [activeSymbols]);
  const prices1 = useRealtimePrices(wsChunk1);
  const prices2 = useRealtimePrices(wsChunk2);
  const prices3 = useRealtimePrices(wsChunk3);
  const realtimePrices = useMemo(() => ({ ...prices1, ...prices2, ...prices3 }), [prices1, prices2, prices3]);

  // Order actions: cancel, edit, cancel all
  const { cancelOrder: doCancelOrder, cancelAllOrders, editOrder: doEditOrder, closePosition: doClosePosition, cancellingIds, closingSymbols, cancelAllProgress, lastError: orderActionError, clearError: clearOrderError } = useOrderActions();
  const [editingOrderId, setEditingOrderId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<PortfolioTab>("positions");

  // ─── History state ──────────────────────────────────────────
  const [hLoading, setHLoading] = useState(false);
  const [hSyncing, setHSyncing] = useState(false);
  const [hSyncStatus, setHSyncStatus] = useState<SyncStatus | null>(null);
  const [hSyncResults, setHSyncResults] = useState<SyncResultItem[] | null>(null);
  const [hOffset, setHOffset] = useState(0);
  const hInitialSyncDone = useRef(false);
  const [hOrders, setHOrders] = useState<PagedResult<OrderRow> | null>(null);
  const [hTrades, setHTrades] = useState<PagedResult<TradeRow> | null>(null);
  const [hFunding, setHFunding] = useState<PagedResult<FundingRow> | null>(null);
  const [hTransfers, setHTransfers] = useState<TransferResult | null>(null);
  const [editPrice, setEditPrice] = useState("");
  const [editSize, setEditSize] = useState("");

  // Reset history pagination when switching tabs
  useEffect(() => { setHOffset(0); }, [activeTab]);

  // ─── History sync & fetch ───────────────────────────────────
  const isHistoryTab = activeTab === "trades" || activeTab === "orderHistory" || activeTab === "funding" || activeTab === "transfers";

  const checkHSyncStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/history/sync");
      if (res.ok) { const s: SyncStatus = await res.json(); setHSyncStatus(s); return s; }
    } catch { /* silent */ }
    return null;
  }, []);

  const triggerHSync = useCallback(async () => {
    setHSyncing(true); setHSyncResults(null);
    try {
      const res = await fetch("/api/history/sync", { method: "POST", headers: { "Content-Type": "application/json" } });
      if (res.ok) { const b = await res.json(); setHSyncResults(b.results); await checkHSyncStatus(); }
    } catch (err) { console.error("[history] sync failed:", err); }
    finally { setHSyncing(false); }
  }, [checkHSyncStatus]);

  const fetchHistoryData = useCallback(async () => {
    if (!isHistoryTab) return;
    setHLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(HISTORY_PAGE), offset: String(hOffset) });
      if (activeTab === "orderHistory") { const r = await fetch(`/api/history/orders?${params}`); if (r.ok) setHOrders(await r.json()); }
      else if (activeTab === "trades") { const r = await fetch(`/api/history/trades?${params}`); if (r.ok) setHTrades(await r.json()); }
      else if (activeTab === "funding") { const r = await fetch(`/api/history/funding?${params}`); if (r.ok) setHFunding(await r.json()); }
      else if (activeTab === "transfers") { const r = await fetch(`/api/history/transfers?${params}`); if (r.ok) setHTransfers(await r.json()); }
    } catch (err) { console.error("[history] fetch error:", err); }
    finally { setHLoading(false); }
  }, [isHistoryTab, activeTab, hOffset]);

  // Auto-sync on first history tab open
  useEffect(() => {
    if (!isHistoryTab || hInitialSyncDone.current) return;
    hInitialSyncDone.current = true;
    (async () => {
      const status = await checkHSyncStatus();
      if (status?.synced) { fetchHistoryData(); triggerHSync(); }
      else { await triggerHSync(); }
    })();
  }, [isHistoryTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch when history tab or page changes
  useEffect(() => {
    if (isHistoryTab && (hSyncStatus?.synced || hSyncResults)) fetchHistoryData();
  }, [activeTab, hOffset]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch after sync completes
  useEffect(() => {
    if (hSyncResults) fetchHistoryData();
  }, [hSyncResults]); // eslint-disable-line react-hooks/exhaustive-deps

  // History pagination
  const hTotal = activeTab === "orderHistory" ? (hOrders?.total ?? 0)
    : activeTab === "trades" ? (hTrades?.total ?? 0)
    : activeTab === "funding" ? (hFunding?.total ?? 0)
    : activeTab === "transfers" ? ((hTransfers?.deposits?.total ?? 0) + (hTransfers?.withdrawals?.total ?? 0))
    : 0;
  const hTotalPages = Math.max(1, Math.ceil(hTotal / HISTORY_PAGE));
  const hCurrentPage = Math.floor(hOffset / HISTORY_PAGE) + 1;

  // Silent refresh — no spinner, skips if previous request still in flight
  const refreshAccount = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const res = await fetch("/api/account");
      if (res.status === 401) {
        setError("Session expired. Please sign in again.");
        return;
      }
      if (!res.ok) return;
      setData(await res.json());
      setError(null); // Clear error if refresh succeeds after initial failure
    } catch {
      // Silent fail — keep showing last known data
    } finally {
      refreshingRef.current = false;
    }
  }, []);

  // Initial load — shows spinner, retries up to 3 times on failure
  const fetchAccount = useCallback(async () => {
    refreshingRef.current = true; // prevent overlap with refreshAccount
    setLoading(true);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch("/api/account");
        if (res.status === 401) {
          setError("Please sign in to view your portfolio.");
          setLoading(false);
          refreshingRef.current = false;
          return;
        }
        // Rate limited — wait and retry
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("Retry-After") || 2);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setData(await res.json());
        setError(null);
        setLoading(false);
        refreshingRef.current = false;
        return;
      } catch {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        setError("Failed to load account data");
      }
    }
    setLoading(false);
    refreshingRef.current = false;
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    fetchAccount();

    // REST refresh every 10s — but only when tab is visible (pageVisible from usePageActive)
    const id = setInterval(() => { if (!document.hidden) refreshAccount(); }, 10_000);
    // Visibility handler: refetch immediately when user returns to tab
    const onVis = () => { if (!document.hidden) refreshAccount(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      refreshingRef.current = false; // reset on unmount so remount doesn't think fetch is in-flight
    };
  }, [isAuthenticated, fetchAccount, refreshAccount]);

  // Elapsed time is handled by ElapsedTime sub-component (avoids full page re-render every 1s)

  // ─── Order fill tracking (must be before guards — hooks can't be after early returns) ──
  const orderBaselinesRef = useRef<Map<number, number>>(new Map());
  useEffect(() => {
    const orders = data?.openOrders ?? [];
    for (const o of orders) {
      if (!orderBaselinesRef.current.has(o.orderId)) {
        orderBaselinesRef.current.set(o.orderId, o.size);
      }
    }
  }, [data?.openOrders]);

  // ─── Match triggers to positions by marketId (must be before guards — hook) ──
  // Trigger kinds from API: "stopLoss" | "takeProfit" (camelCase)
  const triggersByMarket = useMemo(() => {
    const trigs = data?.triggers ?? [];
    const map = new Map<number, { stopLoss?: number; takeProfit?: number }>();
    for (const t of trigs) {
      const entry = map.get(t.marketId) ?? {};
      const kind = (t.kind ?? "").toLowerCase();
      const price = t.triggerPrice ?? t.price ?? 0;
      if (kind === "stoploss" || kind === "stop_loss") entry.stopLoss = price;
      else if (kind === "takeprofit" || kind === "take_profit") entry.takeProfit = price;
      map.set(t.marketId, entry);
    }
    return map;
  }, [data?.triggers]);

  // ─── Guards ────────────────────────────────────────────────

  if (!address) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-foreground">Connect Wallet</h2>
          <p className="mt-2 text-sm text-muted">Connect your Solana wallet to view your portfolio.</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-foreground">Session Expired</h2>
          <p className="mt-2 text-sm text-muted">Sign in to view your portfolio.</p>
          <button
            onClick={signIn}
            disabled={isSigningIn}
            className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-6 py-2.5 text-sm font-medium text-emerald-400 transition-colors hover:bg-emerald-500/25 disabled:opacity-50"
          >
            {isSigningIn ? "Signing in…" : "Sign In"}
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center">
          <div className="text-red-400">{error}</div>
          <button
            onClick={() => { setError(null); fetchAccount(); }}
            className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-6 py-2.5 text-sm font-medium text-emerald-400 transition-colors hover:bg-emerald-500/25"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data?.exists) {
    return (
      <>
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="text-center">
            <h2 className="text-xl font-semibold text-foreground">No Account</h2>
            <p className="mt-2 text-sm text-muted">Deposit USDC to create your 01 Exchange trading account.</p>
            <button
              onClick={() => setCollateralModalOpen(true)}
              className="mt-4 rounded-xl bg-green-500 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-green-600"
            >
              Deposit USDC
            </button>
          </div>
        </div>
        <DepositWithdrawModal
          isOpen={collateralModalOpen}
          onClose={() => setCollateralModalOpen(false)}
          onSuccess={() => { invalidateEquityCache(); fetchAccount(); }}
        />
      </>
    );
  }

  // ─── Data extraction ─────────────────────────────────────

  const positions = (data.positions ?? []).filter(p => p.perp && p.perp.baseSize !== 0);
  const balances = data.balances ?? [];
  const margins = data.margins;
  const openOrders = data.openOrders ?? [];
  const triggers = data.triggers ?? [];

  // USDC balance (tokenId 0)
  const usdcBalance = balances.find(b => b.tokenId === 0)?.amount ?? 0;

  // Pre-compute per-position data
  // NOTE: Cannot use useMemo here — this code is after early returns (guards).
  // React hooks must be called in the same order every render.
  // SDK returns baseSize as always positive; isLong determines direction.
  // Use real-time WS trade price if available, fallback to API mark price
  const positionRows = positions.map((p) => {
    const isLong = p.perp?.isLong ?? true;
    const absSize = Math.abs(p.perp?.baseSize ?? 0);
    const entryPrice = p.perp?.price ?? 0;
    const fundingPnl = p.perp?.fundingPaymentPnl ?? 0;
    const wsKey = p.symbol.replace("/", "");
    const apiMarkPrice = p.markPrice ?? entryPrice;
    const wsPrice = realtimePrices[wsKey];
    const markPrice = wsPrice ?? apiMarkPrice;
    // Hybrid PnL: API sizePricePnl (ground truth from 01) + WS delta for real-time interpolation
    const apiPnl = p.perp?.sizePricePnl ?? 0;
    const wsDelta = wsPrice
      ? (isLong ? 1 : -1) * (wsPrice - apiMarkPrice) * absSize
      : 0;
    const sizePricePnl = apiPnl + wsDelta;
    const totalPnl = sizePricePnl + fundingPnl;
    // Display size: positive for long, negative for short (matches 01 Exchange)
    const displaySize = isLong ? absSize : -absSize;
    const positionValue = absSize * markPrice;
    const entryNotional = absSize * entryPrice;
    const posUsedMargin = entryNotional * p.marketImf;
    const pnlPct = posUsedMargin > 0 ? (totalPnl / posUsedMargin) * 100 : 0;
    return { p, baseSize: displaySize, absSize, entryPrice, fundingPnl, totalPnl, isLong, markPrice, positionValue, posUsedMargin, pnlPct };
  });

  // Total unrealized PnL — derived from positionRows (which already uses live WS prices)
  const totalUnrealizedPnl = positionRows.reduce((sum, d) => sum + d.totalPnl, 0);

  // SDK margin fields (USD-denominated):
  // omf = account equity (~ Total Value on 01 Exchange)
  // imf = SDK initial margin (includes positions + orders)
  // mmf = maintenance margin requirement (matches 01's "Maint. Margin")

  // Total Value = USDC balance + unrealized PnL (matches 01 Exchange frontend).
  // NOT margins.omf — that's discounted by token weight and slightly lower.
  const totalValue = usdcBalance + totalUnrealizedPnl;

  // Used Margin: computed from open POSITIONS only (entry-based, not mark-based).
  // This matches 01 Exchange's per-position "Used Margin" = abs(size) * entryPrice * marketIMF.
  // When there are no positions, usedMargin = 0 and Available ~ Total Value (matches 01).
  const usedMargin = positions.reduce((sum, p) => {
    if (!p.perp || p.perp.baseSize === 0) return sum;
    const absSize = Math.abs(p.perp.baseSize);
    const entryPrice = p.perp.price ?? 0;
    const mktImf = p.marketImf ?? 0.10;
    return sum + absSize * entryPrice * mktImf;
  }, 0);

  // Available Margin = Total Value - Used Margin (matches 01 Exchange)
  const availableMargin = totalValue - usedMargin;

  // Maintenance margin from SDK (matches 01's "Maint. Margin")
  const maintenanceMargin = margins?.mmf ?? 0;

  // Margin Usage = SDK imf / omf * 100 (includes positions + orders, matches 01's bar)
  const sdkImf = margins?.imf ?? 0;
  const marginUsage = totalValue > 0 && sdkImf > 0
    ? (sdkImf / totalValue) * 100
    : 0;

  // ─── Liquidation price (exact 01 Exchange / zo-client formula) ─────
  // Source: github.com/01protocol/zo-client  Margin.ts → liqPrice()
  //
  // Long:  liqPrice = markPrice - (mf - mmf) / (size * (1 - pmmf))
  // Short: liqPrice = markPrice + (mf - mmf) / (size * (1 + pmmf))
  //
  // Where:
  //   mf  = margins.mf  (account value in USD, uncapped)
  //   mmf = margins.mmf  (total maintenance margin in USD)
  //   pmmf = per-market MMF rate = per-market IMF / 2  (for perps)
  //   size = position size in base units (coins)
  //   markPrice = current index/mark price

  const accountMf = margins?.mf ?? totalValue;
  const accountMmf = margins?.mmf ?? 0;
  const marginCushion = accountMf - accountMmf; // USD buffer before liquidation

  const positionRowsWithLiq = positionRows.map((d) => {
    const trig = triggersByMarket.get(d.p.marketId);
    if (d.absSize < MIN_POS_SIZE) return { ...d, liqPrice: 0, stopLoss: trig?.stopLoss ?? 0, takeProfit: trig?.takeProfit ?? 0 };

    // pmmf = per-market maintenance margin fraction = IMF_base / 2
    // zo-client: pmmf = baseImf / 1000 / 2 = api_imf / 2
    // API's per-market mmf already equals api_imf / 2, so use it directly
    const pmmf = d.p.marketMmf ?? 0.025;

    const divisor = d.absSize * (d.isLong ? (1 - pmmf) : (1 + pmmf));
    if (Math.abs(divisor) < 1e-12) return { ...d, liqPrice: 0, stopLoss: trig?.stopLoss ?? 0, takeProfit: trig?.takeProfit ?? 0 };

    const liqPrice = d.isLong
      ? d.markPrice - marginCushion / divisor
      : d.markPrice + marginCushion / divisor;
    return { ...d, liqPrice: isFinite(liqPrice) && liqPrice > 0 ? liqPrice : 0, stopLoss: trig?.stopLoss ?? 0, takeProfit: trig?.takeProfit ?? 0 };
  });

  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">Portfolio</h1>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setCollateralModalOpen(true)}
              className="rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-4 py-2 text-sm font-medium text-emerald-400 transition-colors hover:bg-emerald-500/25"
            >
              Deposit / Withdraw
            </button>
          </div>
        </div>

        <DepositWithdrawModal
          isOpen={collateralModalOpen}
          onClose={() => setCollateralModalOpen(false)}
          onSuccess={() => { invalidateEquityCache(); fetchAccount(); }}
        />

        {closeModalPos && (
          <ClosePositionModal
            isOpen
            position={closeModalPos}
            doClose={doClosePosition}
            onClose={() => setCloseModalPos(null)}
            onSuccess={() => { invalidateEquityCache(); fetchAccount(); }}
          />
        )}

        {/* Account Summary */}
        <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="text-xs text-muted">Total Value</div>
            <div className="mt-1 text-lg font-semibold font-mono text-foreground">{formatUsd(totalValue)}</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="text-xs text-muted">Unrealized PnL</div>
            <div className={`mt-1 text-lg font-semibold font-mono ${totalUnrealizedPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
              {totalUnrealizedPnl >= 0 ? "+" : ""}{formatUsd(totalUnrealizedPnl)}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="text-xs text-muted">Available Margin</div>
            <div className="mt-1 text-lg font-semibold font-mono text-foreground">{formatUsd(availableMargin)}</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="text-xs text-muted">Open Positions</div>
            <div className="mt-1 text-lg font-semibold text-foreground">{positions.length}</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="text-xs text-muted">Margin Usage</div>
            <div className={`mt-1 text-lg font-semibold ${
              margins?.bankruptcy ? "text-red-400" :
              marginUsage > 50 ? "text-orange-400" :
              marginUsage > 0 ? "text-green-400" :
              "text-foreground"
            }`}>
              {margins?.bankruptcy ? "DANGER" : marginUsage > 0 ? marginUsage.toFixed(2) + "%" : "—"}
            </div>
          </div>
        </div>

        {/* Equity Chart */}
        <div className="mb-6">
          <EquityChart liveEquity={totalValue} />
        </div>

        {/* Unified tab bar: Positions | Open Orders | History tabs */}
        <div className="mb-6">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-0.5">
              {([
                { key: "positions" as PortfolioTab, label: "Positions", badge: positions.length > 0 ? positions.length : null, dot: positions.length > 0 },
                { key: "orders" as PortfolioTab, label: "Open Orders", badge: openOrders.length > 0 ? openOrders.length : null },
                { key: "trades" as PortfolioTab, label: "Trade History" },
                { key: "orderHistory" as PortfolioTab, label: "Order History" },
                { key: "funding" as PortfolioTab, label: "Funding History" },
                { key: "transfers" as PortfolioTab, label: "Transfers" },
              ]).map((t) => (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  className={`relative flex items-center gap-1.5 whitespace-nowrap px-3 py-2 text-xs font-semibold transition-colors -mb-px ${
                    activeTab === t.key
                      ? "text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-[2px] after:bg-gradient-to-r after:from-emerald-400 after:to-emerald-400/10 after:animate-[tab-fill_0.3s_ease-out]"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  {t.dot && <span className="h-2 w-2 animate-pulse rounded-full bg-green-400" />}
                  {t.label}
                  {t.badge != null && <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-green-500/20 text-xs text-green-400">{t.badge}</span>}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-2">
              {activeTab === "orders" && openOrders.length > 1 && (
                <button
                  onClick={() => cancelAllOrders(openOrders.map(o => o.orderId))}
                  disabled={!!cancelAllProgress}
                  className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                >
                  {cancelAllProgress ? `Cancelling ${cancelAllProgress.current}/${cancelAllProgress.total}...` : "Cancel All"}
                </button>
              )}
              {isHistoryTab && (
                <button
                  onClick={triggerHSync}
                  disabled={hSyncing}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground transition hover:border-emerald-500/30 disabled:opacity-50"
                >
                  {hSyncing ? (
                    <><span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />Syncing...</>
                  ) : "Sync"}
                </button>
              )}
            </div>
          </div>

          {activeTab === "positions" && (<>

          {positions.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted">
              No open positions. Use the Chat to place trades.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-border bg-card/50 backdrop-blur-sm">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted">
                    <th className="whitespace-nowrap px-3 py-3 text-left">Market</th>
                    <th className="whitespace-nowrap px-3 py-3 text-right">Position</th>
                    <th className="whitespace-nowrap px-3 py-3 text-right">Position Value</th>
                    <th className="whitespace-nowrap px-3 py-3 text-right">Entry Price</th>
                    <th className="whitespace-nowrap px-3 py-3 text-right">Mark Price</th>
                    <th className="whitespace-nowrap px-3 py-3 text-right">Unrealized PnL</th>
                    <th className="whitespace-nowrap px-3 py-3 text-right">Liq. Price</th>
                    <th className="whitespace-nowrap px-3 py-3 text-right">TP / SL</th>
                    <th className="whitespace-nowrap px-3 py-3 text-right">Funding</th>
                    <th className="whitespace-nowrap px-3 py-3 text-right">Used Margin</th>
                    <th className="whitespace-nowrap px-3 py-3 text-right"></th>
                  </tr>
                </thead>
                <tbody>
                  {positionRowsWithLiq.map((d) => (
                    <tr key={d.p.marketId} className="border-b border-border last:border-b-0">
                      <td className="whitespace-nowrap px-3 py-3">
                        <div className="flex items-center gap-2">
                          <span className={`font-medium ${d.isLong ? "text-green-400" : "text-red-400"}`}>
                            {d.p.symbol.replace(/USD$/, "/USD")}
                          </span>
                          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-muted">
                            {d.p.maxLeverage}x
                          </span>
                        </div>
                      </td>
                      <td className={`whitespace-nowrap px-3 py-3 text-right font-mono ${d.isLong ? "text-green-400" : "text-red-400"}`}>
                        {formatSize(d.baseSize, 2)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-foreground">
                        {formatUsd(d.positionValue)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-foreground">
                        {formatPrice(d.entryPrice)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-foreground">
                        {formatPrice(d.markPrice)}
                      </td>
                      <td className={`whitespace-nowrap px-3 py-3 text-right font-mono ${d.totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                        <div>{d.totalPnl >= 0 ? "+" : ""}{formatUsd(d.totalPnl)}</div>
                        <div className="text-[10px] opacity-70">({d.pnlPct >= 0 ? "+" : ""}{d.pnlPct.toFixed(2)}%)</div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-foreground">
                        {d.liqPrice > 0 ? formatPrice(d.liqPrice) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-right font-mono">
                        {d.takeProfit > 0 || d.stopLoss > 0 ? (
                          <div className="flex flex-col items-end gap-0.5">
                            {d.takeProfit > 0 && <span className="text-green-400">{formatPrice(d.takeProfit)}</span>}
                            {d.stopLoss > 0 && <span className="text-red-400">{formatPrice(d.stopLoss)}</span>}
                          </div>
                        ) : (
                          <span className="text-muted/40">—</span>
                        )}
                      </td>
                      <td className={`whitespace-nowrap px-3 py-3 text-right font-mono ${d.fundingPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {formatUsd(d.fundingPnl)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-foreground">
                        {formatUsd(d.posUsedMargin)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-right">
                        <button
                          onClick={() => setCloseModalPos({
                            symbol: d.p.symbol.replace("/", ""),
                            displaySymbol: d.p.symbol,
                            side: d.isLong ? "Long" : "Short",
                            isLong: d.isLong,
                            absSize: d.absSize,
                            entryPrice: d.entryPrice,
                            markPrice: d.markPrice,
                            totalPnl: d.totalPnl,
                            positionValue: d.positionValue,
                          })}
                          className="rounded-md px-2 py-1 text-[10px] font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                          Close
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </>)}

          {activeTab === "orders" && (<>
          {openOrders.length === 0 ? (
            <div className="rounded-2xl border border-border bg-card/50 backdrop-blur-sm p-6 text-center text-sm text-muted">
              No open orders.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-border bg-card/50 backdrop-blur-sm">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-xs text-muted">
                    <th className="whitespace-nowrap px-3 py-2 text-left font-medium">Market</th>
                    <th className="whitespace-nowrap px-3 py-2 text-left font-medium">Side</th>
                    <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Order Value</th>
                    <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Size</th>
                    <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Limit Price</th>
                    <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Market Price</th>
                    <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Distance</th>
                    <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Filled</th>
                    <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {openOrders.map((o) => {
                    const isBuy = o.side === "bid";
                    const sym = o.symbol.replace("/", "");
                    const baseAsset = sym.replace(/USD$/, "");
                    const livePrice = realtimePrices[sym] ?? null;
                    const distance = livePrice && o.price > 0 ? ((livePrice - o.price) / o.price) * 100 : null;
                    const isClosePrice = distance !== null && Math.abs(distance) < 1;
                    const isVeryClosePrice = distance !== null && Math.abs(distance) < 0.3;

                    const baseline = orderBaselinesRef.current.get(o.orderId) ?? o.size;
                    const filledAmount = Math.max(0, baseline - o.size);
                    const fillPct = baseline > 0 ? (filledAmount / baseline) * 100 : 0;

                    return (
                      <React.Fragment key={o.orderId}>
                      <tr className="border-b border-border/50 last:border-0">
                        <td className="whitespace-nowrap px-3 py-3 font-semibold text-foreground">{baseAsset}/USD</td>
                        <td className="whitespace-nowrap px-3 py-3">
                          <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${isBuy ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
                            {isBuy ? "Buy" : "Sell"}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-foreground">{formatUsd(o.size * o.price)}</td>
                        <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-muted">{formatSize(o.size, 4)}</td>
                        <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-foreground">{formatPrice(o.price)}</td>
                        <td className={`whitespace-nowrap px-3 py-3 text-right font-mono ${isVeryClosePrice ? "text-yellow-400 font-semibold" : "text-foreground"}`}>
                          {livePrice ? formatPrice(livePrice) : "—"}
                        </td>
                        <td className={`whitespace-nowrap px-3 py-3 text-right font-mono ${isVeryClosePrice ? "text-yellow-400 font-semibold" : isClosePrice ? "text-yellow-400" : "text-muted"}`}>
                          {distance !== null ? `${distance >= 0 ? "+" : ""}${distance.toFixed(2)}%` : "—"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-muted">
                          {fillPct > 0 ? (
                            <span className="text-green-400">{fillPct.toFixed(0)}%</span>
                          ) : "0%"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-right">
                          {cancellingIds.has(o.orderId) ? (
                            <svg className="ml-auto h-4 w-4 animate-spin text-muted" viewBox="0 0 24 24" fill="none">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                          ) : (
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => doCancelOrder(o.orderId).then(ok => { if (ok) refreshAccount(); })}
                                className="rounded-md px-2 py-1 text-[10px] font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => {
                                  setEditingOrderId(o.orderId);
                                  setEditPrice(String(o.price));
                                  setEditSize(String(o.size));
                                }}
                                className="rounded-md px-2 py-1 text-[10px] font-medium text-muted hover:bg-white/5 hover:text-foreground transition-colors"
                              >
                                Edit
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                      {editingOrderId === o.orderId && (
                        <tr className="border-b border-border/50 bg-card/30">
                          <td colSpan={9} className="px-3 py-3">
                            <div className="flex items-center gap-3">
                              <div>
                                <label className="text-[10px] text-muted block mb-0.5">Price</label>
                                <input
                                  type="number"
                                  step="any"
                                  value={editPrice}
                                  onChange={e => setEditPrice(e.target.value)}
                                  className="w-28 rounded-md border border-border bg-background px-2 py-1 text-xs font-mono text-foreground outline-none focus:border-accent"
                                />
                              </div>
                              <div>
                                <label className="text-[10px] text-muted block mb-0.5">Size</label>
                                <input
                                  type="number"
                                  step="any"
                                  value={editSize}
                                  onChange={e => setEditSize(e.target.value)}
                                  className="w-28 rounded-md border border-border bg-background px-2 py-1 text-xs font-mono text-foreground outline-none focus:border-accent"
                                />
                              </div>
                              <div className="flex items-end gap-1.5 pb-0.5">
                                <button
                                  onClick={async () => {
                                    const newPrice = parseFloat(editPrice);
                                    const newSize = parseFloat(editSize);
                                    if (!newPrice || !newSize || newPrice <= 0 || newSize <= 0) return;
                                    const ok = await doEditOrder({
                                      oldOrderId: o.orderId,
                                      symbol: sym,
                                      side: isBuy ? "Long" : "Short",
                                      size: newSize,
                                      price: newPrice,
                                      leverage: 1,
                                    });
                                    if (ok) { setEditingOrderId(null); refreshAccount(); }
                                  }}
                                  className="rounded-md bg-accent/20 px-3 py-1 text-[10px] font-medium text-accent hover:bg-accent/30 transition-colors"
                                >
                                  Save
                                </button>
                                <button
                                  onClick={() => setEditingOrderId(null)}
                                  className="rounded-md px-3 py-1 text-[10px] font-medium text-muted hover:bg-white/5 transition-colors"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                            {orderActionError && (
                              <div className="mt-1.5 text-[10px] text-red-400">{orderActionError}</div>
                            )}
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          </>)}

          {/* ─── History tab content ──────────────────────────── */}
          {isHistoryTab && (
            <div className="rounded-2xl border border-border bg-card/50 backdrop-blur-sm">
              {hSyncing && (
                <div className="border-b border-emerald-500/20 bg-emerald-500/5 px-4 py-2">
                  <div className="flex items-center gap-2 text-xs text-emerald-400">
                    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
                    Syncing history from 01 Exchange...
                  </div>
                </div>
              )}
              <div className="max-h-[50vh] overflow-auto">
                {hLoading ? (
                  <div className="flex h-32 items-center justify-center">
                    <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
                  </div>
                ) : (
                  <>
                    {activeTab === "trades" && <HTradeTable data={hTrades?.data ?? []} />}
                    {activeTab === "orderHistory" && <HOrderTable data={hOrders?.data ?? []} />}
                    {activeTab === "funding" && <HFundingTable data={hFunding?.data ?? []} />}
                    {activeTab === "transfers" && <HTransferTable deposits={hTransfers?.deposits?.data ?? []} withdrawals={hTransfers?.withdrawals?.data ?? []} />}
                  </>
                )}
              </div>
              {hTotal > HISTORY_PAGE && (
                <div className="flex items-center justify-center gap-2 border-t border-border px-4 py-3">
                  <button onClick={() => setHOffset(0)} disabled={hOffset === 0} className="rounded px-2 py-1 text-xs text-muted hover:text-foreground disabled:opacity-30">&laquo;</button>
                  <button onClick={() => setHOffset(Math.max(0, hOffset - HISTORY_PAGE))} disabled={hOffset === 0} className="rounded px-2 py-1 text-xs text-muted hover:text-foreground disabled:opacity-30">&lsaquo;</button>
                  {Array.from({ length: Math.min(5, hTotalPages) }, (_, i) => {
                    const page = hTotalPages <= 5 ? i + 1 : hCurrentPage <= 3 ? i + 1 : hCurrentPage >= hTotalPages - 2 ? hTotalPages - 4 + i : hCurrentPage - 2 + i;
                    return (
                      <button key={page} onClick={() => setHOffset((page - 1) * HISTORY_PAGE)}
                        className={`min-w-[28px] rounded px-2 py-1 text-xs transition ${page === hCurrentPage ? "bg-accent/20 text-accent font-medium" : "text-muted hover:text-foreground"}`}
                      >{page}</button>
                    );
                  })}
                  <button onClick={() => setHOffset(hOffset + HISTORY_PAGE)} disabled={hCurrentPage >= hTotalPages} className="rounded px-2 py-1 text-xs text-muted hover:text-foreground disabled:opacity-30">&rsaquo;</button>
                  <button onClick={() => setHOffset((hTotalPages - 1) * HISTORY_PAGE)} disabled={hCurrentPage >= hTotalPages} className="rounded px-2 py-1 text-xs text-muted hover:text-foreground disabled:opacity-30">&raquo;</button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Active Triggers */}
        {/* Orphan triggers — triggers without a matching open position */}
        {triggers.filter(t => !positions.some(p => p.marketId === t.marketId)).length > 0 && (
          <div>
            <h2 className="mb-3 text-lg font-semibold text-foreground">Pending Triggers</h2>
            <div className="overflow-hidden rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-card text-xs text-muted">
                    <th className="px-4 py-3 text-left">Market</th>
                    <th className="px-4 py-3 text-left">Type</th>
                    <th className="px-4 py-3 text-right">Trigger Price</th>
                  </tr>
                </thead>
                <tbody>
                  {triggers.filter(t => !positions.some(p => p.marketId === t.marketId)).map((t, i) => {
                    const kind = (t.kind ?? "").toLowerCase();
                    const isSL = kind === "stoploss" || kind === "stop_loss";
                    return (
                      <tr key={i} className="border-b border-border">
                        <td className="px-4 py-3 text-foreground">
                          {data.marketSymbols?.[String(t.marketId)] ?? `Market-${t.marketId}`}
                        </td>
                        <td className={`px-4 py-3 ${isSL ? "text-red-400" : "text-green-400"}`}>
                          {isSL ? "Stop-Loss" : "Take-Profit"}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-foreground">
                          {formatPrice(t.triggerPrice ?? t.price)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Empty state — no positions, orders, or triggers */}
        {positions.length === 0 && openOrders.length === 0 && (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <h3 className="text-lg font-semibold text-foreground">No Activity Yet</h3>
            <p className="mt-2 text-sm text-muted">
              You have no open positions, pending orders, or active triggers. Head to the Chat to start trading.
            </p>
          </div>
        )}

      </div>
    </div>
  );
}

// ─── History Table Components ─────────────────────────────────────

function HEmpty() {
  return <div className="flex h-24 items-center justify-center text-sm text-muted">No records found</div>;
}

function HTradeTable({ data }: { data: TradeRow[] }) {
  if (!data.length) return <HEmpty />;
  return (
    <table className="w-full">
      <thead className="sticky top-0 border-b border-border bg-card/80 backdrop-blur-sm">
        <tr><th className={HTH}>Time</th><th className={HTH}>Market</th><th className={HTH}>Trade</th><th className={HTH}>Price</th><th className={HTH}>Trade Value</th><th className={HTH}>Fee Paid</th><th className={HTH}>Closed PnL</th><th className={HTH}>Type</th></tr>
      </thead>
      <tbody className="divide-y divide-border/50">
        {data.map((r) => { const tv = hTradeValue(r.price, r.size); const sz = parseFloat(r.size); const fee = hEstFee(tv, r.role, r.fee); return (
          <tr key={r.id} className="transition hover:bg-white/[0.02]">
            <HDateCell iso={r.time} className={`${HTD} text-muted`} />
            <td className={`${HTD} text-foreground`}>{r.symbol.replace("USD", "/USD")}</td>
            <td className={`${HTD} ${r.side === "Long" ? "text-emerald-400" : "text-red-400"}`}>{r.side === "Short" ? "-" : ""}{hFmtSize(Math.abs(sz))}</td>
            <td className={`${HTD} text-foreground`}>{hFmtPrice(r.price)}</td>
            <td className={`${HTD} text-foreground`}>{tv > 0 ? "$" + tv.toFixed(2) : "--"}</td>
            <td className={`${HTD} text-red-400`}>{fee > 0 ? hFmtUsd(-fee) : "--"}</td>
            <td className={`${HTD} ${r.closedPnl ? hPnlColor(r.closedPnl) : "text-muted"}`}>{r.closedPnl && parseFloat(r.closedPnl) !== 0 ? hFmtUsd(r.closedPnl) : "--"}</td>
            <td className={`${HTD} text-muted capitalize`}>{r.role}</td>
          </tr>
        ); })}
      </tbody>
    </table>
  );
}

function HOrderTable({ data }: { data: OrderRow[] }) {
  if (!data.length) return <HEmpty />;
  return (
    <table className="w-full">
      <thead className="sticky top-0 border-b border-border bg-card/80 backdrop-blur-sm">
        <tr><th className={HTH}>Time</th><th className={HTH}>Market</th><th className={HTH}>Order</th><th className={HTH}>Price</th><th className={HTH}>Order Value</th><th className={HTH}>Fill Status</th><th className={HTH}>Status</th><th className={HTH}>Order ID</th></tr>
      </thead>
      <tbody className="divide-y divide-border/50">
        {data.map((r) => { const sz = parseFloat(r.placedSize); const val = parseFloat(r.orderValue); return (
          <tr key={r.id} className="transition hover:bg-white/[0.02]">
            <HDateCell iso={r.addedAt} className={`${HTD} text-muted`} />
            <td className={`${HTD} ${r.side === "Long" ? "text-emerald-400" : "text-red-400"} font-medium`}>{r.symbol.replace("USD", "/USD")}</td>
            <td className={`${HTD} text-foreground`}>{hFmtSize(sz)}</td>
            <td className={`${HTD} text-foreground`}>{hFmtPrice(r.placedPrice)}</td>
            <td className={`${HTD} text-foreground`}>{val > 0 ? "$" + val.toFixed(2) : "--"}</td>
            <td className={`${HTD} ${r.fillStatus === "Filled" ? "text-emerald-400" : "text-muted"}`}>{r.fillStatus}</td>
            <td className={`${HTD} ${r.status === "Filled" ? "text-emerald-400" : r.status === "Cancelled" ? "text-muted" : "text-foreground"}`}>{r.status}</td>
            <td className={`${HTD} text-muted font-mono text-xs`}>{r.orderId}</td>
          </tr>
        ); })}
      </tbody>
    </table>
  );
}

function HFundingTable({ data }: { data: FundingRow[] }) {
  if (!data.length) return <HEmpty />;
  return (
    <table className="w-full">
      <thead className="sticky top-0 border-b border-border bg-card/80 backdrop-blur-sm">
        <tr><th className={HTH}>Time</th><th className={HTH}>Market</th><th className={HTH}>Position Size</th><th className={HTH}>Funding Payment</th></tr>
      </thead>
      <tbody className="divide-y divide-border/50">
        {data.map((r) => (
          <tr key={r.id} className="transition hover:bg-white/[0.02]">
            <HDateCell iso={r.time} className={`${HTD} text-muted`} />
            <td className={`${HTD} text-foreground`}>{r.symbol.replace("USD", "/USD")}</td>
            <td className={`${HTD} text-foreground`}>{hFmtSize(r.positionSize)}</td>
            <td className={`${HTD} ${hPnlColor(r.fundingPnl)}`}>{parseFloat(r.fundingPnl) !== 0 ? hFmtUsd(r.fundingPnl, 4) : "--"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HTransferTable({ deposits, withdrawals }: { deposits: DepositRow[]; withdrawals: WithdrawalRow[] }) {
  const merged = [
    ...deposits.map((d) => ({ ...d, type: "deposit" as const })),
    ...withdrawals.map((w) => ({ ...w, type: "withdrawal" as const })),
  ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  if (!merged.length) return <HEmpty />;
  return (
    <table className="w-full">
      <thead className="sticky top-0 border-b border-border bg-card/80 backdrop-blur-sm">
        <tr><th className={HTH}>Time</th><th className={HTH}>Type</th><th className={HTH}>Amount</th><th className={HTH}>Balance After</th><th className={HTH}>Fee</th><th className={HTH}>Destination</th></tr>
      </thead>
      <tbody className="divide-y divide-border/50">
        {merged.map((r) => (
          <tr key={r.id} className="transition hover:bg-white/[0.02]">
            <HDateCell iso={r.time} className={`${HTD} text-muted`} />
            <td className={`${HTD} ${r.type === "deposit" ? "text-emerald-400" : "text-red-400"}`}>{r.type === "deposit" ? "Deposit" : "Withdrawal"}</td>
            <td className={`${HTD} text-foreground`}>${parseFloat(r.amount).toFixed(2)}</td>
            <td className={`${HTD} text-muted`}>${parseFloat(r.balance).toFixed(2)}</td>
            <td className={`${HTD} text-muted`}>{r.type === "withdrawal" && parseFloat((r as WithdrawalRow).fee) > 0 ? "$" + parseFloat((r as WithdrawalRow).fee).toFixed(2) : "--"}</td>
            <td className={`${HTD} text-muted font-mono text-xs`}>{r.type === "withdrawal" ? hFmtAddr((r as WithdrawalRow).destPubkey) : "--"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
