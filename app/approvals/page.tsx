"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useWallet } from "@/lib/wallet/context";
import { SUPPORTED_CHAINS, CHAIN_BY_SLUG } from "@/lib/defi/chains";
import type { ChainApprovalsResponse, TokenApproval } from "@/lib/defi/approvals";

type FilterRisk = "all" | "critical" | "high" | "medium" | "low";

/** Per-chain cached data */
interface ChainCache {
  approvals: TokenApproval[];
  totalApprovals: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  scannedAt: number;
}

// Default chain to load first
const DEFAULT_CHAIN = "base";

// ─── Chain hex IDs for wallet_switchEthereumChain ───────────────

const CHAIN_HEX: Record<number, string> = {
  1: "0x1",
  8453: "0x2105",
  42161: "0xa4b1",
  10: "0xa",
  137: "0x89",
  56: "0x38",
  43114: "0xa86a",
};

const CHAIN_PARAMS: Record<number, {
  chainId: string;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls: string[];
}> = {
  1: {
    chainId: "0x1", chainName: "Ethereum",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://eth.drpc.org"], blockExplorerUrls: ["https://etherscan.io"],
  },
  8453: {
    chainId: "0x2105", chainName: "Base",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"],
  },
  42161: {
    chainId: "0xa4b1", chainName: "Arbitrum One",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://arb1.arbitrum.io/rpc"], blockExplorerUrls: ["https://arbiscan.io"],
  },
  10: {
    chainId: "0xa", chainName: "Optimism",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://mainnet.optimism.io"], blockExplorerUrls: ["https://optimistic.etherscan.io"],
  },
  137: {
    chainId: "0x89", chainName: "Polygon",
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    rpcUrls: ["https://polygon-rpc.com"], blockExplorerUrls: ["https://polygonscan.com"],
  },
  56: {
    chainId: "0x38", chainName: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: ["https://bsc-dataseed1.binance.org"], blockExplorerUrls: ["https://bscscan.com"],
  },
  43114: {
    chainId: "0xa86a", chainName: "Avalanche",
    nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
    rpcUrls: ["https://api.avax.network/ext/bc/C/rpc"], blockExplorerUrls: ["https://snowtrace.io"],
  },
};

// ─── Risk badge colors ──────────────────────────────────────────

const RISK_STYLES: Record<
  TokenApproval["risk"],
  { bg: string; text: string; label: string }
> = {
  critical: { bg: "bg-red-500/10", text: "text-red-400", label: "Critical" },
  high: { bg: "bg-orange-500/10", text: "text-orange-400", label: "High" },
  medium: { bg: "bg-yellow-500/10", text: "text-yellow-400", label: "Medium" },
  low: { bg: "bg-green-500/10", text: "text-green-400", label: "Low" },
};

// ─── Switch wallet to a specific chain ──────────────────────────

