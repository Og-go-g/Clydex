"use client";

/**
 * TradingSidebar — the right half of ChartPanel in Trade mode.
 *
 * Two stacked sections that surface the data a trader actually wants
 * in the moment, without leaving the chat:
 *
 *   1. AccountSnapshot (top) — equity, free vs used margin, margin
 *      health bar, open-position count. Answers "how much can I
 *      trade right now?" at a glance.
 *
 *   2. RecentTrades (bottom) — live tape of the last ~30 fills on
 *      the currently-selected market. Reads as "tape" — direction
 *      and size flow over time, useful for sensing momentum before
 *      placing an order.
 *
 * Data sources:
 *   - Account: REST /api/account every 15 s (light), refresh on
 *     account WS event when available.
 *   - Recent trades: pure WS via useRecentTrades — no extra socket
 *     because ws-manager multiplexes.
 *
 * Designed for a narrow column (50 % of ChartPanel width). Uses the
 * same dark/mono aesthetic as the orderbook for visual consistency.
 */

import { useEffect, useState, useCallback, useRef } from "react";
import { useAuth } from "@/lib/auth/context";
import { useNordAccount } from "@/hooks/useNordAccount";
import { useRecentTrades } from "@/hooks/useRecentTrades";

interface TradingSidebarProps {
  /** Bare market symbol, e.g. "ETHUSD". Drives the recent-trades stream. */
  symbol: string;
  /** Asset for the trades-block label, e.g. "ETH". */
  baseAsset: string;
}

interface AccountSnapshot {
  exists: boolean;
  accountId?: number;
  /** Net liquidation value — equity. */
  equity: number;
  /** Total free margin available for new positions. */
  freeMargin: number;
  /** Margin currently locked in open positions + unfilled orders. */
  usedMargin: number;
  /** Initial margin fraction in use, 0..1+ (>1 means over-leveraged). */
  marginRatio: number;
  /** Distance from liquidation, %. 100 = fresh, 0 = liquidating now. */
  marginHealth: number;
  openPositions: number;
}

const EMPTY_SNAPSHOT: AccountSnapshot = {
  exists: false,
  equity: 0,
  freeMargin: 0,
  usedMargin: 0,
  marginRatio: 0,
  marginHealth: 100,
  openPositions: 0,
};

