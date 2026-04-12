"use client";

import { useState, useEffect, useCallback, useRef, type MutableRefObject } from "react";
import { useAuth } from "@/lib/auth/context";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { useToast } from "@/components/alerts/ToastProvider";

// ─── Types ─────────────────────────────────────────────────────

interface LeaderTradeLog {
  symbol: string;
  side: string;
  size: string;
  price: string | null;
  status: string;
  createdAt: string;
}

interface LeaderStats {
  totalTrades: number;
  filledTrades: number;
  failedTrades: number;
  totalVolume: number;
}

interface CopySubscriptionUI {
  id: string;
  leaderAddr: string;
  allocationUsdc: string;
  leverageMult: string;
  maxPositionUsdc: string | null;
  stopLossPct: string | null;
  active: boolean;
  stats: LeaderStats;
  recentTrades: LeaderTradeLog[];
}

interface CopyTradeLog {
  symbol: string;
  side: string;
  size: string;
  price: string | null;
  status: string;
  error: string | null;
  leaderAddr: string;
  createdAt: string;
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
  recentTrades: CopyTradeLog[];
}

function shortenAddr(addr: string): string {
  if (addr.startsWith("account:")) return "#" + addr.slice(8);
  return addr.slice(0, 4) + "..." + addr.slice(-4);
}

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return "$" + (abs / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000) return "$" + (abs / 1_000).toFixed(1) + "K";
  if (abs > 0) return "$" + abs.toFixed(2);
  return "$0";
}

// ─── Expandable Leader Card ────────────────────────────────────

