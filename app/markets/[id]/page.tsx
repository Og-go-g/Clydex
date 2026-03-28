"use client";

import { useState, useEffect, use, lazy, Suspense, useMemo } from "react";
import Link from "next/link";
import { TIERS } from "@/lib/n1/constants";
import { useAuth } from "@/lib/auth/context";
import { useRealtimePrices } from "@/hooks/useRealtimePrices";
import { useCandleStream } from "@/hooks/useCandleStream";
import { INTERVAL_TO_N1, type Interval } from "@/lib/n1/candles";
import { setPendingChartOpen } from "@/lib/chat/chart-panel-context";

const PriceChart = lazy(() =>
  import("@/components/charts/PriceChart").then((m) => ({
    default: m.PriceChart,
  }))
);

// ─── Types ──────────────────────────────────────────────────────

interface MarketInfo {
  id: number;
  symbol: string;
  baseAsset: string;
  tier: number;
  maxLeverage: number;
  initialMarginFraction: number;
}

interface MarketStats {
  perpStats?: {
    mark_price: number;
    funding_rate: number;
    next_funding_time: number;
    open_interest: number;
  };
  indexPrice: number;
  volumeQuote24h: number;
  close24h: number;
  prevClose24h: number;
}

interface OrderbookEntry {
  price: number;
  size: number;
}

interface RecentTrade {
  price: number;
  size: number;
  side: string;
  timestamp: number;
}

// ─── Formatters ─────────────────────────────────────────────────

