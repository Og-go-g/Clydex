"use client";

import { useState, useEffect } from "react";

interface Pool {
  pool: string;
  project: string;
  symbol: string;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  apyMean30d: number | null;
  poolMeta: string | null;
  tvlUsd: number;
  chain: string;
}

export default function YieldsPage() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"apy" | "tvl">("apy");

  useEffect(() => {
    fetch("/api/yields")
      .then((r) => r.json())
      .then((data) => {
        setPools(data.pools || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const filtered = pools
    .filter(
      (p) =>
        p.tvlUsd >= 100_000 &&
        (p.symbol.toLowerCase().includes(search.toLowerCase()) ||
          p.project.toLowerCase().includes(search.toLowerCase()))
    )
    .sort((a, b) =>
      sortBy === "apy" ? b.apy - a.apy : b.tvlUsd - a.tvlUsd
    );

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Base Yields</h1>
        <p className="mt-2 text-muted">
          Best yield opportunities across DeFi protocols on Base chain.
        </p>
      </div>

      {/* Controls */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <input
          type="text"
          placeholder="Search token or protocol..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none sm:w-72"
        />
        <div className="flex gap-2">
          <button
            onClick={() => setSortBy("apy")}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              sortBy === "apy"
                ? "bg-accent text-white"
                : "bg-card text-muted hover:text-foreground"
            }`}
          >
            Highest APY
          </button>
          <button
            onClick={() => setSortBy("tvl")}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              sortBy === "tvl"
                ? "bg-accent text-white"
                : "bg-card text-muted hover:text-foreground"
            }`}
          >
            Highest TVL
          </button>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="flex gap-1">
            <span className="h-2 w-2 animate-bounce rounded-full bg-accent [animation-delay:0ms]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-accent [animation-delay:150ms]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-accent [animation-delay:300ms]" />
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-12 text-center text-muted">
          {search ? `No pools found for "${search}"` : "No pools available"}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-card text-left text-xs text-muted">
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Pool</th>
                <th className="px-4 py-3">Project</th>
                <th className="px-4 py-3 text-right">TVL</th>
                <th className="px-4 py-3 text-right">APY</th>
                <th className="hidden px-4 py-3 text-right md:table-cell">
                  Base APY
                </th>
                <th className="hidden px-4 py-3 text-right md:table-cell">
                  Reward APY
                </th>
                <th className="hidden px-4 py-3 text-right lg:table-cell">
                  30d Avg APY
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((pool, i) => (
                <tr
                  key={pool.pool}
                  className="border-b border-border/50 transition-colors last:border-0 hover:bg-card"
                >
                  <td className="px-4 py-3 text-xs text-muted">{i + 1}</td>
                  <td className="px-4 py-3">
                    <span className="font-medium">{pool.symbol}</span>
                    {pool.poolMeta && (
                      <span className="ml-2 rounded bg-[#1a1a2e] px-1.5 py-0.5 text-[10px] font-medium text-blue-400">
                        {pool.poolMeta}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-md bg-accent/10 px-2 py-0.5 text-xs font-medium capitalize text-accent">
                      {pool.project}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-muted">
                    ${formatCompact(pool.tvlUsd)}
                  </td>
                  <td className="px-4 py-3 text-right font-bold text-success">
                    {pool.apy.toFixed(2)}%
                  </td>
                  <td className="hidden px-4 py-3 text-right text-muted md:table-cell">
                    {pool.apyBase != null ? pool.apyBase.toFixed(2) + "%" : "—"}
                  </td>
                  <td className="hidden px-4 py-3 text-right text-muted md:table-cell">
                    {pool.apyReward != null
                      ? pool.apyReward.toFixed(2) + "%"
                      : "—"}
                  </td>
                  <td className="hidden px-4 py-3 text-right text-muted lg:table-cell">
                    {pool.apyMean30d != null
                      ? pool.apyMean30d.toFixed(2) + "%"
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 text-right text-xs text-muted">
        {filtered.length} pools shown
      </div>
    </div>
  );
}

function formatCompact(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "b";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "m";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(0);
}
