"use client";

/**
 * TradingSidebar — the right half of ChartPanel in Trade mode.
 *
 * Mirrors the orderbook's 50/50 split aesthetic: this sidebar itself
 * splits 50/50 between an Account snapshot (top) and a scrollable
 * list of currently-open positions (bottom).
 *
 * Two blocks, both driven from data the chat already loads:
 *
 *   1. Account Snapshot — equity, free vs used margin, margin
 *      health bar. REST /api/account every 15 s + WS-event-driven
 *      debounced refetch.
 *
 *   2. Open Positions (scrollable) — every open position across
 *      all markets, not just the currently-charted one. Each row
 *      shows side, size, entry, mark, unrealised PnL, distance to
 *      liq, and three quick-close buttons (25 / 50 / 100 %).
 *
 * A position-sizing calculator was prototyped here and removed:
 * the chat itself already runs that calculation when the user
 * writes "long eth 100 5x" and produces a richer preview (with
 * approval flow) than a sidebar widget could.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth/context";
import { useNordAccount } from "@/hooks/useNordAccount";
import { useOrderActions } from "@/hooks/useOrderActions";

// ─── Props ────────────────────────────────────────────────────────

interface TradingSidebarProps {
  /** Asset for short labels, e.g. "ETH". */
  baseAsset: string;
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

// `baseAsset` is currently unused at the top level (positions list
// shows symbols natively), but kept on the props so the component's
// signature stays stable if we later add a "this market only" filter.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function TradingSidebar({ baseAsset: _baseAsset }: TradingSidebarProps) {
  const { isAuthenticated } = useAuth();
  const [snapshot, setSnapshot] = useState<AccountSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const fetchRef = useRef<(() => Promise<void>) | null>(null);
  const debouncedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // mmf default for the cross-margin liq estimate when a position's
  // own marketMmf isn't on the wire (rare, but defensive).
  const mmf = 0.025;

  const fetchSnap = useCallback(async () => {
    try {
      const res = await fetch("/api/account", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.exists) {
        setSnapshot(EMPTY_SNAPSHOT);
        return;
      }
      // 01 margin fields — see node_modules/@n1xyz/nord-ts AccountMarginsView:
      //   omf — somewhat proportional to USD-weighted value of the
      //         account (equity-equivalent). Used here ONLY for liq
      //         math (mirrors lib/n1/alerts.ts).
      //   imf — initial margin requirement (locked by current
      //         positions/orders).
      //   mmf — maintenance margin requirement.
      //   pon — sum of open position notional. pon = 0 ⇒ no liq risk.
      //
      // Why we DON'T use omf for the displayed Equity number:
      // omf is discounted by token weight and runs ~$0.10–$0.30 lower
      // than the user's real USD net worth on the account. The
      // portfolio page (app/portfolio/page.tsx:656) computes
      //   totalValue = usdcBalance + sum(unrealizedPnl)
      // and calls THAT the user-facing equity — matches what 01.xyz
      // shows as "Total Value". We mirror the same formula here so
      // the chat sidebar and portfolio agree to the cent.
      //
      // Health formula `(omf - mmf) / omf * 100` is the algebraic
      // equivalent of `1 - (mmf/pon)/(omf/pon)` — % of headroom above
      // maintenance threshold. Health uses omf because that's what
      // the matching engine uses for liquidation decisions; equity
      // displayed to the user uses the portfolio-style number.
      const margins = data.margins ?? {};
      const omf = Number(margins.omf ?? margins.mf ?? 0);
      const usedMargin = Number(margins.imf ?? 0);
      const mmfAcct = Number(margins.mmf ?? 0);
      const pon = Number(margins.pon ?? 0);

      const positions: OpenPosition[] = [];
      type PerpPos = {
        symbol?: string;
        marketId?: number;
        marketMmf?: number;
        markPrice?: number;
        perp?: { baseSize?: number; isLong?: boolean; price?: number };
      };
      type Balance = { token?: string; amount?: number };
      for (const p of (data.positions ?? []) as PerpPos[]) {
        if (!p.perp) continue;
        const baseSize = Number(p.perp.baseSize ?? 0);
        if (Math.abs(baseSize) < 1e-12) continue;
        const isLong = p.perp.isLong ?? baseSize > 0;
        const absSize = Math.abs(baseSize);
        const entry = Number(p.perp.price ?? 0);
        const mark = Number(p.markPrice ?? entry);
        // Cross-margin liq estimate: use account-wide cushion (omf - mmf).
        const pmmf = Number(p.marketMmf ?? mmf);
        const cushion = omf - mmfAcct;
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

      // Equity displayed to the user — matches portfolio's "Total Value":
      // USDC token balance + sum(unrealizedPnl). NOT omf, which is
      // discounted by token weight and reads ~$0.10–$0.30 lower than
      // the user's real USD net worth.
      const balances = (data.balances ?? []) as Balance[];
      const usdcBalance = Number(
        balances.find((b) => (b.token ?? "").toUpperCase() === "USDC")?.amount ?? 0,
      );
      const totalUnrealizedPnl = positions.reduce((s, p) => s + p.unrealisedPnl, 0);
      const equity = usdcBalance + totalUnrealizedPnl;

      // Free margin = displayed equity - locked initial margin.
      // Used the displayed equity here too so "Equity − Used = Free"
      // arithmetic shown in the UI is internally consistent.
      const freeMargin = Math.max(0, equity - usedMargin);
      const marginRatio = equity > 0 ? usedMargin / equity : 0;

      // Health uses omf (matching engine's reference for liq), NOT
      // the displayed equity — this is the % headroom above the
      // maintenance threshold as the engine sees it.
      const marginHealth = omf > 0 && pon > 0
        ? Math.max(0, Math.min(100, ((omf - mmfAcct) / omf) * 100))
        : 100;

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
      {/* Top — Account snapshot. shrink-0 so the section is always
          tall enough to fit its content (header + 4 metric rows +
          health bar) without scrolling, but never larger than that.
          The Positions list below claims all remaining space. */}
      <div className="flex flex-col shrink-0">
        <div className="flex items-center justify-between border-b border-[#262626] px-3 py-1 text-[10px] uppercase tracking-wider text-[#555]">
          Account
        </div>
        <AccountSnapshotBlock
          snapshot={snapshot}
          loading={loading}
          isAuthenticated={isAuthenticated}
        />
      </div>

      {/* Bottom — Open positions, fills remaining space, scrolls if many */}
      <div className="flex flex-1 min-h-0 flex-col border-t border-[#262626]">
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