function fmt(n: number | null | undefined, decimals = 2): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1_000_000_000) return "$" + (n / 1_000_000_000).toFixed(2) + "B";
  if (Math.abs(n) >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (Math.abs(n) >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  if (Math.abs(n) >= 1) return "$" + n.toFixed(decimals);
  return "$" + n.toPrecision(4);
}

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

function fmtFunding(n: number | null): string {
  if (n == null) return "—";
  return (n >= 0 ? "+" : "") + (n * 100).toFixed(4) + "%";
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtCountdown(targetTs: number): string {
  if (!targetTs || !isFinite(targetTs)) return "—";
  // Handle both seconds and milliseconds timestamps
  const targetMs = targetTs > 1e12 ? targetTs : targetTs * 1000;
  const diff = Math.max(0, targetMs - Date.now());
  if (diff === 0) return "Now";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return `${h}h ${m}m ${s}s`;
}

// ─── Orderbook Visualization ────────────────────────────────────

function OrderbookSide({
  entries,
  side,
  maxTotal,
}: {
  entries: OrderbookEntry[];
  side: "bid" | "ask";
  maxTotal: number;
}) {
  let cumulative = 0;
  const rows = entries.map((e) => {
    cumulative += e.size;
    return { ...e, total: cumulative };
  });

  if (side === "ask") rows.reverse();

  return (
    <div className="flex flex-col">
      {rows.map((row, i) => {
        const pct = maxTotal > 0 ? (row.total / maxTotal) * 100 : 0;
        return (
          <div key={i} className="relative flex items-center justify-between px-3 py-0.5 text-xs font-mono">
            <div
              className={`absolute inset-y-0 ${
                side === "bid" ? "left-0 bg-green-500/8" : "right-0 bg-red-500/8"
              }`}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
            <span className={`relative z-10 ${side === "bid" ? "text-green-400" : "text-red-400"}`}>
              {row.price.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </span>
            <span className="relative z-10 text-gray-400">{row.size.toFixed(4)}</span>
            <span className="relative z-10 text-gray-600">{row.total.toFixed(4)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Page Component ─────────────────────────────────────────────

export default function MarketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const marketId = parseInt(id, 10);

  const { isAuthenticated } = useAuth();
  const [market, setMarket] = useState<MarketInfo | null>(null);
  const [marketNotFound, setMarketNotFound] = useState(false);
  const [stats, setStats] = useState<MarketStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [countdown, setCountdown] = useState("");

  // User's position data for this market (liq price, entry, TP/SL)
  interface PositionOverlay {
    entryPrice: number;
    liqPrice: number;
    isLong: boolean;
    triggerOrders: Array<{ price: number; kind: string }>;
  }
  const [positionOverlay, setPositionOverlay] = useState<PositionOverlay | null>(null);

  // Fetch market info from the API (single source of truth for IDs)
  useEffect(() => {
    if (isNaN(marketId)) {
      setMarketNotFound(true);
      setLoading(false);
      return;
    }

    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    async function fetchMarketInfo() {
      try {
        const res = await fetch("/api/markets");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.markets?.length) throw new Error("Empty response");
        const found = data.markets.find((m: MarketInfo) => m.id === marketId);
        if (!cancelled) {
          if (found) {
            setMarket({
              id: found.id,
              symbol: found.symbol,
              baseAsset: found.baseAsset ?? found.symbol.replace(/USD$/, ""),
              tier: found.tier,
              maxLeverage: found.maxLeverage,
              initialMarginFraction: found.initialMarginFraction ?? found.imf ?? 0,
            });
            attempt = 0;
          } else {
            // Market genuinely doesn't exist in the list
            setMarketNotFound(true);
            setLoading(false);
          }
        }
      } catch {
        if (!cancelled) {
          attempt++;
          // Keep retrying with backoff (2s, 4s, 6s, max 10s)
          const delay = Math.min(attempt * 2000, 10_000);
          retryTimer = setTimeout(fetchMarketInfo, delay);
        }
      }
    }

    fetchMarketInfo();
    return () => { cancelled = true; clearTimeout(retryTimer); };
  }, [marketId]);

  // Fetch stats (no orderbook — not needed without trading UI)
  useEffect(() => {
    if (!market) return;

    let cancelled = false;

    async function fetchData() {
      try {
        const statsRes = await fetch(`/api/markets/${market!.id}`);
        if (!cancelled && statsRes.ok) setStats(await statsRes.json());
      } catch { /* keep stale data */ }

      if (!cancelled) setLoading(false);
    }

    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [market?.id]);

  // Fetch user's position for this market (for chart overlays)
  useEffect(() => {
    if (!isAuthenticated || !market) { setPositionOverlay(null); return; }
    let cancelled = false;

    async function fetchPosition() {
      try {
        const res = await fetch("/api/account");
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!data.exists || cancelled) { setPositionOverlay(null); return; }

        // Find position for this market
        const pos = (data.positions ?? []).find(
          (p: { marketId: number; perp?: { baseSize: number } }) =>
            p.marketId === market!.id && p.perp && p.perp.baseSize !== 0
        );
        if (!pos) { setPositionOverlay(null); return; }

        // Compute liq price using same formula as portfolio
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
          .filter((t: { marketId: number }) => t.marketId === market!.id)
          .map((t: { triggerPrice?: number; price?: number; kind: string }) => ({
            price: t.triggerPrice ?? t.price ?? 0,
            kind: t.kind,
          }));

        setPositionOverlay({
          entryPrice,
          liqPrice: liqPrice > 0 && isFinite(liqPrice) ? liqPrice : 0,
          isLong,
          triggerOrders: triggers,
        });
      } catch {
        // silent
      }
    }

    fetchPosition();
    const id = setInterval(fetchPosition, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [isAuthenticated, market]);

  // Real-time price via WS orderbook deltas
  const wsSymbol = useMemo(() => market ? [market.symbol] : [], [market?.symbol]);
  const realtimePrices = useRealtimePrices(wsSymbol);
  const livePrice = market ? realtimePrices[market.symbol] : undefined;

  // Chart interval + real-time candle stream from N1 WS
  const [chartInterval, setChartInterval] = useState<Interval>("1H");
  const n1Resolution = INTERVAL_TO_N1[chartInterval];
  const candleUpdate = useCandleStream(
    market?.symbol ?? "",
    n1Resolution,
    !!market
  );

  // Funding countdown
  useEffect(() => {
    if (!stats?.perpStats?.next_funding_time) return;
    const tick = () => setCountdown(fmtCountdown(stats.perpStats!.next_funding_time));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [stats?.perpStats?.next_funding_time]);

  if (marketNotFound) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-foreground">Market Not Found</h2>
          <p className="mt-2 text-sm text-muted">The market ID &ldquo;{id}&rdquo; does not exist.</p>
          <Link href="/markets" className="mt-4 inline-block text-sm text-accent hover:underline">
            Back to Markets
          </Link>
        </div>
      </div>
    );
  }

  if (!market) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  const perp = stats?.perpStats;
  // Prefer WS live price → REST mark price → index price
  const markPrice = livePrice ?? perp?.mark_price ?? stats?.indexPrice ?? null;
  const change24h =
    stats?.close24h && stats?.prevClose24h
      ? ((stats.close24h - stats.prevClose24h) / stats.prevClose24h) * 100
      : null;
  const tier = TIERS[market.tier];


  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      <div className="mx-auto max-w-6xl">
        {/* Breadcrumb */}
        <div className="mb-4 flex items-center gap-2 text-sm text-muted">
          <Link href="/markets" className="hover:text-foreground transition-colors">
            Markets
          </Link>
          <span>/</span>
          <span className="text-foreground">{market.symbol}</span>
        </div>

        {/* Header */}
        <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold text-foreground">
                {market.baseAsset}
              </h1>
              <span className="rounded-md bg-card px-2 py-0.5 text-xs text-muted">PERP</span>
              <span className={`rounded-md px-2 py-0.5 text-xs ${
                market.tier <= 2 ? "bg-yellow-500/10 text-yellow-400" :
                market.tier <= 3 ? "bg-green-500/10 text-green-400" :
                market.tier <= 4 ? "bg-orange-500/10 text-orange-400" :
                "bg-red-500/10 text-red-400"
              }`}>
                {tier?.label ?? `Tier ${market.tier}`}
              </span>
            </div>
            {loading ? (
              <div className="mt-2 h-10 w-48 animate-pulse rounded-lg bg-card" />
            ) : (
              <div className="mt-2 flex items-baseline gap-3">
                <span className="text-4xl font-bold font-mono text-foreground">
                  {markPrice != null ? fmt(markPrice, markPrice > 100 ? 2 : 4) : "—"}
                </span>
                {change24h != null && (
                  <span className={`text-lg font-semibold ${change24h >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {fmtPct(change24h)}
                  </span>
                )}
              </div>
            )}
          </div>
          <Link
            href="/chat"
            onClick={() => setPendingChartOpen(market.id, market.baseAsset, `long ${market.baseAsset} `)}
            className="inline-flex h-10 items-center rounded-xl border border-accent/30 bg-accent/15 px-5 text-sm font-medium text-accent transition-colors hover:bg-accent/25"
          >
            Trade {market.baseAsset}
          </Link>
        </div>

        {/* Candlestick Chart */}
        <div className="mb-6">
          <Suspense fallback={<div className="h-[340px] rounded-xl border border-[#262626] bg-[#0a0a0a] animate-pulse" />}>
            <PriceChart
              marketId={market.id}
              baseAsset={market.baseAsset}
              currentPrice={markPrice ?? undefined}
              change24h={change24h}
              entryPrice={positionOverlay?.entryPrice}
              liqPrice={positionOverlay?.liqPrice}
              isLong={positionOverlay?.isLong}
              triggerOrders={positionOverlay?.triggerOrders}
              candleUpdate={candleUpdate}
              interval={chartInterval}
              onIntervalChange={setChartInterval}
            />
          </Suspense>
        </div>

        {/* Stats Cards */}
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
          {[
            { label: "Index Price", value: stats?.indexPrice != null ? fmt(stats.indexPrice, 2) : "—" },
            { label: "24h Volume", value: fmt(stats?.volumeQuote24h ?? null) },
            {
              label: "Open Interest",
              value: perp?.open_interest != null ? fmt(perp.open_interest) : "—",
            },
            {
              label: "Funding Rate",
              value: fmtFunding(perp?.funding_rate ?? null),
              color: (perp?.funding_rate ?? 0) >= 0 ? "text-green-400" : "text-red-400",
            },
            { label: "Max Leverage", value: `${market.maxLeverage}x` },
          ].map(({ label, value, color }) => (
            <div key={label} className="rounded-xl border border-border bg-card p-3">
              <div className="text-[11px] text-muted">{label}</div>
              <div className={`mt-0.5 text-sm font-semibold font-mono ${color ?? "text-foreground"}`}>
                {value}
              </div>
            </div>
          ))}
        </div>

        {/* Funding Countdown */}
        {perp?.next_funding_time && (
          <div className="mb-6 rounded-xl border border-border bg-card p-4 flex items-center justify-between">
            <div>
              <span className="text-xs text-muted">Next Funding</span>
              <div className="text-sm font-mono text-foreground">{countdown || "—"}</div>
            </div>
            <div className="text-right">
              <span className="text-xs text-muted">Current Rate</span>
              <div className={`text-sm font-mono font-semibold ${
                (perp.funding_rate ?? 0) >= 0 ? "text-green-400" : "text-red-400"
              }`}>
                {fmtFunding(perp.funding_rate ?? null)}
              </div>
            </div>
            <div className="text-right">
              <span className="text-xs text-muted">Longs pay Shorts</span>
              <div className="text-sm font-mono text-foreground">
                {(perp.funding_rate ?? 0) >= 0 ? "Yes" : "No (Shorts pay)"}
              </div>
            </div>
          </div>
        )}

        {/* Market Info */}

        {/* Market Info */}
        <div className="mt-6 rounded-xl border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold text-foreground">Market Parameters</h2>
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
            {[
              { label: "Symbol", value: market.symbol },
              { label: "Tier", value: tier?.label ?? `Tier ${market.tier}` },
              { label: "Initial Margin", value: (market.initialMarginFraction * 100).toFixed(0) + "%" },
              { label: "Maintenance Margin", value: ((market.initialMarginFraction / 2) * 100).toFixed(1) + "%" },
              { label: "Max Leverage", value: market.maxLeverage + "x" },
              { label: "Market ID", value: String(market.id) },
            ].map(({ label, value }) => (
              <div key={label}>
                <div className="text-muted text-xs">{label}</div>
                <div className="font-mono text-foreground">{value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