function LeaderCard({
  sub,
  expanded,
  onToggleExpand,
  onToggleActive,
  onUnfollow,
}: {
  sub: CopySubscriptionUI;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleActive: () => void;
  onUnfollow: () => void;
}) {
  return (
    <div className="rounded-lg border border-[#262626] bg-[#0a0a0a] overflow-hidden transition-all">
      {/* Collapsed row — clickable to expand */}
      <button
        onClick={onToggleExpand}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-[#111] transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${sub.active ? "bg-green-500" : "bg-[#555]"}`} />
          <span className="text-xs font-mono text-[#ccc]">{shortenAddr(sub.leaderAddr)}</span>
          <span className="text-[10px] text-[#666]">${parseFloat(sub.allocationUsdc).toFixed(0)}</span>
          <span className="text-[10px] text-[#555]">{sub.leverageMult}x</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Per-leader volume badge */}
          {sub.stats.filledTrades > 0 && (
            <span className="text-[10px] font-mono text-[#888]">
              Vol {fmtUsd(sub.stats.totalVolume)}
            </span>
          )}
          <span className="text-[10px] text-[#555]">{sub.stats.filledTrades} trades</span>
          {/* Chevron */}
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={`text-[#555] transition-transform ${expanded ? "rotate-180" : ""}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-[#1a1a1a] px-3 py-2 space-y-2">
          {/* Stats row */}
          <div className="grid grid-cols-4 gap-2">
            <div className="text-center">
              <p className="text-[9px] text-[#555]">Filled</p>
              <p className="text-[11px] font-mono text-emerald-400">{sub.stats.filledTrades}</p>
            </div>
            <div className="text-center">
              <p className="text-[9px] text-[#555]">Failed</p>
              <p className="text-[11px] font-mono text-red-400">{sub.stats.failedTrades}</p>
            </div>
            <div className="text-center">
              <p className="text-[9px] text-[#555]">Total</p>
              <p className="text-[11px] font-mono text-[#ccc]">{sub.stats.totalTrades}</p>
            </div>
            <div className="text-center">
              <p className="text-[9px] text-[#555]">Volume</p>
              <p className="text-[11px] font-mono text-[#ccc]">
                {fmtUsd(sub.stats.totalVolume)}
              </p>
            </div>
          </div>

          {/* Settings */}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-[#666]">
            <span>Allocation: <strong className="text-[#999]">${parseFloat(sub.allocationUsdc).toFixed(0)}</strong></span>
            <span>Leverage: <strong className="text-[#999]">{sub.leverageMult}x</strong></span>
            {sub.maxPositionUsdc && (
              <span>Max pos: <strong className="text-[#999]">${parseFloat(sub.maxPositionUsdc).toFixed(0)}</strong></span>
            )}
            {sub.stopLossPct && (
              <span>Stop loss: <strong className="text-[#999]">{sub.stopLossPct}%</strong></span>
            )}
          </div>

          {/* Recent trades from this leader */}
          {sub.recentTrades.length > 0 && (
            <div>
              <p className="text-[9px] text-[#555] mb-1">Recent Trades</p>
              <div className="space-y-0.5">
                {sub.recentTrades.map((t, i) => (
                  <div key={i} className="flex items-center justify-between text-[9px] font-mono px-1.5 py-0.5 rounded bg-[#111]">
                    <div className="flex items-center gap-1.5">
                      <span className={`h-1 w-1 rounded-full ${t.status === "filled" ? "bg-emerald-500" : "bg-red-500"}`} />
                      <span className={t.side === "Long" ? "text-emerald-400" : "text-red-400"}>{t.side}</span>
                      <span className="text-[#ccc]">{t.symbol}</span>
                      <span className="text-[#666]">{parseFloat(t.size).toFixed(4)}</span>
                    </div>
                    <span className="text-[#555]">
                      {new Date(t.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={(e) => { e.stopPropagation(); onToggleActive(); }}
              className={`flex-1 rounded-lg py-1.5 text-[10px] font-medium transition-colors ${
                sub.active
                  ? "bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20"
                  : "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"
              }`}
            >
              {sub.active ? "Pause" : "Resume"}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onUnfollow(); }}
              className="flex-1 rounded-lg py-1.5 text-[10px] font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
            >
              Unfollow
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────

/** Copy trading content without wrapper — used inside CopyTradeSection tabs */
export function CopyTradingContent({ onRefreshRef }: { onRefreshRef?: MutableRefObject<(() => void) | null> }) {
  const { isAuthenticated } = useAuth();
  const { publicKey, signMessage, signTransaction } = useSolanaWallet();
  const [status, setStatus] = useState<CopyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unfollowTarget, setUnfollowTarget] = useState<string | null>(null);
  const [unfollowing, setUnfollowing] = useState(false);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [expandedLeader, setExpandedLeader] = useState<string | null>(null);
  const { addToast } = useToast();
  const prevTradeCountRef = useRef<number>(0);
  const prevFilledRef = useRef<number>(0);
  const prevFailedRef = useRef<number>(0);

  const fetchStatus = useCallback(async () => {
    if (!isAuthenticated) { setLoading(false); return; }
    try {
      const res = await fetch("/api/copy/status");
      if (!res.ok) { setLoading(false); return; }
      const data = await res.json() as CopyStatus;

      // Detect new trades for toast notifications
      const newTotal = data.stats.totalTrades;
      const prevTotal = prevTradeCountRef.current;
      if (prevTotal > 0 && newTotal > prevTotal) {
        const filledDiff = data.stats.filledTrades - prevFilledRef.current;
        const failedDiff = data.stats.failedTrades - prevFailedRef.current;
        if (filledDiff > 0) {
          addToast({ type: "success", title: "Copy Trade Executed", message: `${filledDiff} new trade(s) filled` });
        }
        if (failedDiff > 0) {
          addToast({ type: "error", title: "Copy Trade Failed", message: `${failedDiff} trade(s) failed` });
        }
      }
      prevTradeCountRef.current = newTotal;
      prevFilledRef.current = data.stats.filledTrades;
      prevFailedRef.current = data.stats.failedTrades;

      setStatus(data);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, addToast]);

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
      const { createNordUserWithSessionKey } = await import("@/lib/n1/user-client");
      const { sessionSecretKey, sessionId } = await createNordUserWithSessionKey({
        walletPubkey: publicKey,
        signMessageFn: signMessage,
        signTransactionFn: signTransaction as (tx: import("@solana/web3.js").Transaction) => Promise<import("@solana/web3.js").Transaction>,
      });

      const res = await fetch("/api/copy/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionSecretKey: bs58.encode(sessionSecretKey),
          sessionId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to activate");
        return;
      }
      await fetchStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Activation failed";
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
      const res = await fetch("/api/copy/activate", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        addToast({ type: "error", title: "Disable Failed", message: data.error ?? "Unknown error" });
        return;
      }
      addToast({ type: "info", title: "Disabled", message: "Copy trading session deactivated" });
      setStatus(null);
      setLoading(true);
      await fetchStatus();
    } catch {
      addToast({ type: "error", title: "Error", message: "Network error" });
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

  const handleUnfollowConfirm = async (closePositions: boolean) => {
    if (!unfollowTarget) return;
    setUnfollowing(true);
    try {
      const params = new URLSearchParams({ leader: unfollowTarget });
      if (closePositions) params.set("closePositions", "true");
      const res = await fetch(`/api/copy/subscribe?${params}`, { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        if (closePositions && data.closeResult) {
          const cr = data.closeResult;
          if (cr.closed > 0) addToast({ type: "success", title: "Positions Closed", message: `${cr.closed} position(s) closed` });
          if (cr.failed > 0) addToast({ type: "error", title: "Close Failed", message: `${cr.failed} position(s) failed to close` });
        }
        addToast({ type: "info", title: "Unfollowed", message: `Stopped copying ${shortenAddr(unfollowTarget)}` });
      }
      await fetchStatus();
    } catch {
      addToast({ type: "error", title: "Error", message: "Failed to unfollow" });
    } finally {
      setUnfollowing(false);
      setUnfollowTarget(null);
    }
  };

  // Computed: summary stats across all leaders
  const totalAllocation = status?.subscriptions.reduce((sum, s) => sum + parseFloat(s.allocationUsdc), 0) ?? 0;
  const activeLeaders = status?.subscriptions.filter((s) => s.active).length ?? 0;

  return (
    <div className="px-3 py-2 space-y-2">
      {/* Not authenticated */}
      {!isAuthenticated && (
        <div className="py-4 text-center text-[10px] text-muted">
          Connect wallet to enable copy trading
        </div>
      )}

      {/* Loading */}
      {isAuthenticated && loading && (
        <div className="flex h-16 items-center justify-center">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
        </div>
      )}

      {/* Not activated */}
      {isAuthenticated && !loading && !status?.sessionActive && (
        <div className="rounded-lg border border-[#262626] bg-[#0a0a0a] p-3 space-y-3">
          <p className="text-[11px] text-[#888] leading-relaxed">
            Enable copy trading to automatically mirror trades from top performers.
          </p>
          {/* Security info */}
          <div className="rounded-lg border border-emerald-500/10 bg-emerald-500/5 p-2.5 space-y-1.5">
            <p className="text-[10px] font-medium text-emerald-400/80 flex items-center gap-1">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              Security Details
            </p>
            <div className="space-y-1 text-[9px] text-[#888] leading-relaxed">
              <p className="flex items-start gap-1.5">
                <span className="text-emerald-500 mt-0.5">✓</span>
                Session key can <strong className="text-[#ccc]">ONLY trade</strong> — cannot withdraw, deposit, or transfer funds
              </p>
              <p className="flex items-start gap-1.5">
                <span className="text-emerald-500 mt-0.5">✓</span>
                Key encrypted with AES-256-GCM before storage
              </p>
              <p className="flex items-start gap-1.5">
                <span className="text-emerald-500 mt-0.5">✓</span>
                Session expires in 30 days — disable anytime
              </p>
              <p className="flex items-start gap-1.5">
                <span className="text-emerald-500 mt-0.5">✓</span>
                All copy trades logged and visible in real-time
              </p>
            </div>
          </div>
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

      {/* Activated — dashboard */}
      {isAuthenticated && !loading && status?.sessionActive && (
        <>
          {/* Session bar */}
          <div className="flex items-center justify-between text-[10px] text-[#666]">
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
              <span>Active until {status.sessionExpires ? new Date(status.sessionExpires).toLocaleDateString() : "—"}</span>
            </div>
            <button onClick={() => setShowDisableConfirm(true)} className="text-red-400/60 hover:text-red-400 transition-colors">
              Disable
            </button>
          </div>

          {/* Multi-leader summary bar */}
          {status.subscriptions.length > 0 && (
            <div className="flex items-center gap-3 rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-[10px]">
              <div className="flex items-center gap-1">
                <span className="text-[#555]">Leaders:</span>
                <span className="text-[#ccc] font-medium">{activeLeaders}/{status.subscriptions.length}</span>
              </div>
              <div className="h-3 w-px bg-[#262626]" />
              <div className="flex items-center gap-1">
                <span className="text-[#555]">Allocated:</span>
                <span className="text-[#ccc] font-medium">${totalAllocation.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
              </div>
              <div className="h-3 w-px bg-[#262626]" />
              <div className="flex items-center gap-1">
                <span className="text-[#555]">Trades:</span>
                <span className="text-[#ccc] font-medium">{status.stats.filledTrades}</span>
              </div>
              {status.stats.todayTrades > 0 && (
                <>
                  <div className="h-3 w-px bg-[#262626]" />
                  <div className="flex items-center gap-1">
                    <span className="text-[#555]">Today:</span>
                    <span className="text-emerald-400 font-medium">{status.stats.todayTrades}</span>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Subscriptions — expandable cards */}
          {status.subscriptions.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#262626] p-3 text-center">
              <p className="text-[11px] text-[#666]">
                No traders followed yet. Click "Copy" on a trader in the Top Traders tab.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {status.subscriptions.map((sub) => (
                <LeaderCard
                  key={sub.id}
                  sub={sub}
                  expanded={expandedLeader === sub.leaderAddr}
                  onToggleExpand={() =>
                    setExpandedLeader((prev) => (prev === sub.leaderAddr ? null : sub.leaderAddr))
                  }
                  onToggleActive={() => handleToggle(sub.id, !sub.active)}
                  onUnfollow={() => setUnfollowTarget(sub.leaderAddr)}
                />
              ))}
            </div>
          )}

          {/* Global stats */}
          {status.stats.totalTrades > 0 && (
            <div className="flex items-center gap-3 text-[10px] text-[#555] pt-1">
              <span>{status.stats.filledTrades} filled</span>
              {status.stats.failedTrades > 0 && (
                <span className="text-red-400/60">{status.stats.failedTrades} failed</span>
              )}
              <span>{status.stats.totalTrades} total</span>
            </div>
          )}

          {/* Activity Log */}
          {status.recentTrades && status.recentTrades.length > 0 && (
            <div className="pt-2">
              <p className="text-[10px] font-medium text-[#888] mb-1.5">Activity Log</p>
              <div className="space-y-1 max-h-[120px] overflow-y-auto">
                {status.recentTrades.map((t, i) => (
                  <div key={i} className={`flex items-center justify-between rounded border px-2 py-1 text-[9px] font-mono ${
                    t.status === "filled"
                      ? "border-emerald-500/10 bg-emerald-500/5"
                      : "border-red-500/10 bg-red-500/5"
                  }`}>
                    <div className="flex items-center gap-1.5">
                      <span className={`h-1 w-1 rounded-full ${t.status === "filled" ? "bg-emerald-500" : "bg-red-500"}`} />
                      <span className={t.side === "Long" ? "text-emerald-400" : "text-red-400"}>{t.side}</span>
                      <span className="text-[#ccc]">{t.symbol}</span>
                      <span className="text-[#666]">{parseFloat(t.size).toFixed(2)}</span>
                      {t.price && <span className="text-[#555]">@${parseFloat(t.price).toLocaleString()}</span>}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {t.status === "failed" && t.error && (
                        <span className="text-red-400/60 max-w-[80px] truncate" title={t.error}>{t.error}</span>
                      )}
                      <span className="text-[#555]">{new Date(t.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Disable confirmation dialog */}
      {showDisableConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowDisableConfirm(false)}>
          <div className="w-full max-w-sm rounded-2xl border border-[#262626] bg-[#0f0f0f] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-white mb-3">Disable Copy Trading</h3>
            <p className="text-xs text-[#888] mb-4">
              This will deactivate your session. The copy engine will stop mirroring trades.
              Your subscriptions will be preserved — you can re-enable anytime.
            </p>
            <div className="space-y-2">
              <button
                onClick={async () => { setShowDisableConfirm(false); await handleDeactivate(); }}
                className="w-full rounded-xl border border-red-500/30 bg-red-500/10 py-2.5 text-xs font-medium text-red-400 hover:bg-red-500/20 transition-colors"
              >
                Disable Copy Trading
              </button>
              <button
                onClick={() => setShowDisableConfirm(false)}
                className="w-full py-2 text-xs text-[#666] hover:text-white transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unfollow confirmation dialog */}
      {unfollowTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => !unfollowing && setUnfollowTarget(null)}>
          <div className="w-full max-w-sm rounded-2xl border border-[#262626] bg-[#0f0f0f] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-white mb-3">Unfollow Trader</h3>
            <p className="text-xs text-[#888] mb-4">
              Do you want to close positions that were copied from this trader?
            </p>
            <div className="space-y-2">
              <button
                onClick={() => handleUnfollowConfirm(true)}
                disabled={unfollowing}
                className="w-full rounded-xl border border-red-500/30 bg-red-500/10 py-2.5 text-xs font-medium text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50"
              >
                {unfollowing ? "Closing..." : "Unfollow & Close Positions"}
              </button>
              <button
                onClick={() => handleUnfollowConfirm(false)}
                disabled={unfollowing}
                className="w-full rounded-xl border border-[#262626] bg-[#141414] py-2.5 text-xs font-medium text-gray-300 hover:bg-[#1a1a1a] transition-colors disabled:opacity-50"
              >
                Unfollow Only (keep positions)
              </button>
              <button
                onClick={() => setUnfollowTarget(null)}
                disabled={unfollowing}
                className="w-full py-2 text-xs text-[#666] hover:text-white transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** @deprecated Use CopyTradeSection instead */
export function CopyTradingPanel() {
  return <CopyTradingContent />;
}
