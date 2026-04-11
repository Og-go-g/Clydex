"use client";

import { useEffect, useState, useRef, useCallback, useMemo, lazy, Suspense } from "react";
import { useChartPanel } from "@/lib/chat/chart-panel-context";
import { useRealtimePrices } from "@/hooks/useRealtimePrices";
import { useOrderbookRatio } from "@/hooks/useOrderbookRatio";
import { useCandleStream } from "@/hooks/useCandleStream";
import { useAuth } from "@/lib/auth/context";
import { INTERVAL_TO_N1, type Interval } from "@/lib/n1/candles";
import type { PriceChartHandle, IndicatorId } from "@/components/charts/PriceChart";
import { CopyTradeSection } from "@/components/copytrade/CopyTradeSection";

const MIN_WIDTH = 320;
const MAX_WIDTH = 1200;
const STORAGE_KEY = "chart-panel-width";

function getDefaultWidth(): number {
  if (typeof window === "undefined") return 400;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const n = Number(saved);
      if (n >= MIN_WIDTH && n <= MAX_WIDTH) return n;
    }
  } catch {}
  // Default: ~30% of available space
  const available = window.innerWidth - 260 - 400;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(available * 0.6)));
}

const PriceChart = lazy(() =>
  import("@/components/charts/PriceChart").then((m) => ({ default: m.PriceChart }))
);

// No hardcoded market IDs — populated dynamically from API

interface MarketInfo {
  marketId: number;
  symbol: string;
  baseAsset: string;
  change24h?: number;
}

