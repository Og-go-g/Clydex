"use client";

/**
 * TradingSidebar — the right half of ChartPanel in Trade mode.
 *
 * Mirrors the orderbook's 50/50 split aesthetic: this sidebar itself
 * splits 50/50 between an Account snapshot (top) and a Trade Tools
 * column (bottom). The bottom column further hosts a compact position
 * sizing calculator above a scrollable list of currently-open
 * positions, so the most-needed real-time bookkeeping is always
 * visible without leaving the chat.
 *
 * Three blocks, all driven from data the chat already loads:
 *
 *   1. Account Snapshot — equity, free vs used margin, margin
 *      health bar, open-position count. REST /api/account every
 *      15 s + WS-event-driven debounced refetch.
 *
 *   2. Position Calculator — fully client-side. Inputs: side,
 *      leverage slider, USDC notional. Live outputs: required
 *      margin, est. liquidation price, distance to liq, est. fees.
 *      Uses the current mark price from the parent + the market's
 *      IMF/MMF from the markets cache. Pure isolated-position
 *      approximation for clarity; cross-margin true liq differs
 *      slightly when other positions are open, but the estimate
 *      is honest enough for sizing decisions before opening.
 *
 *   3. Open Positions on this market — list of all open positions
 *      across all markets, scrollable if many. Each row shows
 *      side, size, entry, mark, unrealised PnL, distance to liq
 *      and three quick-close buttons (25 / 50 / 100 %).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth/context";
import { useNordAccount } from "@/hooks/useNordAccount";
import { useNordMarketTicker } from "@/hooks/useNordMarketTicker";
import { useOrderActions } from "@/hooks/useOrderActions";
import { getCachedMarkets } from "@/lib/n1/constants";

// ─── Props ────────────────────────────────────────────────────────

interface TradingSidebarProps {
  /** Bare market symbol, e.g. "ETHUSD" — drives calculator + symbol filter. */
  symbol: string;
  /** Asset for short labels, e.g. "ETH". */
  baseAsset: string;
  /** Numeric market id — used to look up IMF for the calculator. */
  marketId: number;
}

// ─── Shared types ─────────────────────────────────────────────────

interface OpenPosition {
  symbol: string; // "ETH/USD"
  bareSymbol: string; // "ETHUSD"
  marketId: number;
  side: "Long" | "Short";
  isLong: boolean;
  absSize: number;
  entryPrice: number;
  markPrice: number;
  unrealisedPnl: number;
  unrealisedPnlPct: number;
  liqPrice: number;
  liqDistancePct: number;
}

interface AccountSnapshot {
  exists: boolean;
  accountId?: number;
  equity: number;
  freeMargin: number;
  usedMargin: number;
  marginRatio: number;
  marginHealth: number;
  positions: OpenPosition[];
}

const EMPTY_SNAPSHOT: AccountSnapshot = {
  exists: false,
  equity: 0,
  freeMargin: 0,
  usedMargin: 0,
  marginRatio: 0,
  marginHealth: 100,
  positions: [],
};

// ─── Formatters ───────────────────────────────────────────────────

function fmtUsd(n: number, decimals = 2): string {
  if (!isFinite(n)) return "$0.00";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(decimals)}`;
}

function fmtPrice(price: number): string {
  if (!isFinite(price) || price <= 0) return "—";
  if (price >= 1000) return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

function fmtPct(pct: number, decimals = 2): string {
  if (!isFinite(pct)) return "—";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(decimals)}%`;
}

function fmtSize(size: number): string {
  if (size >= 1000) return size.toFixed(1);
  if (size >= 1) return size.toFixed(3);
  return size.toFixed(4);
}

// ─── Liq math (isolated approximation) ────────────────────────────
//
// For a fresh isolated position with notional N, leverage L, IMF, MMF:
//   margin    = N / L
//   maintenance buffer = N * MMF
//   loss to liq = margin - maintenance buffer
//   liq distance frac = lossToLiq / N = 1/L - MMF
//
// So: liqPrice_long  = entry * (1 - (1/L - MMF))
//     liqPrice_short = entry * (1 + (1/L - MMF))
//
// For L > 1/MMF the position is unliquidatable mathematically (over-
// collateralised in maintenance terms) — we cap to "—" then.
function calcLiqPrice(
  entry: number,
  leverage: number,
  isLong: boolean,
  mmf: number,
): number {
  if (!isFinite(entry) || entry <= 0 || !isFinite(leverage) || leverage <= 0) return 0;
  const distFrac = 1 / leverage - mmf;
  if (distFrac <= 0) return 0;
  return isLong ? entry * (1 - distFrac) : entry * (1 + distFrac);
}

