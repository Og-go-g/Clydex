"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";

interface MarketRow {
  id: number;
  symbol: string;
  tier: number;
  maxLeverage: number;
  markPrice: number | null;
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
  2: "text-blue-400",
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
    <div className="min-h-screen bg-background p-6">
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
                    ? "bg-accent text-white"
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
                    ? "bg-accent text-white"
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
                  <th className="px-4 py-3 text-right">Price</th>
                  <th className="px-4 py-3 text-right">24h Change</th>
                  <th className="hidden px-4 py-3 text-right md:table-cell">Volume 24h</th>
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
                  <th className="px-4 py-3 text-right">Price</th>
                  <th className="px-4 py-3 text-right">24h Change</th>
                  <th className="hidden px-4 py-3 text-right md:table-cell">Volume 24h</th>
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
                      {formatUsd(m.markPrice)}
                    </td>
                    <td className={`px-4 py-3 text-right font-mono ${
                      (m.change24h ?? 0) >= 0 ? "text-green-400" : "text-red-400"
                    }`}>
                      {formatPct(m.change24h)}
                    </td>
                    <td className="hidden px-4 py-3 text-right font-mono text-muted md:table-cell">
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