function fmtUsd(n: number, decimals = 2): string {
  if (!isFinite(n)) return "$0.00";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(decimals)}`;
}

function fmtPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

function fmtSize(size: number): string {
  if (size >= 1000) return size.toFixed(1);
  if (size >= 1) return size.toFixed(3);
  return size.toFixed(4);
}

function fmtTimeShort(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ─── AccountSnapshot block ───────────────────────────────────────

function AccountSnapshotBlock() {
  const { isAuthenticated } = useAuth();
  const [snap, setSnap] = useState<AccountSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const fetchRef = useRef<(() => Promise<void>) | null>(null);
  const debouncedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchSnap = useCallback(async () => {
    try {
      const res = await fetch("/api/account", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.exists) {
        setSnap(EMPTY_SNAPSHOT);
        return;
      }
      // Field layout matches what /api/account returns; defaults guard
      // against either side renaming a key without the other noticing.
      const margins = data.margins ?? {};
      const equity = Number(margins.mf ?? margins.omf ?? 0);
      const usedMargin = Number(margins.imf ?? 0);
      const freeMargin = Math.max(0, equity - usedMargin);
      const mmf = Number(margins.mmf ?? 0);
      // Margin health — mf vs mmf ratio. 100% when no positions held;
      // approaches 0% as mf drops to mmf (liquidation threshold).
      const marginHealth = equity > 0 && mmf > 0
        ? Math.max(0, Math.min(100, ((equity - mmf) / equity) * 100))
        : 100;
      const marginRatio = equity > 0 ? usedMargin / equity : 0;
      const positions = Array.isArray(data.positions) ? data.positions : [];
      const openPositions = positions.filter(
        (p: { perp?: { baseSize?: number } }) => Math.abs(p.perp?.baseSize ?? 0) > 1e-12,
      ).length;
      setSnap({
        exists: true,
        accountId: typeof data.accountId === "number" ? data.accountId : undefined,
        equity,
        freeMargin,
        usedMargin,
        marginRatio,
        marginHealth,
        openPositions,
      });
    } catch {
      // Keep stale snapshot on failure — no UI flicker
    } finally {
      setLoading(false);
    }
  }, []);

  fetchRef.current = fetchSnap;

  // WS-signal-driven refresh: any account event → debounce 250 ms →
  // refetch the aggregate. Pattern matches what ChartPanel uses for
  // the position overlay — one path of truth via REST, WS just
  // schedules refetches.
  const onWsEvent = useCallback(() => {
    if (debouncedTimerRef.current) clearTimeout(debouncedTimerRef.current);
    debouncedTimerRef.current = setTimeout(() => {
      debouncedTimerRef.current = null;
      void fetchRef.current?.();
    }, 250);
  }, []);
  useNordAccount(snap.accountId ?? null, onWsEvent, { enabled: !!snap.accountId });

  useEffect(() => {
    if (!isAuthenticated) {
      setSnap(EMPTY_SNAPSHOT);
      setLoading(false);
      return;
    }
    void fetchSnap();
    // Slow REST poll as a backstop — covers the case where the WS
    // dropped without our health check noticing yet.
    const iv = window.setInterval(() => void fetchSnap(), 15_000);
    return () => {
      clearInterval(iv);
      if (debouncedTimerRef.current) {
        clearTimeout(debouncedTimerRef.current);
        debouncedTimerRef.current = null;
      }
    };
  }, [isAuthenticated, fetchSnap]);

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

  if (!snap.exists) {
    return (
      <div className="flex flex-1 items-center justify-center px-3 text-center text-[10px] text-[#444]">
        No 01 account yet
      </div>
    );
  }

  // Health colour bands — green > 50, amber 20-50, red < 20.
  const healthColor =
    snap.marginHealth >= 50 ? "text-green-400"
    : snap.marginHealth >= 20 ? "text-amber-400"
    : "text-red-400";
  const healthBarColor =
    snap.marginHealth >= 50 ? "bg-green-500/70"
    : snap.marginHealth >= 20 ? "bg-amber-500/70"
    : "bg-red-500/70";

  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-[#555]">Equity</span>
        <span className="font-mono text-sm font-semibold text-foreground">{fmtUsd(snap.equity)}</span>
      </div>

      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-[#555]">Free margin</span>
        <span className="font-mono text-[11px] text-foreground/85">{fmtUsd(snap.freeMargin)}</span>
      </div>

      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-[#555]">Used margin</span>
        <span className="font-mono text-[11px] text-foreground/85">
          {fmtUsd(snap.usedMargin)}
          <span className="ml-1 text-[#666]">({(snap.marginRatio * 100).toFixed(1)}%)</span>
        </span>
      </div>

      <div className="flex flex-col gap-1 pt-1">
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-wider text-[#555]">Health</span>
          <span className={`font-mono text-[11px] ${healthColor}`}>
            {snap.marginHealth.toFixed(0)}%
          </span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-[#1a1a1a]">
          <div className={`h-full transition-all ${healthBarColor}`} style={{ width: `${Math.max(2, snap.marginHealth)}%` }} />
        </div>
      </div>

      <div className="flex items-baseline justify-between border-t border-[#262626] pt-2">
        <span className="text-[10px] uppercase tracking-wider text-[#555]">Open positions</span>
        <span className="font-mono text-[11px] text-foreground">{snap.openPositions}</span>
      </div>
    </div>
  );
}

// ─── RecentTrades block ──────────────────────────────────────────

function RecentTradesBlock({ symbol, baseAsset }: { symbol: string; baseAsset: string }) {
  // Consumer convention: ws-manager multiplexes so this adds zero
  // sockets. The hook keeps oldest-first; we reverse for newest-on-top.
  const trades = useRecentTrades(symbol, { max: 30 });
  const reversed = [...trades].reverse();

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[#262626] px-3 py-1.5 text-[10px] text-[#555]">
        <span className="uppercase tracking-wider">Trades</span>
        <span className="text-[#444]">{baseAsset}/USD</span>
      </div>

      {/* Column labels */}
      <div className="flex items-center justify-between px-3 py-1 text-[10px] text-[#555]">
        <span className="w-[55px] text-left">Time</span>
        <span className="flex-1 text-right">Price</span>
        <span className="w-[60px] text-right">Size</span>
      </div>

      {/* Tape */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {reversed.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[10px] text-[#3a3a3a]">
            Waiting for trades…
          </div>
        ) : (
          reversed.map((t, i) => (
            <div
              // Key is updateId+offset within batch — handles the multi-fill batch case
              key={`${t.updateId}-${i}`}
              className="flex items-center justify-between px-3 py-[2px] text-[10px] font-mono"
            >
              <span className="w-[55px] text-left text-[#666]">{fmtTimeShort(t.receivedAt)}</span>
              <span className={`flex-1 text-right ${t.side === "ask" ? "text-green-400" : "text-red-400"}`}>
                {fmtPrice(t.price)}
              </span>
              <span className="w-[60px] text-right text-[#888]">{fmtSize(t.size)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Top-level export ────────────────────────────────────────────

export function TradingSidebar({ symbol, baseAsset }: TradingSidebarProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Account: ~40 % of available height. flex-basis with shrink-0
          on the divider keeps the heatmap-style proportions without
          the snapshot collapsing to nothing on tiny screens. */}
      <div className="flex flex-col" style={{ flexBasis: "40%", minHeight: 0 }}>
        <div className="flex items-center justify-between border-b border-[#262626] px-3 py-1.5 text-[10px] uppercase tracking-wider text-[#555]">
          Account
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <AccountSnapshotBlock />
        </div>
      </div>

      {/* Trades: remaining ~60 %, with its own border-top from the
          divider above. */}
      <div className="flex flex-col border-t border-[#262626]" style={{ flexBasis: "60%", minHeight: 0 }}>
        <RecentTradesBlock symbol={symbol} baseAsset={baseAsset} />
      </div>
    </div>
  );
}
