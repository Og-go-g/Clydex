"use client";

import { useState, useEffect, useCallback, useRef, type MutableRefObject } from "react";
import { useAuth } from "@/lib/auth/context";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { useToast } from "@/components/alerts/ToastProvider";

interface CopySubscriptionUI {
  id: string;
  leaderAddr: string;
  allocationUsdc: string;
  leverageMult: string;
  maxPositionUsdc: string | null;
  stopLossPct: string | null;
  active: boolean;
}

interface CopyStatus {
  sessionActive: boolean;
  sessionExpires: string | null;
  subscriptions: CopySubscriptionUI[];
  stats: {
    totalTrades: number;
    filledTrades: number;
    failedTrades: number;
    todayTrades: number;
  };
}

function shortenAddr(addr: string): string {
  return addr.slice(0, 4) + "..." + addr.slice(-4);
}

/** Copy trading content without wrapper — used inside CopyTradeSection tabs */
export function CopyTradingContent({ onRefreshRef }: { onRefreshRef?: MutableRefObject<(() => void) | null> }) {
  const { isAuthenticated } = useAuth();
  const { publicKey, signMessage, signTransaction } = useSolanaWallet();
  const [status, setStatus] = useState<CopyStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { addToast } = useToast();
  const prevTradeCountRef = useRef<number>(0);

  const fetchStatus = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const res = await fetch("/api/copy/status");
      if (!res.ok) return;
      const data = await res.json() as CopyStatus;

      // Detect new trades for toast notifications
      const newTotal = data.stats.totalTrades;
      const prevTotal = prevTradeCountRef.current;
      if (prevTotal > 0 && newTotal > prevTotal) {
        // Fetch recent trades to show in toasts
        try {
          const tradesRes = await fetch("/api/copy/subscribe");
          if (tradesRes.ok) {
            const diff = newTotal - prevTotal;
            const filledDiff = data.stats.filledTrades - (status?.stats.filledTrades ?? 0);
            const failedDiff = data.stats.failedTrades - (status?.stats.failedTrades ?? 0);
            if (filledDiff > 0) {
              addToast({ type: "success", title: "Copy Trade Executed", message: `${filledDiff} new trade(s) filled` });
            }
            if (failedDiff > 0) {
              addToast({ type: "error", title: "Copy Trade Failed", message: `${failedDiff} trade(s) failed` });
            }
          }
        } catch { /* silent */ }
      }
      prevTradeCountRef.current = newTotal;

      setStatus(data);
    } catch {
      // silently fail
    }
  }, [isAuthenticated, addToast, status?.stats.filledTrades, status?.stats.failedTrades]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Poll for updates every 30s when session is active
  useEffect(() => {
    if (!isAuthenticated || !status?.sessionActive) return;
    const interval = setInterval(fetchStatus, 30_000);
    return () => clearInterval(interval);
  }, [isAuthenticated, status?.sessionActive, fetchStatus]);

  // Expose refresh function to parent via ref
  useEffect(() => {
    if (onRefreshRef) {
      onRefreshRef.current = fetchStatus;
    }
  }, [onRefreshRef, fetchStatus]);

  const handleActivate = async () => {
    if (!publicKey || !signMessage || !signTransaction) {
      setError("Wallet not connected");
      return;
    }

    setActivating(true);
    setError(null);
    try {
      // Create NordUser session in browser — wallet signs the session creation
      const { createNordUserWithSessionKey } = await import("@/lib/n1/user-client");
      const { sessionSecretKey } = await createNordUserWithSessionKey({
        walletPubkey: publicKey,
        signMessageFn: signMessage,
        signTransactionFn: signTransaction as (tx: import("@solana/web3.js").Transaction) => Promise<import("@solana/web3.js").Transaction>,
      });

      // Send session key to server for encrypted storage
      const res = await fetch("/api/copy/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionSecretKey: bs58.encode(sessionSecretKey) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to activate");
        return;
      }
      await fetchStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Activation failed";
      // User rejected wallet signature
      if (msg.includes("User rejected") || msg.includes("rejected")) {
        setError("Wallet signature rejected");
      } else {
        setError(msg);
      }
    } finally {
      setActivating(false);
    }
  };

  const handleDeactivate = async () => {
    try {
      await fetch("/api/copy/activate", { method: "DELETE" });
      await fetchStatus();
    } catch {
      // ignore
    }
  };

  const handleToggle = async (subId: string, active: boolean) => {
    try {
      await fetch("/api/copy/subscribe", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: subId, active }),
      });
      await fetchStatus();
    } catch {
      // ignore
    }
  };

  const handleUnfollow = async (leaderAddr: string) => {
    try {
      await fetch(`/api/copy/subscribe?leader=${leaderAddr}`, { method: "DELETE" });
      await fetchStatus();
    } catch {
      // ignore
    }
  };

  return (
    <div className="px-3 py-2 space-y-2">
      {/* Not authenticated */}
      {!isAuthenticated && (
        <div className="py-4 text-center text-[10px] text-muted">
          Connect wallet to enable copy trading
        </div>
      )}

      {/* Not activated */}
      {isAuthenticated && !status?.sessionActive && (
        <div className="rounded-lg border border-[#262626] bg-[#0a0a0a] p-3 space-y-2">
          <p className="text-[11px] text-[#888] leading-relaxed">
            Enable copy trading to automatically mirror trades from top performers.
            Your session key will be securely encrypted on our server.
          </p>
          {error && (
            <p className="text-[11px] text-red-400">{error}</p>
          )}
          <button
            onClick={handleActivate}
            disabled={activating}
            className="w-full rounded-lg bg-accent/20 text-accent py-2 text-xs font-medium hover:bg-accent/30 transition-colors disabled:opacity-50"
          >
            {activating ? "Activating..." : "Enable Copy Trading"}
          </button>
        </div>
      )}

      {/* Activated, show subscriptions */}
      {isAuthenticated && status?.sessionActive && (
        <>
          {/* Session info */}
          <div className="flex items-center justify-between text-[10px] text-[#666]">
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
              <span>Active until {status.sessionExpires ? new Date(status.sessionExpires).toLocaleDateString() : "—"}</span>
            </div>
            <button onClick={handleDeactivate} className="text-red-400/60 hover:text-red-400 transition-colors">
              Disable
            </button>
          </div>

          {/* Subscriptions */}
          {status.subscriptions.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#262626] p-3 text-center">
              <p className="text-[11px] text-[#666]">
                No traders followed yet. Click "Copy" on a trader in the Top Traders tab.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {status.subscriptions.map((sub) => (
                <div key={sub.id} className="flex items-center justify-between rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full ${sub.active ? "bg-green-500" : "bg-[#555]"}`} />
                    <span className="text-xs font-mono text-[#ccc]">{shortenAddr(sub.leaderAddr)}</span>
                    <span className="text-[10px] text-[#666]">${parseFloat(sub.allocationUsdc).toFixed(0)}</span>
                    <span className="text-[10px] text-[#555]">{sub.leverageMult}x</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => handleToggle(sub.id, !sub.active)}
                      className={`rounded px-2 py-0.5 text-[10px] transition-colors ${
                        sub.active ? "bg-green-500/10 text-green-400 hover:bg-green-500/20" : "bg-[#222] text-[#666] hover:text-[#999]"
                      }`}
                    >
                      {sub.active ? "Active" : "Paused"}
                    </button>
                    <button
                      onClick={() => handleUnfollow(sub.leaderAddr)}
                      className="rounded p-1 text-[#555] hover:text-red-400 transition-colors"
                      title="Unfollow"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Stats */}
          {status.stats.totalTrades > 0 && (
            <div className="flex items-center gap-3 text-[10px] text-[#555] pt-1">
              <span>{status.stats.filledTrades} filled</span>
              {status.stats.failedTrades > 0 && (
                <span className="text-red-400/60">{status.stats.failedTrades} failed</span>
              )}
              <span>{status.stats.totalTrades} total</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** @deprecated Use CopyTradeSection instead */
export function CopyTradingPanel() {
  return <CopyTradingContent />;
}