async function switchWalletChain(provider: EIP1193Provider, targetChainId: number): Promise<boolean> {
  const hexId = CHAIN_HEX[targetChainId];
  if (!hexId) return false;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexId }],
    });
    return true;
  } catch (switchError: unknown) {
    const err = switchError as { code?: number };
    if (err.code === 4902) {
      const params = CHAIN_PARAMS[targetChainId];
      if (!params) return false;
      try {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [params],
        });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════

export default function ApprovalsPage() {
  const { address, chainId, connect } = useWallet();

  // Per-chain cache — persists between tab switches within session
  const [chainCache, setChainCache] = useState<Record<string, ChainCache>>({});
  const [activeChain, setActiveChain] = useState<string>(DEFAULT_CHAIN);
  const [loadingChains, setLoadingChains] = useState<Set<string>>(new Set());
  const [chainErrors, setChainErrors] = useState<Record<string, string>>({});

  const [filter, setFilter] = useState<FilterRisk>("all");
  const [search, setSearch] = useState("");
  const [revokingSet, setRevokingSet] = useState<Set<string>>(new Set());
  const [revokedSet, setRevokedSet] = useState<Set<string>>(new Set());
  const [selectedForBatch, setSelectedForBatch] = useState<Set<string>>(new Set());
  const [batchRevoking, setBatchRevoking] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Track which address we last loaded for — reset cache on wallet change
  const lastAddress = useRef<string | null>(null);
  // Ref to read current cache without stale closures
  const chainCacheRef = useRef(chainCache);
  chainCacheRef.current = chainCache;

  // ─── Fetch single chain approvals ──────────────────────────────

  const fetchChain = useCallback(async (chainSlug: string, forceRefresh = false) => {
    if (!address) return;

    // Skip if already cached and not forcing refresh (read from ref to avoid stale closure)
    if (!forceRefresh && chainCacheRef.current[chainSlug]) return;

    setLoadingChains((prev) => new Set(prev).add(chainSlug));
    setChainErrors((prev) => {
      const next = { ...prev };
      delete next[chainSlug];
      return next;
    });

    try {
      const res = await fetch(`/api/approvals?address=${address}&chain=${chainSlug}`);
      const json: ChainApprovalsResponse = await res.json();
      if (!res.ok) throw new Error((json as unknown as { error: string }).error || "Failed to scan");

      const oldCache = chainCacheRef.current[chainSlug];

      // Guard against RPC rate-limiting on rescan:
      // If we previously had approvals but the new scan returned 0,
      // it likely means RPC was unreachable and all items were dropped.
      // Keep the old cached data and notify the user.
      if (forceRefresh && oldCache && oldCache.totalApprovals > 0 && json.totalApprovals === 0) {
        setToastMessage("RPC rate limited — showing cached data. Try again in a minute.");
        return;
      }

      setChainCache((prev) => ({
        ...prev,
        [chainSlug]: {
          approvals: json.approvals,
          totalApprovals: json.totalApprovals,
          criticalCount: json.criticalCount,
          highCount: json.highCount,
          mediumCount: json.mediumCount,
          lowCount: json.lowCount,
          scannedAt: json.scannedAt,
        },
      }));
    } catch (err) {
      // On rescan failure, keep old cache — don't set error if we have data
      const oldCache = chainCacheRef.current[chainSlug];
      if (forceRefresh && oldCache) {
        setToastMessage("Rescan failed — showing cached data");
        return;
      }
      setChainErrors((prev) => ({
        ...prev,
        [chainSlug]: err instanceof Error ? err.message : "Failed to scan",
      }));
    } finally {
      setLoadingChains((prev) => {
        const next = new Set(prev);
        next.delete(chainSlug);
        return next;
      });
    }
  }, [address]);

  // ─── Auto-load default chain on wallet connect ──────────────────

  useEffect(() => {
    if (address && address !== lastAddress.current) {
      // Wallet changed — clear all cached data and load default chain
      lastAddress.current = address;
      setChainCache({});
      setChainErrors({});
      setLoadingChains(new Set());
      setRevokedSet(new Set());
      setSelectedForBatch(new Set());
      setActiveChain(DEFAULT_CHAIN);
      setFilter("all");
      setSearch("");

      // Fetch default chain
      const doFetch = async () => {
        setLoadingChains(new Set([DEFAULT_CHAIN]));
        try {
          const res = await fetch(`/api/approvals?address=${address}&chain=${DEFAULT_CHAIN}`);
          const json: ChainApprovalsResponse = await res.json();
          if (!res.ok) throw new Error((json as unknown as { error: string }).error || "Failed to scan");

          setChainCache({
            [DEFAULT_CHAIN]: {
              approvals: json.approvals,
              totalApprovals: json.totalApprovals,
              criticalCount: json.criticalCount,
              highCount: json.highCount,
              mediumCount: json.mediumCount,
              lowCount: json.lowCount,
              scannedAt: json.scannedAt,
            },
          });
        } catch (err) {
          setChainErrors({
            [DEFAULT_CHAIN]: err instanceof Error ? err.message : "Failed to scan",
          });
        } finally {
          setLoadingChains((prev) => {
            const next = new Set(prev);
            next.delete(DEFAULT_CHAIN);
            return next;
          });
        }
      };
      doFetch();
    } else if (!address) {
      lastAddress.current = null;
      setChainCache({});
      setChainErrors({});
      setLoadingChains(new Set());
      setRevokedSet(new Set());
      setSelectedForBatch(new Set());
    }
  }, [address]);

  // ─── Switch chain tab ──────────────────────────────────────────

  const handleChainTabClick = (slug: string) => {
    setActiveChain(slug);
    setFilter("all");
    setSearch("");
    setSelectedForBatch(new Set());

    // If chain not cached and not currently loading, fetch it
    if (!chainCacheRef.current[slug] && !loadingChains.has(slug) && !chainErrors[slug]) {
      fetchChain(slug);
    }
  };

  // ─── Rescan current chain ──────────────────────────────────────

  const rescanCurrentChain = () => {
    fetchChain(activeChain, true);
  };

  // ─── Toast auto-dismiss ───────────────────────────────────────

  useEffect(() => {
    if (!toastMessage) return;
    const timer = setTimeout(() => setToastMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [toastMessage]);

  // ─── Get wallet provider ──────────────────────────────────────

  function getProvider(): EIP1193Provider | null {
    if (typeof window === "undefined") return null;
    return (window as unknown as Record<string, unknown>).ethereum as EIP1193Provider | null;
  }

  // ─── Revoke single approval (with auto chain switch) ──────────

  const revokeApproval = async (approval: TokenApproval) => {
    const key = `${approval.chainId}:${approval.tokenAddress}|${approval.spenderAddress}`;
    if (revokingSet.has(key) || revokedSet.has(key)) return;

    const provider = getProvider();
    if (!provider || !address) return;

    setRevokingSet((prev) => new Set(prev).add(key));

    try {
      if (chainId !== approval.chainId) {
        const chainName = CHAIN_BY_SLUG[approval.chain]?.name || approval.chain;
        setToastMessage(`Switching to ${chainName}...`);
        const switched = await switchWalletChain(provider, approval.chainId);
        if (!switched) {
          setToastMessage(`Please switch to ${chainName} manually`);
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenAddress: approval.tokenAddress,
          spenderAddress: approval.spenderAddress,
          chainId: approval.chainId,
        }),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to build revoke tx");

      const tx = json.transaction;

      const txHash = await provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: address,
            to: tx.to,
            data: tx.data,
            value: tx.value,
            gas: tx.gasLimit,
          },
        ],
      });

      const chainName = CHAIN_BY_SLUG[approval.chain]?.name || approval.chain;
      setToastMessage(`Revoking ${approval.tokenSymbol} on ${chainName}...`);
      await waitForReceipt(provider, txHash as string);

      setRevokedSet((prev) => new Set(prev).add(key));
      setSelectedForBatch((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setToastMessage(`✓ Revoked ${approval.tokenSymbol} → ${approval.spenderLabel}`);
    } catch (err) {
      const walletErr = err as { code?: number; message?: string };
      if (walletErr.code === 4001) {
        setToastMessage("Transaction rejected by user");
      } else {
        setToastMessage(`Failed: ${walletErr.message || "Unknown error"}`);
      }
    } finally {
      setRevokingSet((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  // ─── Batch revoke (auto chain switch per chain group) ──────────

  const revokeBatch = async () => {
    if (selectedForBatch.size === 0 || batchRevoking) return;

    const provider = getProvider();
    if (!provider || !address) return;

    setBatchRevoking(true);

    // Get all approvals from all cached chains for the selected keys (use ref to avoid stale closure)
    const allCachedApprovals: TokenApproval[] = [];
    for (const cache of Object.values(chainCacheRef.current)) {
      allCachedApprovals.push(...cache.approvals);
    }

    const toRevoke = allCachedApprovals.filter((a) =>
      selectedForBatch.has(`${a.chainId}:${a.tokenAddress}|${a.spenderAddress}`)
    );

    // Group by chain for efficient switching
    const byChain = new Map<number, TokenApproval[]>();
    for (const approval of toRevoke) {
      const list = byChain.get(approval.chainId) || [];
      list.push(approval);
      byChain.set(approval.chainId, list);
    }

    let successCount = 0;
    let cancelled = false;

    for (const [targetChainId, chainApprovals] of byChain) {
      if (cancelled) break;

      const chainName = SUPPORTED_CHAINS.find((c) => c.id === targetChainId)?.name || `Chain ${targetChainId}`;
      setToastMessage(`Switching to ${chainName}...`);

      const switched = await switchWalletChain(provider, targetChainId);
      if (!switched) {
        setToastMessage(`Could not switch to ${chainName} — skipping`);
        continue;
      }
      await new Promise((r) => setTimeout(r, 500));

      for (const approval of chainApprovals) {
        if (cancelled) break;

        const key = `${approval.chainId}:${approval.tokenAddress}|${approval.spenderAddress}`;
        if (revokedSet.has(key)) {
          successCount++;
          continue;
        }

        setRevokingSet((prev) => new Set(prev).add(key));

        try {
          const res = await fetch("/api/approvals", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tokenAddress: approval.tokenAddress,
              spenderAddress: approval.spenderAddress,
              chainId: approval.chainId,
            }),
          });

          const json = await res.json();
          if (!res.ok) throw new Error(json.error);

          const tx = json.transaction;
          const txHash = await provider.request({
            method: "eth_sendTransaction",
            params: [
              {
                from: address,
                to: tx.to,
                data: tx.data,
                value: tx.value,
                gas: tx.gasLimit,
              },
            ],
          });

          setToastMessage(
            `Revoking ${approval.tokenSymbol} on ${chainName} (${successCount + 1}/${toRevoke.length})...`
          );
          await waitForReceipt(provider, txHash as string);

          setRevokedSet((prev) => new Set(prev).add(key));
          successCount++;
        } catch (err) {
          const walletErr = err as { code?: number };
          if (walletErr.code === 4001) {
            setToastMessage("Batch revoke cancelled by user");
            cancelled = true;
          } else {
            setToastMessage(`Failed to revoke ${approval.tokenSymbol}, continuing...`);
          }
        } finally {
          setRevokingSet((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        }
      }
    }

    setSelectedForBatch(new Set());
    setBatchRevoking(false);

    if (successCount > 0) {
      setToastMessage(`✓ Revoked ${successCount} approval${successCount > 1 ? "s" : ""}`);
    }
  };

  // ─── Current chain data & filtering ─────────────────────────────

  const currentCache = chainCache[activeChain];
  const isCurrentLoading = loadingChains.has(activeChain);
  const currentError = chainErrors[activeChain];
  const isLoaded = !!currentCache;

  const approvals = currentCache?.approvals || [];
  const activeApprovals = approvals.filter(
    (a) => !revokedSet.has(`${a.chainId}:${a.tokenAddress}|${a.spenderAddress}`)
  );

  const filtered = activeApprovals.filter((a) => {
    if (filter !== "all" && a.risk !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        a.tokenSymbol.toLowerCase().includes(q) ||
        a.tokenName.toLowerCase().includes(q) ||
        a.spenderLabel.toLowerCase().includes(q) ||
        a.spenderAddress.toLowerCase().includes(q)
      );
    }
    return true;
  });

  // ─── Toggle batch select ──────────────────────────────────────

  const makeKey = (a: TokenApproval) => `${a.chainId}:${a.tokenAddress}|${a.spenderAddress}`;

  const toggleBatchSelect = (key: string) => {
    setSelectedForBatch((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAllFiltered = () => {
    const keys = filtered.map(makeKey);
    const allSelected = keys.every((k) => selectedForBatch.has(k));
    if (allSelected) {
      // Only remove the filtered keys, keep selections from other chains
      setSelectedForBatch((prev) => {
        const next = new Set(prev);
        for (const k of keys) next.delete(k);
        return next;
      });
    } else {
      // Add all filtered keys to existing selection
      setSelectedForBatch((prev) => {
        const next = new Set(prev);
        for (const k of keys) next.add(k);
        return next;
      });
    }
  };

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((a) => selectedForBatch.has(makeKey(a)));

  // ─── Risk counts for current chain ──────────────────────────────

  const activeCritical = activeApprovals.filter((a) => a.risk === "critical").length;
  const activeHigh = activeApprovals.filter((a) => a.risk === "high").length;
  const activeMedium = activeApprovals.filter((a) => a.risk === "medium").length;
  const activeLow = activeApprovals.filter((a) => a.risk === "low").length;

  // ─── Total counts across all loaded chains ─────────────────────

  const totalAcrossChains = Object.values(chainCache).reduce((sum, c) => sum + c.totalApprovals, 0);
  const loadedChainCount = Object.keys(chainCache).length;

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════

  // No wallet
  if (!address) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-border bg-card py-20 text-center">
          <div className="mb-4 text-5xl">🔐</div>
          <h2 className="text-xl font-bold">Connect Your Wallet</h2>
          <p className="mt-2 max-w-sm text-sm text-muted">
            Connect your wallet to scan token approvals and revoke risky
            permissions across {SUPPORTED_CHAINS.length} chains.
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

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      {/* Toast */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 animate-[slideUp_0.3s_ease-out] rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground shadow-2xl">
          {toastMessage}
        </div>
      )}

      {/* Header */}
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold">Token Approvals</h1>
          <p className="mt-1 text-sm text-muted">
            {address.slice(0, 6)}...{address.slice(-4)}
            {loadedChainCount > 0 && (
              <span>
                {" "}· {totalAcrossChains} approval{totalAcrossChains !== 1 ? "s" : ""} across {loadedChainCount} chain{loadedChainCount > 1 ? "s" : ""}
              </span>
            )}
          </p>
        </div>
        <button
          onClick={rescanCurrentChain}
          disabled={isCurrentLoading}
          className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm text-muted transition-colors hover:bg-card-hover hover:text-foreground"
        >
          <svg
            className={`h-4 w-4 ${isCurrentLoading ? "animate-spin" : ""}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 12a9 9 0 11-2.636-6.364" strokeLinecap="round" />
          </svg>
          Rescan
        </button>
      </div>

      {/* ─── Chain Tabs ─────────────────────────────────────────── */}
      <div className="mb-6 flex gap-2 overflow-x-auto pb-1">
        {SUPPORTED_CHAINS.map((c) => {
          const cached = chainCache[c.slug];
          const isActive = activeChain === c.slug;
          const isLoadingThis = loadingChains.has(c.slug);
          const hasError = !!chainErrors[c.slug];
          const count = cached ? cached.totalApprovals : null;

          return (
            <button
              key={c.slug}
              onClick={() => handleChainTabClick(c.slug)}
              disabled={isLoadingThis}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                isActive
                  ? "bg-accent text-white"
                  : "bg-card text-muted hover:text-foreground"
              }`}
            >
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${isLoadingThis ? "animate-pulse" : ""}`}
                style={{ backgroundColor: isActive ? "rgba(255,255,255,0.7)" : c.color }}
              />
              {c.name}
              {isLoadingThis ? (
                <span className="ml-0.5 h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
              ) : count !== null ? (
                <span className={`ml-0.5 ${isActive ? "text-white/70" : ""}`}>
                  ({count})
                </span>
              ) : hasError ? (
                <span className="ml-0.5 text-red-400">!</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* ─── Chain Content Area ─────────────────────────────────── */}

      {/* Loading state for current chain */}
      {isCurrentLoading && !isLoaded && (
        <div className="rounded-2xl border border-border bg-card p-8">
          <div className="flex flex-col items-center gap-4">
            <div className="relative h-14 w-14">
              <div className="absolute inset-0 animate-ping rounded-full bg-accent/20" />
              <div className="absolute inset-2 animate-pulse rounded-full bg-accent/30" />
              <div className="absolute inset-4 rounded-full bg-accent/50" />
            </div>
            <div className="text-sm text-muted">
              Scanning {CHAIN_BY_SLUG[activeChain]?.name || activeChain} approvals...
            </div>
            <div className="h-1.5 w-48 overflow-hidden rounded-full bg-border">
              <div className="h-full animate-[scan_2s_ease-in-out_infinite] rounded-full bg-accent" />
            </div>
          </div>

          {/* Skeleton rows */}
          <div className="mt-6 space-y-2">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex animate-pulse items-center gap-4 rounded-xl border border-border/50 p-4"
              >
                <div className="h-4 w-4 rounded bg-border" />
                <div className="h-8 w-8 rounded-full bg-border" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-32 rounded bg-border" />
                  <div className="h-3 w-48 rounded bg-border" />
                </div>
                <div className="h-6 w-16 rounded-full bg-border" />
                <div className="h-8 w-20 rounded bg-border" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Error state for current chain */}
      {currentError && !isCurrentLoading && (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-6 text-center">
          <p className="text-sm text-red-400">{currentError}</p>
          <button
            onClick={rescanCurrentChain}
            className="mt-4 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
          >
            Try Again
          </button>
        </div>
      )}

      {/* Not loaded yet (user hasn't clicked this tab's load) */}
      {!isLoaded && !isCurrentLoading && !currentError && (
        <div className="rounded-2xl border border-border bg-card p-12 text-center">
          <div className="mb-3 text-3xl">
            <span
              className="inline-block h-4 w-4 rounded-full"
              style={{ backgroundColor: CHAIN_BY_SLUG[activeChain]?.color || "#666" }}
            />
          </div>
          <div className="font-medium text-foreground">
            {CHAIN_BY_SLUG[activeChain]?.name || activeChain}
          </div>
          <p className="mt-2 text-sm text-muted">
            Click to scan approvals on this chain
          </p>
          <button
            onClick={() => fetchChain(activeChain)}
            className="mt-4 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
          >
            Scan {CHAIN_BY_SLUG[activeChain]?.name || activeChain}
          </button>
        </div>
      )}

      {/* Loaded — show results (keep visible during rescan) */}
      {isLoaded && (
        <>
          {/* Summary Cards */}
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryCard label="Total Active" count={activeApprovals.length} accent="text-foreground" />
            <SummaryCard label="Critical" count={activeCritical} accent="text-red-400" dot="bg-red-500" />
            <SummaryCard label="High Risk" count={activeHigh} accent="text-orange-400" dot="bg-orange-500" />
            <SummaryCard label="Medium" count={activeMedium} accent="text-yellow-400" dot="bg-yellow-500" />
          </div>

          {/* Refreshing indicator */}
          {isCurrentLoading && isLoaded && (
            <div className="mb-4 flex items-center gap-2 text-xs text-muted">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-accent" />
              Refreshing...
            </div>
          )}

          {/* Alert banner */}
          {(activeCritical > 0 || activeHigh > 0) && (
            <div
              className={`mb-6 rounded-xl border px-4 py-3 text-sm ${
                activeCritical > 0
                  ? "border-red-500/30 bg-red-500/10 text-red-400"
                  : "border-orange-500/30 bg-orange-500/10 text-orange-400"
              }`}
            >
              {activeCritical > 0
                ? `⚠️ ${activeCritical} critical approval${activeCritical > 1 ? "s" : ""} found — unknown contracts have unlimited access to your tokens.`
                : `⚠️ ${activeHigh} approval${activeHigh > 1 ? "s" : ""} to unverified contracts.`}{" "}
              Review and revoke any you don&apos;t recognize.
            </div>
          )}

          {/* All clear for this chain */}
          {activeApprovals.length === 0 && (
            <div className="mb-6 rounded-xl border border-green-500/30 bg-green-500/10 px-4 py-8 text-center">
              <div className="mb-2 text-3xl">🛡️</div>
              <div className="font-medium text-green-400">All Clear</div>
              <div className="mt-1 text-sm text-muted">
                {revokedSet.size > 0
                  ? `You revoked approvals this session. ${CHAIN_BY_SLUG[activeChain]?.name || activeChain} is clean!`
                  : `No active token approvals found on ${CHAIN_BY_SLUG[activeChain]?.name || activeChain}.`}
              </div>
            </div>
          )}

          {activeApprovals.length > 0 && (
            <>
              {/* Risk filters + Search */}
              <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {(
                    [
                      ["all", "All"],
                      ["critical", "Critical"],
                      ["high", "High"],
                      ["medium", "Medium"],
                      ["low", "Low"],
                    ] as [FilterRisk, string][]
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setFilter(key)}
                      className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                        filter === key
                          ? "bg-accent text-white"
                          : "bg-card text-muted hover:text-foreground"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  placeholder="Search token or spender..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none sm:w-64"
                />
              </div>

              {/* Batch actions */}
              {selectedForBatch.size > 0 && (
                <div className="mb-4 flex items-center justify-between rounded-xl border border-accent/30 bg-accent/10 px-4 py-3">
                  <span className="text-sm text-foreground">
                    {selectedForBatch.size} approval{selectedForBatch.size > 1 ? "s" : ""} selected
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setSelectedForBatch(new Set())}
                      className="rounded-lg px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground"
                    >
                      Clear
                    </button>
                    <button
                      onClick={revokeBatch}
                      disabled={batchRevoking}
                      className="rounded-lg bg-red-500 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
                    >
                      {batchRevoking
                        ? "Revoking..."
                        : `Revoke ${selectedForBatch.size} Approval${selectedForBatch.size > 1 ? "s" : ""}`}
                    </button>
                  </div>
                </div>
              )}

              {/* Approval list */}
              {filtered.length === 0 ? (
                <div className="rounded-2xl border border-border bg-card p-12 text-center text-muted">
                  {search
                    ? `No approvals found for "${search}"`
                    : "No approvals match this filter"}
                </div>
              ) : (
                <div className="overflow-hidden rounded-2xl border border-border">
                  {/* Select all */}
                  <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-2.5">
                    <button
                      onClick={selectAllFiltered}
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                        allFilteredSelected
                          ? "border-accent bg-accent"
                          : "border-muted hover:border-foreground"
                      }`}
                      aria-label="Select all approvals"
                    >
                      {allFilteredSelected && (
                        <svg className="h-3 w-3 text-white" viewBox="0 0 12 12" fill="none">
                          <path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </button>
                    <span className="text-xs text-muted">
                      {filtered.length} approval{filtered.length > 1 ? "s" : ""}
                    </span>
                  </div>

                  {/* Rows */}
                  <div className="divide-y divide-border/50">
                    {filtered.map((approval) => {
                      const key = makeKey(approval);
                      return (
                        <ApprovalRow
                          key={key}
                          approval={approval}
                          isSelected={selectedForBatch.has(key)}
                          isRevoking={revokingSet.has(key)}
                          isRevoked={revokedSet.has(key)}
                          currentChainId={chainId}
                          onToggleSelect={() => toggleBatchSelect(key)}
                          onRevoke={() => revokeApproval(approval)}
                        />
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Revoked count */}
              {revokedSet.size > 0 && (
                <div className="mt-4 text-center text-xs text-green-400">
                  ✓ {revokedSet.size} approval{revokedSet.size > 1 ? "s" : ""} revoked this session
                </div>
              )}

              <div className="mt-4 text-right text-xs text-muted">
                {currentCache && (
                  <>
                    Scanned at {new Date(currentCache.scannedAt).toLocaleTimeString()} ·{" "}
                  </>
                )}
                {filtered.length} of {activeApprovals.length} shown
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─── Summary Card ───────────────────────────────────────────────

function SummaryCard({
  label,
  count,
  accent,
  dot,
}: {
  label: string;
  count: number;
  accent: string;
  dot?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        {dot && <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />}
        {label}
      </div>
      <div className={`mt-1 text-2xl font-bold ${accent}`}>{count}</div>
    </div>
  );
}

// ─── Approval Row ───────────────────────────────────────────────

function ApprovalRow({
  approval,
  isSelected,
  isRevoking,
  isRevoked,
  currentChainId,
  onToggleSelect,
  onRevoke,
}: {
  approval: TokenApproval;
  isSelected: boolean;
  isRevoking: boolean;
  isRevoked: boolean;
  currentChainId: number | null;
  onToggleSelect: () => void;
  onRevoke: () => void;
}) {
  const risk = RISK_STYLES[approval.risk];
  const chain = CHAIN_BY_SLUG[approval.chain];
  const needsSwitch = currentChainId !== approval.chainId;

  if (isRevoked) return null;

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 transition-colors hover:bg-card ${
        isRevoking ? "opacity-50" : ""
      }`}
    >
      {/* Checkbox */}
      <button
        onClick={onToggleSelect}
        disabled={isRevoking}
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
          isSelected
            ? "border-accent bg-accent"
            : "border-muted hover:border-foreground"
        }`}
        aria-label={`Select ${approval.tokenSymbol} approval`}
      >
        {isSelected && (
          <svg className="h-3 w-3 text-white" viewBox="0 0 12 12" fill="none">
            <path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {/* Token icon */}
      {approval.tokenLogo ? (
        <img
          src={approval.tokenLogo}
          alt={approval.tokenSymbol}
          className="h-9 w-9 shrink-0 rounded-full"
          onError={(e) => {
            const target = e.currentTarget;
            target.style.display = "none";
            const fallback = target.nextElementSibling as HTMLElement | null;
            if (fallback) fallback.style.display = "flex";
          }}
        />
      ) : null}
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
        style={{
          display: approval.tokenLogo ? "none" : "flex",
          backgroundColor:
            approval.risk === "critical"
              ? "#ef4444"
              : approval.risk === "high"
              ? "#f97316"
              : chain?.color || "#3b82f6",
        }}
      >
        {approval.tokenSymbol.charAt(0)}
      </div>

      {/* Token + spender info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{approval.tokenSymbol}</span>
          <span className="text-xs text-muted">→</span>
          {approval.explorerUrl ? (
            <a
              href={approval.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate text-sm text-muted transition-colors hover:text-accent hover:underline"
            >
              {approval.spenderLabel}
            </a>
          ) : (
            <span className="truncate text-sm text-muted">
              {approval.spenderLabel}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
          {/* Risk badge */}
          <span
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${risk.bg} ${risk.text}`}
          >
            {risk.label}
          </span>
          <span className="hidden truncate sm:inline">
            {approval.riskReason}
          </span>
        </div>
      </div>

      {/* Allowance + USD at risk */}
      <div className="hidden shrink-0 text-right sm:block">
        <div
          className={`text-sm font-medium ${
            approval.isUnlimited ? "text-red-400" : "text-foreground"
          }`}
        >
          {approval.allowanceFormatted}
        </div>
        {approval.usdAtRisk != null && approval.usdAtRisk > 0 ? (
          <div className="text-[10px] text-red-400/80">
            ${approval.usdAtRisk >= 1_000_000
              ? (approval.usdAtRisk / 1_000_000).toFixed(1) + "M"
              : approval.usdAtRisk >= 1_000
              ? (approval.usdAtRisk / 1_000).toFixed(1) + "K"
              : approval.usdAtRisk.toFixed(2)}{" "}
            at risk
          </div>
        ) : (
          <div className="text-[10px] text-muted">allowed</div>
        )}
      </div>

      {/* Revoke button */}
      <button
        onClick={onRevoke}
        disabled={isRevoking}
        className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
          isRevoking
            ? "bg-border text-muted"
            : approval.risk === "critical" || approval.risk === "high"
            ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
            : "bg-card text-muted hover:bg-border hover:text-foreground"
        }`}
      >
        {isRevoking ? (
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-transparent" />
          </span>
        ) : needsSwitch ? (
          <span className="flex items-center gap-1">
            <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none">
              <path d="M2 4h8M7 1l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Revoke
          </span>
        ) : (
          "Revoke"
        )}
      </button>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────

async function waitForReceipt(
  provider: EIP1193Provider,
  txHash: string,
  maxWait: number = 60_000
): Promise<void> {
  const start = Date.now();
  const POLL_INTERVAL = 2_000;

  while (Date.now() - start < maxWait) {
    try {
      const receipt = await provider.request({
        method: "eth_getTransactionReceipt",
        params: [txHash],
      });

      if (receipt) {
        const status = (receipt as Record<string, string>).status;
        if (status === "0x0") {
          throw new Error("Transaction reverted");
        }
        return;
      }
    } catch (err) {
      const error = err as Error;
      if (error.message === "Transaction reverted") throw err;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }

  throw new Error("Transaction confirmation timeout");
}
