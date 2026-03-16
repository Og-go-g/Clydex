"use client";

import { useState, useEffect, useMemo, use } from "react";
import Link from "next/link";
import { N1_MARKETS, TIERS } from "@/lib/n1/constants";

// ─── Types ──────────────────────────────────────────────────────

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

  const market = useMemo(
    () => Object.values(N1_MARKETS).find((m) => m.id === marketId) ?? null,
    [marketId]
  );

  const [stats, setStats] = useState<MarketStats | null>(null);
  const [bids, setBids] = useState<OrderbookEntry[]>([]);
  const [asks, setAsks] = useState<OrderbookEntry[]>([]);
  const [trades, setTrades] = useState<RecentTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [countdown, setCountdown] = useState("");

  // Fetch all data
  useEffect(() => {
    if (!market) return;

    async function fetchData() {
      try {
        const [statsRes, obRes] = await Promise.all([
          fetch(`/api/markets/${market!.id}`),
          fetch(`/api/markets/${market!.id}/orderbook`),
        ]);

        if (statsRes.ok) setStats(await statsRes.json());

        if (obRes.ok) {
          const ob = await obRes.json();
          setBids(
            (ob.bids ?? []).slice(0, 15).map(([price, size]: [number, number]) => ({ price, size }))
          );
          setAsks(
            (ob.asks ?? []).slice(0, 15).map(([price, size]: [number, number]) => ({ price, size }))
          );
        }
      } catch {
        // Non-critical — data will show as "—"
      } finally {
        setLoading(false);
      }
    }

    fetchData();
    const interval = setInterval(fetchData, 10_000); // Refresh every 10s
    return () => clearInterval(interval);
  }, [market]);

  // Funding countdown
  useEffect(() => {
    if (!stats?.perpStats?.next_funding_time) return;
    const tick = () => setCountdown(fmtCountdown(stats.perpStats!.next_funding_time));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [stats?.perpStats?.next_funding_time]);

  if (isNaN(marketId) || !market) {
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

  const perp = stats?.perpStats;
  const markPrice = perp?.mark_price ?? stats?.indexPrice ?? null;
  const change24h =
    stats?.close24h && stats?.prevClose24h
      ? ((stats.close24h - stats.prevClose24h) / stats.prevClose24h) * 100
      : null;
  const tier = TIERS[market.tier];

  // Orderbook cumulative totals for bar width calculation
  const bidTotal = bids.reduce((s, b) => s + b.size, 0);
  const askTotal = asks.reduce((s, a) => s + a.size, 0);
  const maxTotal = Math.max(bidTotal, askTotal);

  const spread =
    asks.length > 0 && bids.length > 0 ? asks[0].price - bids[0].price : null;
  const spreadPct =
    spread && bids[0]?.price ? (spread / bids[0].price) * 100 : null;

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
            className="inline-flex h-10 items-center rounded-xl bg-accent px-5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
          >
            Trade {market.baseAsset}
          </Link>
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

        {/* Orderbook + Trades Grid */}
        <div className="grid gap-4 md:grid-cols-2">
          {/* Orderbook */}
          <div className="rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold text-foreground">Order Book</h2>
              {spread != null && (
                <span className="text-xs text-muted">
                  Spread: {spread.toFixed(2)} ({spreadPct?.toFixed(3)}%)
                </span>
              )}
            </div>
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              </div>
            ) : bids.length === 0 && asks.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted">No orderbook data</div>
            ) : (
              <div className="px-1 py-2">
                {/* Header */}
                <div className="flex justify-between px-3 pb-1 text-[10px] text-muted">
                  <span>Price</span>
                  <span>Size</span>
                  <span>Total</span>
                </div>
                {/* Asks (reversed, cheapest at bottom) */}
                <OrderbookSide entries={asks.slice(0, 12)} side="ask" maxTotal={maxTotal} />
                {/* Spread bar */}
                {markPrice != null && (
                  <div className="my-1 flex items-center justify-center gap-2 border-y border-border py-1.5">
                    <span className="text-sm font-bold font-mono text-foreground">
                      {fmt(markPrice, markPrice > 100 ? 2 : 4)}
                    </span>
                  </div>
                )}
                {/* Bids */}
                <OrderbookSide entries={bids.slice(0, 12)} side="bid" maxTotal={maxTotal} />
              </div>
            )}
          </div>

          {/* Recent Trades */}
          <div className="rounded-xl border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold text-foreground">Recent Trades</h2>
            </div>
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              </div>
            ) : trades.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted">
                Trade feed available with WebSocket connection
              </div>
            ) : (
              <div className="max-h-[400px] overflow-y-auto px-1 py-2">
                <div className="flex justify-between px-3 pb-1 text-[10px] text-muted">
                  <span>Price</span>
                  <span>Size</span>
                  <span>Time</span>
                </div>
                {trades.map((t, i) => (
                  <div key={i} className="flex justify-between px-3 py-0.5 text-xs font-mono">
                    <span className={t.side === "buy" ? "text-green-400" : "text-red-400"}>
                      {t.price.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </span>
                    <span className="text-gray-400">{t.size.toFixed(4)}</span>
                    <span className="text-gray-600">{fmtTime(t.timestamp)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

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
