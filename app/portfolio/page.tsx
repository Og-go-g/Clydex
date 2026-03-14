"use client";

import { useState, useEffect } from "react";
import { useWallet } from "@/lib/wallet/context";
import { SUPPORTED_CHAINS, CHAIN_BY_SLUG } from "@/lib/defi/chains";
import type { PortfolioResponse, TokenHolding } from "@/lib/defi/moralis";

type SortKey = "value" | "change" | "name";

export default function PortfolioPage() {
  const { address, connect } = useWallet();
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedChain, setSelectedChain] = useState<string>("all");
  const [sortBy, setSortBy] = useState<SortKey>("value");
  const [showDust, setShowDust] = useState(false);

  useEffect(() => {
    if (!address) {
      setPortfolio(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/portfolio?address=${encodeURIComponent(address)}`, {
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setPortfolio(data);
      })
      .catch((err) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [address]);

  // Filter + sort (hide tokens worth less than $0.01 entirely)
  const tokens = portfolio?.tokens || [];
  const filtered = tokens
    .filter((t) => {
      if ((t.usdValue || 0) < 0.01) return false;
      if (selectedChain !== "all" && t.chain !== selectedChain) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          t.symbol.toLowerCase().includes(q) ||
          t.name.toLowerCase().includes(q)
        );
      }
      return true;
    })
    .sort((a, b) => {
      if (sortBy === "value") return (b.usdValue || 0) - (a.usdValue || 0);
      if (sortBy === "change")
        return (b.priceChange24h || 0) - (a.priceChange24h || 0);
      return a.symbol.localeCompare(b.symbol);
    });

  // Split into main tokens (>= $1) and dust ($0.01–$1)
  const mainTokens = filtered.filter((t) => (t.usdValue || 0) >= 1);
  const dustTokens = filtered.filter((t) => (t.usdValue || 0) < 1);
  const visibleTokens = showDust ? filtered : mainTokens;

  // --- No wallet ---
  if (!address) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-border bg-card py-20 text-center">
          <div className="mb-4 text-5xl">👛</div>
          <h2 className="text-xl font-bold">Connect Your Wallet</h2>
          <p className="mt-2 max-w-sm text-sm text-muted">
            Connect your wallet to view your portfolio across{" "}
            {SUPPORTED_CHAINS.length} chains.
          </p>
          <button
            onClick={connect}
            className="mt-6 rounded-xl bg-accent px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
          >
            Connect Wallet
          </button>
        </div>
      </div>
    );
  }

  // --- Loading ---
  if (loading) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Portfolio</h1>
          <p className="mt-2 text-sm text-muted">
            Loading balances across {SUPPORTED_CHAINS.length} chains...
          </p>
        </div>
        {/* Skeleton summary */}
        <div className="mb-6 animate-pulse rounded-2xl border border-border bg-card p-6">
          <div className="h-4 w-32 rounded bg-border" />
          <div className="mt-3 h-8 w-48 rounded bg-border" />
          <div className="mt-4 flex gap-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-6 w-20 rounded-full bg-border" />
            ))}
          </div>
        </div>
        {/* Skeleton rows */}
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="flex animate-pulse items-center gap-4 rounded-xl border border-border bg-card p-4"
            >
              <div className="h-8 w-8 rounded-full bg-border" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-24 rounded bg-border" />
                <div className="h-3 w-16 rounded bg-border" />
              </div>
              <div className="h-4 w-20 rounded bg-border" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // --- Error ---
  if (error) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Portfolio</h1>
        </div>
        <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-6 text-center text-sm text-red-400">
          {error}
        </div>
      </div>
    );
  }

  const breakdown = portfolio?.chainBreakdown || {};
  const totalChainTokens = selectedChain === "all"
    ? tokens.length
    : (breakdown[selectedChain]?.tokenCount || 0);

  // Weighted 24h change
  const weighted24h =
    portfolio && portfolio.totalUsdValue > 0
      ? tokens.reduce(
          (sum, t) =>
            sum +
            ((t.usdValue || 0) / portfolio.totalUsdValue) *
              (t.priceChange24h || 0),
          0
        )
      : 0;

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Portfolio</h1>
        <p className="mt-1 text-sm text-muted">
          {address.slice(0, 6)}...{address.slice(-4)}
        </p>
      </div>

      {/* Summary card */}
      <div className="mb-6 rounded-2xl border border-border bg-card p-6">
        <div className="text-xs text-muted">Total Portfolio Value</div>
        <div className="mt-1 flex items-baseline gap-3">
          <span className="text-3xl font-bold">
            ${formatUsd(portfolio?.totalUsdValue || 0)}
          </span>
          <span
            className={`text-sm font-medium ${
              weighted24h >= 0 ? "text-success" : "text-error"
            }`}
          >
            {weighted24h >= 0 ? "+" : ""}
            {weighted24h.toFixed(2)}% (24h)
          </span>
        </div>
        {/* Chain breakdown chips */}
        <div className="mt-4 flex flex-wrap gap-2">
          {SUPPORTED_CHAINS.filter(
            (c) => (breakdown[c.slug]?.usdValue || 0) > 0
          ).map((c) => (
            <button
              key={c.slug}
              onClick={() =>
                setSelectedChain(selectedChain === c.slug ? "all" : c.slug)
              }
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                selectedChain === c.slug
                  ? "bg-accent text-white"
                  : "bg-background text-muted hover:text-foreground"
              }`}
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: c.color }}
              />
              {c.name}{" "}
              <span className="opacity-60">
                ${formatCompact(breakdown[c.slug]?.usdValue || 0)}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Partial error warnings */}
      {portfolio && portfolio.errors.length > 0 && (
        <div className="mb-4 rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-xs text-yellow-400">
          Could not load data from {portfolio.errors.join(", ")}. Other chains
          loaded successfully.
        </div>
      )}

      {/* Chain tabs */}
      <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
        <button
          onClick={() => setSelectedChain("all")}
          className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            selectedChain === "all"
              ? "bg-accent text-white"
              : "bg-card text-muted hover:text-foreground"
          }`}
        >
          All Chains ({tokens.length})
        </button>
        {SUPPORTED_CHAINS.map((c) => {
          const count = breakdown[c.slug]?.tokenCount || 0;
          return (
            <button
              key={c.slug}
              onClick={() => setSelectedChain(c.slug)}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                selectedChain === c.slug
                  ? "bg-accent text-white"
                  : "bg-card text-muted hover:text-foreground"
              } ${count === 0 ? "opacity-40" : ""}`}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: c.color }}
              />
              {c.name} ({count})
            </button>
          );
        })}
      </div>

      {/* Search + Sort */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <input
          type="text"
          placeholder="Search token..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none sm:w-72"
        />
        <div className="flex gap-2">
          {(
            [
              ["value", "Highest Value"],
              ["change", "Top Gainers"],
              ["name", "Name A-Z"],
            ] as [SortKey, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSortBy(key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                sortBy === key
                  ? "bg-accent text-white"
                  : "bg-card text-muted hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Token table */}
      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-12 text-center text-muted">
          {search
            ? `No tokens found for "${search}"`
            : "No tokens found on this chain"}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-card text-left text-xs text-muted">
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Token</th>
                <th className="px-4 py-3">Chain</th>
                <th className="px-4 py-3 text-right">Balance</th>
                <th className="hidden px-4 py-3 text-right sm:table-cell">
                  Price
                </th>
                <th className="px-4 py-3 text-right">Value</th>
              </tr>
            </thead>
            <tbody>
              {visibleTokens.map((token, i) => (
                <TokenRow key={`${token.chain}-${token.address}-${i}`} token={token} index={i} />
              ))}
            </tbody>
          </table>
          {dustTokens.length > 0 && (
            <button
              onClick={() => setShowDust(!showDust)}
              className="flex w-full items-center justify-center gap-2 border-t border-border py-3 text-xs text-muted transition-colors hover:text-foreground"
            >
              {showDust ? "Hide" : "Show"} {dustTokens.length} small balance{dustTokens.length > 1 ? "s" : ""} (&lt;$1)
              <svg
                className={`h-3 w-3 transition-transform ${showDust ? "rotate-180" : ""}`}
                viewBox="0 0 12 12"
                fill="none"
              >
                <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      )}

      <div className="mt-4 text-right text-xs text-muted">
        {visibleTokens.length} of {filtered.length} tokens shown
        {selectedChain !== "all" &&
          ` on ${CHAIN_BY_SLUG[selectedChain]?.name || selectedChain}`}
      </div>
    </div>
  );
}

// --- Token Row ---

function TokenRow({ token, index }: { token: TokenHolding; index: number }) {
  const chain = CHAIN_BY_SLUG[token.chain];
  const change = token.priceChange24h;

  return (
    <tr className="border-b border-border/50 transition-colors last:border-0 hover:bg-card">
      <td className="px-4 py-3 text-xs text-muted">{index + 1}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          {token.logo && token.logo.startsWith("https://") ? (
            <img
              src={token.logo}
              alt={token.symbol}
              className="h-8 w-8 rounded-full"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
                (e.target as HTMLImageElement).nextElementSibling?.classList.remove("hidden");
              }}
            />
          ) : null}
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold text-white ${
              token.logo ? "hidden" : ""
            }`}
            style={{ backgroundColor: chain?.color || "#666" }}
          >
            {token.symbol.charAt(0)}
          </div>
          <div>
            <div className="font-medium">{token.symbol}</div>
            <div className="max-w-[150px] truncate text-xs text-muted">
              {token.name}
            </div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: chain?.color || "#666" }}
          />
          {chain?.name || token.chain}
        </span>
      </td>
      <td className="px-4 py-3 text-right font-mono text-xs">
        {formatTokenBalance(token.balance)}
      </td>
      <td className="hidden px-4 py-3 text-right sm:table-cell">
        {token.usdPrice != null ? (
          <div>
            <div className="text-xs">
              ${formatPrice(token.usdPrice)}
            </div>
            {change != null && (
              <div
                className={`text-[11px] ${
                  change >= 0 ? "text-success" : "text-error"
                }`}
              >
                {change >= 0 ? "+" : ""}
                {change.toFixed(2)}%
              </div>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        {token.usdValue != null && token.usdValue > 0 ? (
          <span className="font-medium">${formatUsd(token.usdValue)}</span>
        ) : (
          <span className="text-xs text-muted">—</span>
        )}
      </td>
    </tr>
  );
}

// --- Helpers ---

function formatUsd(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(0);
}

function formatPrice(n: number): string {
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 0.01) return n.toFixed(4);
  return n.toFixed(6);
}

function formatTokenBalance(balance: string): string {
  const n = parseFloat(balance);
  if (isNaN(n)) return balance;
  if (n === 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.0001) return n.toFixed(6);
  return "<0.0001";
}
