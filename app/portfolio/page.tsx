"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useWallet } from "@/lib/wallet/context";
import { useAuth } from "@/lib/auth/context";
import { DepositWithdrawModal } from "@/components/collateral/DepositWithdrawModal";
import { ClosePositionModal } from "@/components/collateral/ClosePositionModal";
import { HistoryModal } from "@/components/history/HistoryModal";
import { useRealtimePrices } from "@/hooks/useRealtimePrices";
import { usePageActive } from "@/hooks/usePageActive";
import { useOrderActions } from "@/hooks/useOrderActions";

// Minimum position size threshold — positions below this are treated as dust/zero
const MIN_POS_SIZE = 1e-12;

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
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
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
  const [editPrice, setEditPrice] = useState("");
  const [editSize, setEditSize] = useState("");

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
          onSuccess={fetchAccount}
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

  // Total Value = omf (matches 01 Exchange's "Total Value")
  const totalValue = margins?.omf ?? (usdcBalance + totalUnrealizedPnl);

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
              onClick={() => setHistoryModalOpen(true)}
              className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-emerald-500/30 hover:bg-emerald-500/5"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              History
            </button>
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
          onSuccess={fetchAccount}
        />

        <HistoryModal
          isOpen={historyModalOpen}
          onClose={() => setHistoryModalOpen(false)}
        />

        {closeModalPos && (
          <ClosePositionModal
            isOpen
            position={closeModalPos}
            doClose={doClosePosition}
            onClose={() => setCloseModalPos(null)}
            onSuccess={fetchAccount}
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

        {/* Positions */}
        <div className="mb-6">
          <h2 className="mb-3 text-lg font-semibold text-foreground flex items-center gap-2">
            {positions.length > 0 && <span className="h-2 w-2 animate-pulse rounded-full bg-green-400" />}
            Positions
            {positions.length > 0 && <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-green-500/20 text-xs text-green-400">{positions.length}</span>}
          </h2>
          {positions.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted">
              No open positions. Use the Chat to place trades.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-card text-xs text-muted">
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
        </div>

        {/* Open Orders — table like Positions */}
        {openOrders.length > 0 && (
          <div className="mb-6">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                <span className="h-2 w-2 animate-pulse rounded-full bg-yellow-400" />
                Open Orders
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/20 text-xs text-emerald-400">{openOrders.length}</span>
              </h2>
              {openOrders.length > 1 && (
                <button
                  onClick={() => cancelAllOrders(openOrders.map(o => o.orderId))}
                  disabled={!!cancelAllProgress}
                  className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                >
                  {cancelAllProgress ? `Cancelling ${cancelAllProgress.current}/${cancelAllProgress.total}...` : "Cancel All"}
                </button>
              )}
            </div>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-card text-xs text-muted">
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
          </div>
        )}

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