// ─── AccountSnapshotBlock ─────────────────────────────────────────

function AccountSnapshotBlock({ snapshot, loading, isAuthenticated }: {
  snapshot: AccountSnapshot;
  loading: boolean;
  isAuthenticated: boolean;
}) {
  if (!isAuthenticated) {
    return (
      <div className="flex flex-1 items-center justify-center px-3 text-center text-[10px] text-[#444]">
        Connect a wallet to see account stats
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-[10px] text-[#3a3a3a]">
        Loading…
      </div>
    );
  }
  if (!snapshot.exists) {
    return (
      <div className="flex flex-1 items-center justify-center px-3 text-center text-[10px] text-[#444]">
        No 01 account yet
      </div>
    );
  }

  const healthColor =
    snapshot.marginHealth >= 50 ? "text-green-400"
    : snapshot.marginHealth >= 20 ? "text-amber-400"
    : "text-red-400";
  const healthBarColor =
    snapshot.marginHealth >= 50 ? "bg-green-500/70"
    : snapshot.marginHealth >= 20 ? "bg-amber-500/70"
    : "bg-red-500/70";

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-[#555]">Equity</span>
        <span className="font-mono text-sm font-semibold text-foreground">{fmtUsd(snapshot.equity)}</span>
      </div>
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-[#555]">Free</span>
        <span className="font-mono text-[11px] text-foreground/85">{fmtUsd(snapshot.freeMargin)}</span>
      </div>
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-[#555]">Used</span>
        <span className="font-mono text-[11px] text-foreground/85">
          {fmtUsd(snapshot.usedMargin)}
          <span className="ml-1 text-[#666]">({(snapshot.marginRatio * 100).toFixed(1)}%)</span>
        </span>
      </div>
      <div className="flex flex-col gap-0.5 pt-1">
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-wider text-[#555]">Health</span>
          <span className={`font-mono text-[11px] ${healthColor}`}>{snapshot.marginHealth.toFixed(0)}%</span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-[#1a1a1a]">
          <div className={`h-full transition-all ${healthBarColor}`} style={{ width: `${Math.max(2, snapshot.marginHealth)}%` }} />
        </div>
      </div>
    </div>
  );
}

// ─── PositionCalculator ───────────────────────────────────────────

const LEV_PRESETS = [1, 2, 5, 10, 20, 50] as const;

function PositionCalculator({
  symbol,
  baseAsset,
  markPrice,
  imf,
  mmf,
  freeMargin,
}: {
  symbol: string;
  baseAsset: string;
  markPrice: number | null;
  imf: number;
  mmf: number;
  freeMargin: number;
}) {
  const [side, setSide] = useState<"Long" | "Short">("Long");
  const [notionalStr, setNotionalStr] = useState<string>("100");
  const [leverage, setLeverage] = useState<number>(5);

  const notional = Math.max(0, Number(notionalStr) || 0);
  const maxLeverage = imf > 0 ? Math.floor(1 / imf) : 1;

  const calc = useMemo(() => {
    if (!markPrice || markPrice <= 0 || notional <= 0) {
      return { margin: 0, baseSize: 0, liqPrice: 0, liqDistance: 0, takerFee: 0, makerFee: 0 };
    }
    const margin = notional / leverage;
    const baseSize = notional / markPrice;
    const liqPrice = calcLiqPrice(markPrice, leverage, side === "Long", mmf);
    const liqDistance = liqPrice > 0 ? Math.abs((liqPrice - markPrice) / markPrice) * 100 : 0;
    // Standard 01 fee tiers — taker 5 bps, maker 2 bps. Surface as
    // pure estimate; actual fee depends on user's tier.
    const takerFee = notional * 0.0005;
    const makerFee = notional * 0.0002;
    return { margin, baseSize, liqPrice, liqDistance, takerFee, makerFee };
  }, [notional, leverage, markPrice, side, mmf]);

  const overMargin = calc.margin > freeMargin && freeMargin > 0;
  const overLeverage = leverage > maxLeverage;

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      {/* Side toggle */}
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => setSide("Long")}
          className={`flex-1 rounded border py-1 text-[10px] font-semibold transition-colors ${
            side === "Long"
              ? "border-green-500/40 bg-green-500/15 text-green-400"
              : "border-[#262626] bg-[#141414] text-[#666] hover:text-foreground"
          }`}
        >
          Long
        </button>
        <button
          type="button"
          onClick={() => setSide("Short")}
          className={`flex-1 rounded border py-1 text-[10px] font-semibold transition-colors ${
            side === "Short"
              ? "border-red-500/40 bg-red-500/15 text-red-400"
              : "border-[#262626] bg-[#141414] text-[#666] hover:text-foreground"
          }`}
        >
          Short
        </button>
      </div>

      {/* Notional input */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-[#555] w-10">Size</span>
        <div className="flex flex-1 items-center rounded border border-[#262626] bg-[#141414] px-2">
          <input
            type="number"
            value={notionalStr}
            onChange={(e) => setNotionalStr(e.target.value)}
            className="flex-1 bg-transparent py-1 text-right font-mono text-[11px] text-foreground outline-none"
            min={0}
            step={10}
          />
          <span className="ml-1 text-[10px] text-[#555]">USDC</span>
        </div>
      </div>

      {/* Leverage row — preset chips + current value */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-[#555] w-10">Lev</span>
        <div className="flex flex-1 gap-0.5">
          {LEV_PRESETS.filter((l) => l <= maxLeverage).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLeverage(l)}
              className={`flex-1 rounded border py-0.5 text-[10px] font-mono transition-colors ${
                leverage === l
                  ? "border-accent/40 bg-accent/15 text-accent"
                  : "border-[#262626] bg-[#141414] text-[#666] hover:text-foreground"
              }`}
            >
              {l}x
            </button>
          ))}
        </div>
      </div>

      {/* Outputs */}
      <div className="flex flex-col gap-0.5 border-t border-[#1a1a1a] pt-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] text-[#555]">{baseAsset} size</span>
          <span className="font-mono text-[11px] text-foreground/85">
            {markPrice ? fmtSize(calc.baseSize) : "—"}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] text-[#555]">Margin</span>
          <span className={`font-mono text-[11px] ${overMargin ? "text-red-400" : "text-foreground/85"}`}>
            {fmtUsd(calc.margin)}
            {overMargin && <span className="ml-1 text-[9px]">over free</span>}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] text-[#555]">Liq price</span>
          <span className={`font-mono text-[11px] ${
            calc.liqPrice === 0 ? "text-[#444]"
            : side === "Long" ? "text-red-400/80" : "text-red-400/80"
          }`}>
            {calc.liqPrice > 0 ? fmtPrice(calc.liqPrice) : "—"}
            {calc.liqDistance > 0 && (
              <span className="ml-1 text-[9px] text-[#666]">
                ({side === "Long" ? "-" : "+"}{calc.liqDistance.toFixed(1)}%)
              </span>
            )}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] text-[#555]">Fees t/m</span>
          <span className="font-mono text-[10px] text-[#888]">
            {fmtUsd(calc.takerFee, 3)} / {fmtUsd(calc.makerFee, 3)}
          </span>
        </div>
        {overLeverage && (
          <div className="text-[9px] text-amber-400/80">
            ⚠ Lev {leverage}x exceeds market max {maxLeverage}x
          </div>
        )}
      </div>

      {/* Symbol footer — context tied to the chart above */}
      <div className="text-right text-[9px] text-[#3a3a3a]">{symbol}</div>
    </div>
  );
}

// ─── OpenPositionsList ────────────────────────────────────────────

function OpenPositionsList({
  positions,
  isAuthenticated,
  loading,
  onAfterClose,
}: {
  positions: OpenPosition[];
  isAuthenticated: boolean;
  loading: boolean;
  onAfterClose: () => void;
}) {
  const { closePosition, closingSymbols } = useOrderActions();

  const doClose = useCallback(
    async (pos: OpenPosition, fraction: number) => {
      const size = pos.absSize * fraction;
      try {
        const ok = await closePosition({ symbol: pos.symbol, side: pos.side, size, slippage: 0.005 });
        if (ok) onAfterClose();
      } catch {
        // useOrderActions surfaces the error in its lastError state;
        // the popup-less sidebar UI doesn't need to re-toast it here.
      }
    },
    [closePosition, onAfterClose],
  );

  if (!isAuthenticated) {
    return (
      <div className="flex flex-1 items-center justify-center px-3 text-center text-[10px] text-[#444]">
        Connect a wallet
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-[10px] text-[#3a3a3a]">
        Loading…
      </div>
    );
  }
  if (positions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-3 text-center text-[10px] text-[#444]">
        No open positions
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {positions.map((pos) => {
        const closingKey = `${pos.symbol}:${pos.side}`;
        const isClosing = closingSymbols.has(closingKey);
        return (
          <div
            key={pos.symbol}
            className="flex flex-col gap-1 border-b border-[#1a1a1a] px-3 py-1.5"
          >
            {/* Top row: symbol + side + size */}
            <div className="flex items-center justify-between text-[10px]">
              <span className="font-mono text-foreground">{pos.symbol.replace("/", "/")}</span>
              <span className={`font-mono ${pos.isLong ? "text-green-400" : "text-red-400"}`}>
                {pos.side === "Long" ? "L" : "S"} {fmtSize(pos.absSize)}
              </span>
            </div>

            {/* PnL + Liq */}
            <div className="flex items-baseline justify-between text-[10px] font-mono">
              <span className={pos.unrealisedPnl >= 0 ? "text-green-400" : "text-red-400"}>
                {pos.unrealisedPnl >= 0 ? "+" : ""}
                {fmtUsd(pos.unrealisedPnl)} ({fmtPct(pos.unrealisedPnlPct)})
              </span>
              <span className="text-[#666]">
                Liq {fmtPrice(pos.liqPrice)}
                {pos.liqDistancePct > 0 && (
                  <span className="ml-0.5 text-[9px] text-[#555]">
                    ({pos.liqDistancePct.toFixed(1)}%)
                  </span>
                )}
              </span>
            </div>

            {/* Entry / mark */}
            <div className="flex items-baseline justify-between text-[9px] text-[#555] font-mono">
              <span>E {fmtPrice(pos.entryPrice)}</span>
              <span>M {fmtPrice(pos.markPrice)}</span>
            </div>

            {/* Quick close buttons */}
            <div className="flex gap-0.5 pt-0.5">
              {[0.25, 0.5, 1].map((frac) => (
                <button
                  key={frac}
                  type="button"
                  onClick={() => doClose(pos, frac)}
                  disabled={isClosing}
                  className="flex-1 rounded border border-[#262626] bg-[#141414] py-0.5 text-[9px] font-mono text-[#888] transition-colors hover:border-accent/40 hover:bg-accent/10 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isClosing ? "…" : `${(frac * 100).toFixed(0)}%`}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Top-level export ─────────────────────────────────────────────

export function TradingSidebar({ symbol, baseAsset, marketId }: TradingSidebarProps) {
  const { isAuthenticated } = useAuth();
  const [snapshot, setSnapshot] = useState<AccountSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const fetchRef = useRef<(() => Promise<void>) | null>(null);
  const debouncedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live mark price for the selected market — feeds the calculator
  // so it stays in sync with the chart.
  const ticker = useNordMarketTicker(symbol);
  const markPrice = ticker.lastPrice ?? null;

  // IMF / MMF for the calculator. From cached markets list. MMF on 01
  // is conventionally IMF/2 — we mirror that. If the market isn't in
  // cache yet (rare on first paint), fall back to conservative defaults
  // that match a Tier-3 market.
  const market = useMemo(() => getCachedMarkets().find((m) => m.id === marketId), [marketId]);
  const imf = market?.initialMarginFraction ?? 0.05;
  const mmf = imf / 2;

  const fetchSnap = useCallback(async () => {
    try {
      const res = await fetch("/api/account", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.exists) {
        setSnapshot(EMPTY_SNAPSHOT);
        return;
      }
      const margins = data.margins ?? {};
      const equity = Number(margins.mf ?? margins.omf ?? 0);
      const usedMargin = Number(margins.imf ?? 0);
      const freeMargin = Math.max(0, equity - usedMargin);
      const mmfAcct = Number(margins.mmf ?? 0);
      const marginHealth = equity > 0 && mmfAcct > 0
        ? Math.max(0, Math.min(100, ((equity - mmfAcct) / equity) * 100))
        : 100;
      const marginRatio = equity > 0 ? usedMargin / equity : 0;

      const positions: OpenPosition[] = [];
      type PerpPos = {
        symbol?: string;
        marketId?: number;
        marketMmf?: number;
        markPrice?: number;
        perp?: { baseSize?: number; isLong?: boolean; price?: number };
      };
      for (const p of (data.positions ?? []) as PerpPos[]) {
        if (!p.perp) continue;
        const baseSize = Number(p.perp.baseSize ?? 0);
        if (Math.abs(baseSize) < 1e-12) continue;
        const isLong = p.perp.isLong ?? baseSize > 0;
        const absSize = Math.abs(baseSize);
        const entry = Number(p.perp.price ?? 0);
        const mark = Number(p.markPrice ?? entry);
        // Cross-margin liq estimate: use account-wide cushion.
        const pmmf = Number(p.marketMmf ?? mmf);
        const cushion = equity - mmfAcct;
        const divisor = absSize * (isLong ? (1 - pmmf) : (1 + pmmf));
        const liqPrice = Math.abs(divisor) > 1e-12
          ? (isLong ? mark - cushion / divisor : mark + cushion / divisor)
          : 0;
        const liqDistancePct = liqPrice > 0 && mark > 0
          ? Math.abs((liqPrice - mark) / mark) * 100
          : 0;
        const unrealisedPnl = (mark - entry) * baseSize; // baseSize is signed for long/short
        const positionValue = entry * absSize;
        const unrealisedPnlPct = positionValue > 0 ? (unrealisedPnl / positionValue) * 100 : 0;
        const sym = p.symbol ?? "";
        positions.push({
          symbol: sym,
          bareSymbol: sym.replace("/", ""),
          marketId: Number(p.marketId ?? 0),
          side: isLong ? "Long" : "Short",
          isLong,
          absSize,
          entryPrice: entry,
          markPrice: mark,
          unrealisedPnl,
          unrealisedPnlPct,
          liqPrice: liqPrice > 0 && isFinite(liqPrice) ? liqPrice : 0,
          liqDistancePct,
        });
      }

      setSnapshot({
        exists: true,
        accountId: typeof data.accountId === "number" ? data.accountId : undefined,
        equity,
        freeMargin,
        usedMargin,
        marginRatio,
        marginHealth,
        positions,
      });
    } catch {
      // Keep stale snapshot on failure
    } finally {
      setLoading(false);
    }
  }, [mmf]);

  fetchRef.current = fetchSnap;

  const onWsEvent = useCallback(() => {
    if (debouncedTimerRef.current) clearTimeout(debouncedTimerRef.current);
    debouncedTimerRef.current = setTimeout(() => {
      debouncedTimerRef.current = null;
      void fetchRef.current?.();
    }, 250);
  }, []);
  useNordAccount(snapshot.accountId ?? null, onWsEvent, { enabled: !!snapshot.accountId });

  useEffect(() => {
    if (!isAuthenticated) {
      setSnapshot(EMPTY_SNAPSHOT);
      setLoading(false);
      return;
    }
    void fetchSnap();
    const iv = window.setInterval(() => void fetchSnap(), 15_000);
    return () => {
      clearInterval(iv);
      if (debouncedTimerRef.current) {
        clearTimeout(debouncedTimerRef.current);
        debouncedTimerRef.current = null;
      }
    };
  }, [isAuthenticated, fetchSnap]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Top half (50%) — Account snapshot */}
      <div className="flex flex-col" style={{ flexBasis: "50%", minHeight: 0 }}>
        <div className="flex items-center justify-between border-b border-[#262626] px-3 py-1 text-[10px] uppercase tracking-wider text-[#555]">
          Account
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <AccountSnapshotBlock
            snapshot={snapshot}
            loading={loading}
            isAuthenticated={isAuthenticated}
          />
        </div>
      </div>

      {/* Bottom half (50%) — Calculator (compact) + Positions (scrollable) */}
      <div className="flex flex-col border-t border-[#262626]" style={{ flexBasis: "50%", minHeight: 0 }}>
        {/* Calculator — fixed height, compact. Doesn't need to grow. */}
        <div className="flex flex-col border-b border-[#262626]">
          <div className="flex items-center justify-between border-b border-[#262626] px-3 py-1 text-[10px] uppercase tracking-wider text-[#555]">
            Calc
          </div>
          <PositionCalculator
            symbol={`${baseAsset}/USD`}
            baseAsset={baseAsset}
            markPrice={markPrice}
            imf={imf}
            mmf={mmf}
            freeMargin={snapshot.freeMargin}
          />
        </div>

        {/* Positions — fills remaining space, scrolls if many */}
        <div className="flex flex-1 min-h-0 flex-col">
          <div className="flex items-center justify-between border-b border-[#262626] px-3 py-1 text-[10px] uppercase tracking-wider text-[#555]">
            <span>Positions</span>
            <span className="text-[#444]">{snapshot.positions.length}</span>
          </div>
          <OpenPositionsList
            positions={snapshot.positions}
            isAuthenticated={isAuthenticated}
            loading={loading}
            onAfterClose={() => void fetchRef.current?.()}
          />
        </div>
      </div>
    </div>
  );
}
