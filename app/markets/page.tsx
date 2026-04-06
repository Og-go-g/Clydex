"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import { useRealtimePrices } from "@/hooks/useRealtimePrices";

interface MarketRow {
  id: number;
  symbol: string;
  tier: number;
  maxLeverage: number;
  markPrice: number | null;
  indexPrice: number | null;
  change24h: number | null;
  volume24h: number | null;
  fundingRate: number | null;
}

function formatUsd(n: number | null): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1_000_000_000) return "$" + (n / 1_000_000_000).toFixed(2) + "B";
  if (Math.abs(n) >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (Math.abs(n) >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  if (Math.abs(n) >= 1) return "$" + n.toFixed(2);
  return "$" + n.toPrecision(4);
}

function formatPrice(n: number | null): string {
  if (n == null || !isFinite(n)) return "—";
  if (n >= 1000) return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (n >= 1) return "$" + n.toFixed(4);
  return "$" + n.toFixed(6);
}

function formatPct(n: number | null): string {
  if (n == null) return "—";
  const sign = n >= 0 ? "+" : "";
  return sign + n.toFixed(2) + "%";
}

function formatFunding(n: number | null): string {
  if (n == null) return "—";
  const sign = n >= 0 ? "+" : "";
  return sign + (n * 100).toFixed(4) + "%";
}

const TIER_COLORS: Record<number, string> = {
  1: "text-yellow-400",
  2: "text-emerald-400",
  3: "text-green-400",
  4: "text-orange-400",
  5: "text-red-400",
};

export default function MarketsPage() {
  const [markets, setMarkets] = useState<MarketRow[]>([]);
  const marketsEmpty = useRef(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<"symbol" | "volume" | "change">("volume");

  // Real-time prices via WS — chunked by 10 (N1 WS limit)
  const allWsSymbols = useMemo(() =>
    markets.map(m => m.symbol.replace("-PERP", "").replace("/", "")),
  [markets]);
  const wsC1 = useMemo(() => allWsSymbols.slice(0, 10), [allWsSymbols]);
  const wsC2 = useMemo(() => allWsSymbols.slice(10, 20), [allWsSymbols]);
  const wsC3 = useMemo(() => allWsSymbols.slice(20), [allWsSymbols]);
  const p1 = useRealtimePrices(wsC1);
  const p2 = useRealtimePrices(wsC2);
  const p3 = useRealtimePrices(wsC3);
  const livePrices = useMemo(() => ({ ...p1, ...p2, ...p3 }), [p1, p2, p3]);

  useEffect(() => {
    let cancelled = false;
    let retries = 0;

    async function fetchMarkets() {
      try {
        const res = await fetch("/api/markets");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setMarkets(data.markets);
          marketsEmpty.current = !data.markets?.length;
          setError(null);
          retries = 0;
        }
      } catch {
        if (!cancelled) {
          retries++;
          // Show error only if we have no data after enough retries
          // marketsRef tracks current state without nesting setState calls
          if (retries >= 3 && marketsEmpty.current) {
            setError("Failed to load markets");
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchMarkets();
    // Poll when tab is visible; also refetch immediately on tab focus
    const interval = setInterval(() => {
      if (!document.hidden) fetchMarkets();
    }, 60_000);
    const onVis = () => { if (!document.hidden && !cancelled) fetchMarkets(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { cancelled = true; clearInterval(interval); document.removeEventListener("visibilitychange", onVis); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = tierFilter ? markets.filter((m) => m.tier === tierFilter) : markets;
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "volume") return (b.volume24h ?? 0) - (a.volume24h ?? 0);
    if (sortBy === "change") return Math.abs(b.change24h ?? 0) - Math.abs(a.change24h ?? 0);
    return a.symbol.localeCompare(b.symbol);
  });

  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-6 text-2xl font-bold text-foreground">Markets</h1>

        {/* Filters */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">Tier:</span>
            {[null, 1, 2, 3, 4, 5].map((tier) => (
              <button
                key={tier ?? "all"}
                onClick={() => setTierFilter(tier)}
                className={`rounded-lg px-3 py-1 text-xs transition-colors ${
                  tierFilter === tier
                    ? "border border-accent/30 bg-accent/15 text-accent"
                    : "bg-card text-muted hover:text-foreground"
                }`}
              >
                {tier === null ? "All" : `Tier ${tier}`}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">Sort:</span>
            {(["volume", "change", "symbol"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSortBy(s)}
                className={`rounded-lg px-3 py-1 text-xs transition-colors ${
                  sortBy === s
                    ? "border border-accent/30 bg-accent/15 text-accent"
                    : "bg-card text-muted hover:text-foreground"
                }`}
              >
                {s === "volume" ? "Volume" : s === "change" ? "Change" : "Name"}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-card text-xs text-muted">
                  <th className="px-4 py-3 text-left">Market</th>
                  <th className="px-4 py-3 text-right">Index Price</th>
                  <th className="hidden px-4 py-3 text-right md:table-cell">Mark Price</th>
                  <th className="px-4 py-3 text-right">24h Change</th>
                  <th className="hidden px-4 py-3 text-right lg:table-cell">Volume 24h</th>
                  <th className="hidden px-4 py-3 text-right md:table-cell">Funding</th>
                  <th className="px-4 py-3 text-right">Max Leverage</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 10 }).map((_, i) => (
                  <tr key={i} className="border-b border-border">
                    <td className="px-4 py-3"><div className="h-4 w-24 animate-pulse rounded bg-card" /></td>
                    <td className="px-4 py-3 text-right"><div className="ml-auto h-4 w-20 animate-pulse rounded bg-card" /></td>
                    <td className="px-4 py-3 text-right"><div className="ml-auto h-4 w-16 animate-pulse rounded bg-card" /></td>
                    <td className="hidden px-4 py-3 text-right md:table-cell"><div className="ml-auto h-4 w-20 animate-pulse rounded bg-card" /></td>
                    <td className="hidden px-4 py-3 text-right md:table-cell"><div className="ml-auto h-4 w-16 animate-pulse rounded bg-card" /></td>
                    <td className="px-4 py-3 text-right"><div className="ml-auto h-4 w-10 animate-pulse rounded bg-card" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : error ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center text-red-400">
            {error}
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-card text-xs text-muted">
                  <th className="px-4 py-3 text-left">Market</th>
                  <th className="px-4 py-3 text-right">Index Price</th>
                  <th className="hidden px-4 py-3 text-right md:table-cell">Mark Price</th>
                  <th className="px-4 py-3 text-right">24h Change</th>
                  <th className="hidden px-4 py-3 text-right lg:table-cell">Volume 24h</th>
                  <th className="hidden px-4 py-3 text-right md:table-cell">Funding</th>
                  <th className="px-4 py-3 text-right">Max Leverage</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((m) => (
                  <tr
                    key={m.id}
                    className="border-b border-border transition-colors hover:bg-card/50"
                  >
                    <td className="px-4 py-3">
                      <Link href={`/markets/${m.id}`} className="flex items-center gap-2 hover:text-accent">
                        <span className="font-medium text-foreground">{m.symbol.replace("-PERP", "")}</span>
                        <span className={`text-[10px] ${TIER_COLORS[m.tier] ?? "text-muted"}`}>T{m.tier}</span>
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-foreground">
                      {formatPrice(m.indexPrice ?? m.markPrice)}
                    </td>
                    <td className="hidden px-4 py-3 text-right font-mono text-muted md:table-cell">
                      {formatPrice(livePrices[m.symbol.replace("-PERP", "").replace("/", "")] ?? m.markPrice)}
                    </td>
                    <td className={`px-4 py-3 text-right font-mono ${
                      (m.change24h ?? 0) >= 0 ? "text-green-400" : "text-red-400"
                    }`}>
                      {formatPct(m.change24h)}
                    </td>
                    <td className="hidden px-4 py-3 text-right font-mono text-muted lg:table-cell">
                      {formatUsd(m.volume24h)}
                    </td>
                    <td className={`hidden px-4 py-3 text-right font-mono md:table-cell ${
                      (m.fundingRate ?? 0) >= 0 ? "text-green-400" : "text-red-400"
                    }`}>
                      {formatFunding(m.fundingRate)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-muted">
                      {m.maxLeverage}x
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