export function ChartPanel() {
  const { isOpen, marketId, baseAsset, close, setMarket } = useChartPanel();
  const [allMarkets, setAllMarkets] = useState<MarketInfo[]>([]);
  const [showSelector, setShowSelector] = useState(false);
  const [search, setSearch] = useState("");

  // Dynamic popular markets — top 8 by marketId (same order as 01 Exchange)
  const popularMarkets = useMemo(() => {
    if (allMarkets.length === 0) return [];
    return [...allMarkets]
      .sort((a, b) => a.marketId - b.marketId)
      .slice(0, 8)
      .map((m): { id: number; symbol: string } => ({ id: m.marketId, symbol: m.baseAsset }));
  }, [allMarkets]);

  // ─── Resizable width via drag handle ───────────────────────────
  // During drag: mutate DOM directly (no React re-renders) for smooth 60fps resize.
  // On drag end: commit final width to React state + localStorage.
  const [panelWidth, setPanelWidth] = useState(getDefaultWidth);
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(panelWidth);
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const rafId = useRef(0);
  const latestW = useRef(panelWidth);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    startX.current = e.clientX;
    startWidth.current = latestW.current;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = startX.current - ev.clientX;
      const newW = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta));
      latestW.current = newW;
      // Direct DOM mutation — no React re-render, smooth resize
      cancelAnimationFrame(rafId.current);
      rafId.current = requestAnimationFrame(() => {
        const px = newW + "px";
        if (outerRef.current) outerRef.current.style.width = px;
        if (innerRef.current) innerRef.current.style.width = px;
      });
    };
    const onUp = () => {
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      // Commit final width to React state + persist
      setPanelWidth(latestW.current);
      try { localStorage.setItem(STORAGE_KEY, String(latestW.current)); } catch {}
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // WS prices for the current market
  const sym = `${baseAsset}USD`;
  const realtimePrices = useRealtimePrices(isOpen ? [sym] : []);
  const livePrice = realtimePrices[sym];

  // WS orderbook ratio — real-time, same data source as 01 Exchange
  const wsRatio = useOrderbookRatio(marketId, `${baseAsset}USD`, isOpen);

  // Chart interval state (lifted so WS candle stream matches displayed interval)
  const [chartInterval, setChartInterval] = useState<Interval>("1H");

  // Chart ref for actions (screenshot, fitContent, crosshair toggle)
  const chartHandleRef = useRef<PriceChartHandle>(null);

  // Indicator & volume state
  const [activeIndicators, setActiveIndicators] = useState<Set<IndicatorId>>(new Set());
  const [showVolume, setShowVolume] = useState(true);
  const [showIndicatorMenu, setShowIndicatorMenu] = useState(false);
  const [crosshairOn, setCrosshairOn] = useState(true); // on by default, matching chart init

  const toggleIndicator = useCallback((id: IndicatorId) => {
    setActiveIndicators((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Close indicator menu on any outside click
  useEffect(() => {
    if (!showIndicatorMenu) return;
    function handleClick() { setShowIndicatorMenu(false); }
    // Delay to avoid closing from the same click that opened it
    const id = window.setTimeout(() => document.addEventListener("click", handleClick), 0);
    return () => { clearTimeout(id); document.removeEventListener("click", handleClick); };
  }, [showIndicatorMenu]);

  // WS candle stream — real-time OHLCV updates from N1
  const n1Resolution = INTERVAL_TO_N1[chartInterval];
  const candleUpdate = useCandleStream(sym, n1Resolution, isOpen);

  // ─── Position overlay (entry, liq, TP/SL) matched by marketId ──
  const { isAuthenticated } = useAuth();

  interface PositionOverlay {
    entryPrice: number;
    liqPrice: number;
    isLong: boolean;
    triggerOrders: Array<{ price: number; kind: string }>;
  }

  const overlayCache = useRef<Map<number, PositionOverlay>>(new Map());
  const [positionOverlay, setPositionOverlay] = useState<PositionOverlay | null>(null);

  // Instantly show cached overlay when switching markets
  useEffect(() => {
    setPositionOverlay(overlayCache.current.get(marketId) ?? null);
  }, [marketId]);

  useEffect(() => {
    if (!isOpen || !isAuthenticated) { setPositionOverlay(null); return; }
    let cancelled = false;

    async function fetchOverlay() {
      try {
        const res = await fetch("/api/account");
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!data.exists || cancelled) { setPositionOverlay(null); return; }

        // Find position for the CURRENT marketId
        const pos = (data.positions ?? []).find(
          (p: { marketId: number; perp?: { baseSize: number } }) =>
            p.marketId === marketId && p.perp && p.perp.baseSize !== 0
        );

        if (!pos) {
          overlayCache.current.delete(marketId);
          if (!cancelled) setPositionOverlay(null);
          return;
        }

        const isLong = pos.perp.isLong ?? true;
        const absSize = Math.abs(pos.perp.baseSize);
        const entryPrice = pos.perp.price ?? 0;
        const pmmf = pos.marketMmf ?? 0.025;
        const mf = data.margins?.mf ?? data.margins?.omf ?? 0;
        const mmf = data.margins?.mmf ?? 0;
        const cushion = mf - mmf;
        const divisor = absSize * (isLong ? (1 - pmmf) : (1 + pmmf));
        const markP = pos.markPrice ?? entryPrice;
        const liqPrice = Math.abs(divisor) > 1e-12
          ? (isLong ? markP - cushion / divisor : markP + cushion / divisor)
          : 0;

        // Find trigger orders (TP/SL) for this market
        const triggers = (data.triggers ?? [])
          .filter((t: { marketId: number }) => t.marketId === marketId)
          .map((t: { triggerPrice?: number; price?: number; kind: string }) => ({
            price: t.triggerPrice ?? t.price ?? 0,
            kind: t.kind,
          }));

        const overlay: PositionOverlay = {
          entryPrice,
          liqPrice: liqPrice > 0 && isFinite(liqPrice) ? liqPrice : 0,
          isLong,
          triggerOrders: triggers,
        };
        overlayCache.current.set(marketId, overlay);
        if (!cancelled) setPositionOverlay(overlay);
      } catch { /* silent */ }
    }

    fetchOverlay();
    const iv = window.setInterval(fetchOverlay, 30_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [isOpen, isAuthenticated, marketId]);

  // Fetch all markets for selector
  useEffect(() => {
    if (!isOpen || allMarkets.length > 0) return;
    let cancelled = false;
    fetch("/api/markets")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (!cancelled && d?.markets) {
          setAllMarkets(
            d.markets.map((m: { id: number; marketId?: number; symbol: string; baseAsset: string; change24h?: number }) => ({
              marketId: m.id ?? m.marketId ?? 0,
              symbol: m.symbol,
              baseAsset: m.baseAsset,
              change24h: m.change24h,
            }))
          );
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen, allMarkets.length]);

  const currentMarket = allMarkets.find((m) => m.marketId === marketId);
  const change24h = currentMarket?.change24h ?? null;

  const filteredMarkets = search
    ? allMarkets.filter((m) => m.baseAsset.toLowerCase().includes(search.toLowerCase()))
    : allMarkets;

  // ─── Market stats bar (OI, Volume, Funding, 24h Change) ─────────
  interface MarketStats {
    markPrice: number;
    indexPrice: number;
    change24hPct: number;
    change24hUsd: number;
    openInterest: number;
    volume24h: number;
    fundingRate: number;
    nextFundingTime: string | null;
  }

  // In-memory stats cache — instant display when switching pairs
  const statsCache = useRef<Map<number, MarketStats>>(new Map());
  const [stats, setStats] = useState<MarketStats | null>(() => statsCache.current.get(marketId) ?? null);

  // When market changes, instantly show cached stats (if any)
  useEffect(() => {
    const cached = statsCache.current.get(marketId);
    setStats(cached ?? null);
  }, [marketId]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    async function fetchStats() {
      try {
        const res = await fetch(`/api/markets/${marketId}`);
        if (!res.ok || cancelled) return;
        const d = await res.json();
        if (cancelled) return;

        const mark = d.perpStats?.mark_price ?? d.indexPrice ?? 0;
        const close = d.close24h ?? mark;
        const prev = d.prevClose24h ?? close;
        const pct = prev > 0 ? ((close - prev) / prev) * 100 : 0;
        const usdDiff = close - prev;

        const newStats: MarketStats = {
          markPrice: mark,
          indexPrice: d.indexPrice ?? 0,
          change24hPct: pct,
          change24hUsd: usdDiff,
          openInterest: d.perpStats?.open_interest ?? 0,
          volume24h: d.volumeQuote24h ?? 0,
          fundingRate: d.perpStats?.funding_rate ?? 0,
          nextFundingTime: d.perpStats?.next_funding_time ?? null,
        };
        statsCache.current.set(marketId, newStats);
        if (!cancelled) setStats(newStats);
      } catch { /* silent */ }
    }

    fetchStats();
    const statsIv = window.setInterval(fetchStats, 15_000);
    return () => { cancelled = true; clearInterval(statsIv); };
  }, [isOpen, marketId]);

  // Funding countdown
  const [fundingCountdown, setFundingCountdown] = useState("");
  useEffect(() => {
    if (!stats?.nextFundingTime) return;
    function tick() {
      const diff = new Date(stats!.nextFundingTime!).getTime() - Date.now();
      if (diff <= 0) { setFundingCountdown("now"); return; }
      const m = Math.floor(diff / 60_000);
      const s = Math.floor((diff % 60_000) / 1000);
      setFundingCountdown(`${m}:${s.toString().padStart(2, "0")}`);
    }
    tick();
    const iv = window.setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [stats?.nextFundingTime]);

  function fmtCompact(n: number): string {
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${n.toFixed(2)}`;
  }

  // ─── Desktop panel ──────────────────────────────────────────────
  return (
    <>
      {/* Desktop: slide-in panel — mirrors ChatSidebar structure (border-l, bg-[#111], spacer) */}
      <div
        ref={outerRef}
        className={`hidden md:flex md:flex-col overflow-hidden relative ${
          isOpen ? "" : "w-0"
        }`}
        style={isOpen ? { width: panelWidth, transition: isDragging.current ? "none" : "width 200ms ease" } : { width: 0, transition: "width 200ms ease" }}
      >
        {/* Panel content — flex-1 so it stops before the spacer */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <div ref={innerRef} className="flex h-full flex-col border-l border-[#262626] bg-[#0a0a0a]/[0.08] backdrop-blur-sm" style={{ width: panelWidth }}>
            {/* Drag handle — left edge */}
            <div
              onMouseDown={onDragStart}
              className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 hover:bg-accent/30 active:bg-accent/50 transition-colors"
              title="Drag to resize"
            />

            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-1.5">
              <button
                onClick={() => setShowSelector((v) => !v)}
                className="flex flex-1 items-center gap-2 rounded-lg border border-[#262626] bg-[#1a1a1a] px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-[#222]"
              >
                <span>{baseAsset}/USD</span>
                {livePrice && (
                  <span className="text-xs font-mono text-[#999]">
                    ${livePrice >= 1000 ? livePrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : livePrice.toFixed(livePrice >= 1 ? 3 : 6)}
                  </span>
                )}
                <svg className="h-3 w-3 text-[#999]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              <button
                onClick={close}
                className="shrink-0 rounded-lg border border-[#262626] bg-[#1a1a1a] p-2 text-[#999] transition-colors hover:bg-[#222] hover:text-white"
                aria-label="Close chart"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 17l5-5-5-5" /><path d="M6 17l5-5-5-5" />
                </svg>
              </button>
            </div>

            {/* Market selector dropdown */}
            {showSelector && (
              <div className="border-b border-[#262626] bg-[#0a0a0a]">
                <div className="flex flex-wrap gap-1.5 px-3 pt-2.5 pb-1.5">
                  {popularMarkets.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => { setMarket(m.id, m.symbol); setShowSelector(false); }}
                      className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        m.id === marketId
                          ? "bg-accent/20 text-accent"
                          : "bg-white/5 text-[#999] hover:bg-white/10 hover:text-white"
                      }`}
                    >
                      {m.symbol}
                    </button>
                  ))}
                </div>
                <div className="px-3 pb-2">
                  <input
                    type="text"
                    placeholder="Search market..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full rounded-lg bg-white/5 px-3 py-1.5 text-xs text-white placeholder:text-[#555] outline-none focus:ring-1 focus:ring-accent/30"
                    autoFocus
                  />
                </div>
                {search && (
                  <div className="max-h-[200px] overflow-y-auto px-2 pb-2">
                    {filteredMarkets.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-[#999]">No markets found</div>
                    ) : (
                      filteredMarkets.slice(0, 20).map((m) => (
                        <button
                          key={m.marketId}
                          onClick={() => { setMarket(m.marketId, m.baseAsset); setShowSelector(false); setSearch(""); }}
                          className={`flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-xs transition-colors ${
                            m.marketId === marketId ? "bg-accent/10 text-accent" : "text-white hover:bg-[#161616]"
                          }`}
                        >
                          <span className="font-medium">{m.baseAsset}/USD</span>
                          {m.change24h != null && (
                            <span className={m.change24h >= 0 ? "text-green-400" : "text-red-400"}>
                              {m.change24h >= 0 ? "+" : ""}{m.change24h.toFixed(2)}%
                            </span>
                          )}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Market stats bar — compact single line */}
            {stats && (
              <div className="border-b border-[#262626] px-3 py-1 flex items-center gap-x-3 text-[10px] overflow-x-auto">
                <span className={stats.change24hPct >= 0 ? "text-green-400" : "text-red-400"}>
                  {stats.change24hPct >= 0 ? "+" : ""}{stats.change24hPct.toFixed(2)}%
                  <span className="ml-0.5">/ {stats.change24hUsd >= 0 ? "+" : ""}${Math.abs(stats.change24hUsd) >= 100 ? stats.change24hUsd.toFixed(0) : stats.change24hUsd.toFixed(2)}</span>
                </span>
                <span className="text-[#555]">OI <span className="text-[#bbb] font-mono">{fmtCompact(stats.openInterest * (livePrice ?? stats.markPrice))}</span></span>
                <span className="text-[#555]">Vol <span className="text-[#bbb] font-mono">{fmtCompact(stats.volume24h)}</span></span>
                <span className={stats.fundingRate >= 0 ? "text-green-400" : "text-red-400"}>
                  {(stats.fundingRate * 100).toFixed(4)}%
                  {fundingCountdown && <span className="ml-0.5 text-[#555]">{fundingCountdown}</span>}
                </span>
                <span className="text-green-400 font-mono">{wsRatio.bidPct.toFixed(0)}%</span>
                <div className="flex h-1 w-12 rounded-full overflow-hidden shrink-0">
                  <div className="bg-green-500/70" style={{ width: `${wsRatio.bidPct}%` }} />
                  <div className="bg-red-500/70" style={{ width: `${wsRatio.askPct}%` }} />
                </div>
                <span className="text-red-400 font-mono">{wsRatio.askPct.toFixed(0)}%</span>
              </div>
            )}

            {/* Chart area — capped to leave room for copy trading section */}
            <div className="flex-1 min-h-0 max-h-[65%]">
              <Suspense fallback={<div className="flex h-full items-center justify-center"><div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>}>
                <PriceChart
                  ref={chartHandleRef}
                  marketId={marketId}
                  baseAsset={baseAsset}
                  currentPrice={livePrice}
                  change24h={change24h}
                  candleUpdate={candleUpdate}
                  interval={chartInterval}
                  onIntervalChange={setChartInterval}
                  entryPrice={positionOverlay?.entryPrice}
                  liqPrice={positionOverlay?.liqPrice}
                  isLong={positionOverlay?.isLong}
                  triggerOrders={positionOverlay?.triggerOrders}
                  indicators={activeIndicators}
                  showVolume={showVolume}
                  crosshairOn={crosshairOn}
                  onToggleCrosshair={() => { const on = chartHandleRef.current?.toggleCrosshair(); setCrosshairOn(on ?? true); }}
                  onScreenshot={() => {
                    const dataUrl = chartHandleRef.current?.screenshot();
                    if (!dataUrl) return;
                    const a = document.createElement("a");
                    a.href = dataUrl;
                    a.download = `${baseAsset}-${chartInterval}.png`;
                    a.click();
                  }}
                  onFullscreen={() => {
                    const el = innerRef.current;
                    if (!el) return;
                    if (document.fullscreenElement) document.exitFullscreen();
                    else el.requestFullscreen().catch(() => {});
                  }}
                  showIndicatorMenu={showIndicatorMenu}
                  onToggleIndicatorMenu={() => setShowIndicatorMenu((v) => !v)}
                  onToggleIndicator={toggleIndicator}
                  onToggleVolume={() => setShowVolume((v) => !v)}
                  activeIndicators={activeIndicators}
                />
              </Suspense>
            </div>

            {/* Compact Leaderboard */}
            <CopyTradeSection />
          </div>
        </div>
        {/* Bottom spacer — matches input area height (border-t aligns with chat input border) */}
        <div className="h-[78px] mt-px shrink-0 border-t border-border/40 bg-[#0a0a0a]/[0.08] backdrop-blur-sm" />
      </div>

      {/* Mobile: full-screen overlay */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background md:hidden">
          {/* Mobile header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <button
              onClick={() => setShowSelector((v) => !v)}
              className="flex items-center gap-2 text-sm font-semibold text-foreground"
            >
              {baseAsset}/USD
              <svg className="h-3 w-3 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            <button onClick={close} className="rounded-lg p-2 text-muted hover:text-foreground">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Mobile market selector */}
          {showSelector && (
            <div className="border-b border-border bg-card px-3 py-2">
              <div className="flex flex-wrap gap-2">
                {popularMarkets.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => { setMarket(m.id, m.symbol); setShowSelector(false); }}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                      m.id === marketId ? "bg-accent/20 text-accent" : "bg-white/5 text-muted"
                    }`}
                  >
                    {m.symbol}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Mobile chart */}
          <div className="flex-1 min-h-0">
            <Suspense fallback={<div className="flex h-full items-center justify-center"><div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>}>
              <PriceChart
                marketId={marketId}
                baseAsset={baseAsset}
                currentPrice={livePrice}
                change24h={change24h}
                candleUpdate={candleUpdate}
                interval={chartInterval}
                onIntervalChange={setChartInterval}
                entryPrice={positionOverlay?.entryPrice}
                liqPrice={positionOverlay?.liqPrice}
                isLong={positionOverlay?.isLong}
                triggerOrders={positionOverlay?.triggerOrders}
                indicators={activeIndicators}
                showVolume={showVolume}
              />
            </Suspense>
          </div>
        </div>
      )}
    </>
  );
}
