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
  maxTotalPositionUsdc: string | null;
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

/**
 * Broadcast a request for the leaderboard to search for this address.
 * CompactLeaderboard listens for it, fills its search input, and runs
 * the query. Decoupled via window event so the two panels don't need
 * to share state or context.
 */
export const LEADERBOARD_SEARCH_EVENT = "clydex:leaderboard-search";

function broadcastLeaderboardSearch(addr: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(LEADERBOARD_SEARCH_EVENT, { detail: addr }));
  // Scroll the user to the leaderboard so they see the result
  const el = document.querySelector("[data-leaderboard-root]");
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ─── Sort ──────────────────────────────────────────────────────

type SortMode = "default" | "allocation" | "trades" | "volume";

const SORT_LABELS: Record<SortMode, string> = {
  default: "Default",
  allocation: "Allocation",
  trades: "Trades",
  volume: "Volume",
};

function sortSubscriptions(
  subs: CopySubscriptionUI[],
  mode: SortMode,
): CopySubscriptionUI[] {
  if (mode === "default") return subs;
  // Don't mutate — caller may have memoized reference equality
  const copy = [...subs];
  switch (mode) {
    case "allocation":
      copy.sort((a, b) => parseFloat(b.allocationUsdc) - parseFloat(a.allocationUsdc));
      break;
    case "trades":
      copy.sort((a, b) => b.stats.filledTrades - a.stats.filledTrades);
      break;
    case "volume":
      copy.sort((a, b) => b.stats.totalVolume - a.stats.totalVolume);
      break;
  }
  return copy;
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
  onSaveSettings,
  onAddrClick,
}: {
  sub: CopySubscriptionUI;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleActive: () => void;
  onUnfollow: () => void;
  onSaveSettings: (id: string, settings: Record<string, unknown>) => Promise<void>;
  onAddrClick: (addr: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editAlloc, setEditAlloc] = useState("");
  const [editLev, setEditLev] = useState(1);
  const [editMaxPos, setEditMaxPos] = useState("");
  const [editMaxTotal, setEditMaxTotal] = useState("");
  const [editSL, setEditSL] = useState("");

  const startEdit = () => {
    setEditAlloc(parseFloat(sub.allocationUsdc).toFixed(0));
    setEditLev(parseFloat(sub.leverageMult));
    setEditMaxPos(sub.maxPositionUsdc ? parseFloat(sub.maxPositionUsdc).toFixed(0) : "");
    setEditMaxTotal(sub.maxTotalPositionUsdc ? parseFloat(sub.maxTotalPositionUsdc).toFixed(0) : "");
    setEditSL(sub.stopLossPct ?? "");
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSaveSettings(sub.id, {
        allocationUsdc: parseFloat(editAlloc) || undefined,
        leverageMult: editLev,
        maxPositionUsdc: editMaxPos ? parseFloat(editMaxPos) : null,
        maxTotalPositionUsdc: editMaxTotal ? parseFloat(editMaxTotal) : null,
        stopLossPct: editSL ? parseFloat(editSL) : null,
      });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const inputCls = "w-full rounded border border-[#333] bg-[#111] px-1.5 py-1 text-[10px] font-mono text-[#ccc] outline-none focus:border-emerald-500/40";

  return (
    <div className="rounded-lg border border-[#262626] bg-[#0a0a0a] overflow-hidden transition-all">
      {/* Collapsed row */}
      <button
        onClick={onToggleExpand}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-[#111] transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${sub.active ? "bg-green-500" : "bg-[#555]"}`} />
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onAddrClick(sub.leaderAddr);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onAddrClick(sub.leaderAddr);
              }
            }}
            title="View leader profile"
            className="text-xs font-mono text-[#ccc] hover:text-emerald-400 transition-colors cursor-pointer underline-offset-2 hover:underline"
          >
            {shortenAddr(sub.leaderAddr)}
          </span>
          <span className="text-[10px] text-[#666]">${parseFloat(sub.allocationUsdc).toFixed(0)}</span>
          <span className="text-[10px] text-[#555]">{sub.leverageMult}x</span>
        </div>
        <div className="flex items-center gap-2">
          {sub.stats.filledTrades > 0 && (
            <span className="text-[10px] font-mono text-[#888]">
              Vol {fmtUsd(sub.stats.totalVolume)}
            </span>
          )}
          <span className="text-[10px] text-[#555]">{sub.stats.filledTrades} trades</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={`text-[#555] transition-transform ${expanded ? "rotate-180" : ""}`}>
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
              <p className="text-[11px] font-mono text-[#ccc]">{fmtUsd(sub.stats.totalVolume)}</p>
            </div>
          </div>

          {/* Settings — read-only or edit mode */}
          {!editing ? (
            <>
              <div className="flex items-center justify-between">
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-[#666]">
                  <span>Allocation: <strong className="text-[#999]">${parseFloat(sub.allocationUsdc).toFixed(0)}</strong></span>
                  <span>Leverage: <strong className="text-[#999]">{sub.leverageMult}x</strong></span>
                  {sub.maxPositionUsdc && (
                    <span>Max/mkt: <strong className="text-[#999]">${parseFloat(sub.maxPositionUsdc).toFixed(0)}</strong></span>
                  )}
                  {sub.maxTotalPositionUsdc && (
                    <span>Max total: <strong className="text-[#999]">${parseFloat(sub.maxTotalPositionUsdc).toFixed(0)}</strong></span>
                  )}
                  {sub.stopLossPct && (
                    <span>SL: <strong className="text-[#999]">{sub.stopLossPct}%</strong></span>
                  )}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); startEdit(); }}
                  className="text-[9px] text-emerald-400/60 hover:text-emerald-400 transition-colors"
                >
                  Edit
                </button>
              </div>
            </>
          ) : (
            <div className="space-y-1.5 rounded border border-emerald-500/10 bg-emerald-500/5 p-2">
              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <label className="text-[8px] text-[#666]">Allocation ($)</label>
                  <input type="text" inputMode="decimal" value={editAlloc}
                    onChange={(e) => /^\d*$/.test(e.target.value) && setEditAlloc(e.target.value)}
                    className={inputCls} />
                </div>
                <div>
                  <label className="text-[8px] text-[#666]">Leverage</label>
                  <div className="flex gap-1">
                    {[1, 2, 3, 5].map((v) => (
                      <button key={v} onClick={() => setEditLev(v)}
                        className={`flex-1 rounded border py-0.5 text-[9px] font-medium transition-colors ${
                          editLev === v ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400" : "border-[#333] text-[#666] hover:text-[#999]"
                        }`}>
                        {v}x
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                <div>
                  <label className="text-[8px] text-[#666]">Max/market ($)</label>
                  <input type="text" inputMode="decimal" value={editMaxPos} placeholder="No limit"
                    onChange={(e) => /^\d*$/.test(e.target.value) && setEditMaxPos(e.target.value)}
                    className={inputCls} />
                </div>
                <div>
                  <label className="text-[8px] text-[#666]">Max total ($)</label>
                  <input type="text" inputMode="decimal" value={editMaxTotal} placeholder="No limit"
                    onChange={(e) => /^\d*$/.test(e.target.value) && setEditMaxTotal(e.target.value)}
                    className={inputCls} />
                </div>
                <div>
                  <label className="text-[8px] text-[#666]">Stop loss (%)</label>
                  <input type="text" inputMode="decimal" value={editSL} placeholder="None"
                    onChange={(e) => /^\d*\.?\d?$/.test(e.target.value) && setEditSL(e.target.value)}
                    className={inputCls} />
                </div>
              </div>
              <div className="flex gap-1.5 pt-0.5">
                <button onClick={() => setEditing(false)} disabled={saving}
                  className="flex-1 rounded py-1 text-[9px] text-[#666] hover:text-[#999] transition-colors border border-[#333]">
                  Cancel
                </button>
                <button onClick={handleSave} disabled={saving}
                  className="flex-1 rounded py-1 text-[9px] font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 transition-colors disabled:opacity-50">
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          )}

          {/* Recent trades */}
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
              }`}>
              {sub.active ? "Pause" : "Resume"}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onUnfollow(); }}
              className="flex-1 rounded-lg py-1.5 text-[10px] font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors">
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
  const [engineHealth, setEngineHealth] = useState<{
    isHealthy: boolean;
    lastRunAgoSec: number | null;
  } | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("default");
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

  // Engine health — polled while session is active with subscriptions,
  // because only then does engine downtime actually affect the user.
  useEffect(() => {
    if (!isAuthenticated || !status?.sessionActive) return;
    if ((status?.subscriptions?.length ?? 0) === 0) return;

    let cancelled = false;
    const fetchHealth = async () => {
      try {
        const res = await fetch("/api/copy/health", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setEngineHealth({
            isHealthy: Boolean(data.isHealthy),
            lastRunAgoSec: data.lastRunAgoSec ?? null,
          });
        }
      } catch {
        // Network hiccup — keep last state, don't blink the banner
      }
    };
    fetchHealth();
    const id = setInterval(fetchHealth, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isAuthenticated, status?.sessionActive, status?.subscriptions?.length]);

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

  const handleSaveSettings = async (subId: string, settings: Record<string, unknown>) => {
    try {
      const res = await fetch("/api/copy/subscribe", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: subId, ...settings }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        addToast({ type: "error", title: "Save Failed", message: data.error ?? "Unknown error" });
        return;
      }
      addToast({ type: "success", title: "Settings Saved", message: "Subscription updated" });
      await fetchStatus();
    } catch {
      addToast({ type: "error", title: "Error", message: "Network error" });
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

  // Session expiry countdown
  const daysUntilExpiry = status?.sessionExpires
    ? Math.max(
        0,
        Math.ceil(
          (new Date(status.sessionExpires).getTime() - Date.now()) /
            (24 * 60 * 60 * 1000),
        ),
      )
    : null;
  const expiringSoon = daysUntilExpiry !== null && daysUntilExpiry <= 3;

  // Sorted leaders — controlled by sortMode state declared below
  const sortedSubscriptions = status?.subscriptions
    ? sortSubscriptions(status.subscriptions, sortMode)
    : [];

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

          {/* Engine health banner — shown only when something is wrong so UI stays quiet in the happy path */}
          {engineHealth && !engineHealth.isHealthy && status.subscriptions.length > 0 && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[10px] text-red-300 leading-relaxed">
              <div className="flex items-center gap-1.5 font-medium">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 9v4M12 17h.01M10.29 3.86l-8.14 14a2 2 0 001.71 3h16.28a2 2 0 001.71-3l-8.14-14a2 2 0 00-3.42 0z" />
                </svg>
                Copy engine delayed
              </div>
              <div className="mt-0.5 text-[#a66]">
                Last cycle{" "}
                {engineHealth.lastRunAgoSec !== null
                  ? `${engineHealth.lastRunAgoSec}s ago`
                  : "never"}
                {" "}— your leaders&apos; trades may not be mirrored right now. We&apos;re auto-retrying.
              </div>
            </div>
          )}

          {/* Session expiry warning — only when ≤3 days left. Renew re-runs the same
              activation flow, which upserts the session (old one is replaced). */}
          {expiringSoon && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[10px] text-amber-200">
              <div className="flex items-center gap-1.5">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <span className="font-medium">
                  Session expires in {daysUntilExpiry === 0 ? "<1 day" : `${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}`}
                </span>
              </div>
              <button
                onClick={handleActivate}
                disabled={activating}
                className="shrink-0 rounded-md bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-200 hover:bg-amber-500/30 transition-colors disabled:opacity-50"
              >
                {activating ? "Renewing..." : "Renew"}
              </button>
            </div>
          )}

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
              {/* Sort control — hidden for ≤1 leader (nothing to sort) */}
              {status.subscriptions.length > 1 && (
                <div className="flex items-center justify-end gap-1 text-[9px] text-[#666]">
                  <span>Sort:</span>
                  <select
                    value={sortMode}
                    onChange={(e) => setSortMode(e.target.value as SortMode)}
                    className="rounded border border-[#262626] bg-[#0a0a0a] px-1.5 py-0.5 text-[10px] text-[#ccc] outline-none focus:border-emerald-500/40"
                  >
                    {(Object.keys(SORT_LABELS) as SortMode[]).map((m) => (
                      <option key={m} value={m}>{SORT_LABELS[m]}</option>
                    ))}
                  </select>
                </div>
              )}
              {sortedSubscriptions.map((sub) => (
                <LeaderCard
                  key={sub.id}
                  sub={sub}
                  expanded={expandedLeader === sub.leaderAddr}
                  onToggleExpand={() =>
                    setExpandedLeader((prev) => (prev === sub.leaderAddr ? null : sub.leaderAddr))
                  }
                  onToggleActive={() => handleToggle(sub.id, !sub.active)}
                  onUnfollow={() => setUnfollowTarget(sub.leaderAddr)}
                  onSaveSettings={handleSaveSettings}
                  onAddrClick={broadcastLeaderboardSearch}
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
