"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth/context";
import { CopyTradingContent } from "./CopyTradingPanel";
import { LeaderboardContent } from "./CompactLeaderboard";
import { FollowTraderDialog } from "./FollowTraderDialog";
import { CopyHistoryTab } from "./CopyHistoryTab";
import type { LeaderboardEntry } from "./CompactLeaderboard";

type Tab = "leaderboard" | "copy" | "history";

// ─── Module-level opener ────────────────────────────────────────
//
// Lets nested components anywhere in the tree (notably the chat-
// mode Trader Profile / Suggest / Compare cards) open the
// FollowTraderDialog with a specific trader without prop-drilling
// through ChartPanel → CopyTradeSection. CopyTradeSection mounts
// once per page; the global setter is set on mount, cleared on
// unmount. Mirrors the same pattern used for openCloseModalFn.

let openFollowFn: ((t: LeaderboardEntry) => void) | null = null;

export function openFollowTraderDialog(t: LeaderboardEntry) {
  openFollowFn?.(t);
}

export function CopyTradeSection() {
  const { isAuthenticated } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>("copy");
  const [copyTrader, setCopyTrader] = useState<LeaderboardEntry | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);

  // Register module-level opener so the chat-cards module can pop
  // this dialog without needing a ref or prop chain.
  useEffect(() => {
    openFollowFn = (t) => setCopyTrader(t);
    return () => { openFollowFn = null; };
  }, []);

  const handleCopyTrader = useCallback((entry: LeaderboardEntry) => {
    setCopyTrader(entry);
  }, []);

  const handleDialogSuccess = useCallback(() => {
    setCopyTrader(null);
    setActiveTab("copy");
    // Trigger refresh on CopyTradingContent
    refreshRef.current?.();
  }, []);

  const handleDialogClose = useCallback(() => {
    setCopyTrader(null);
  }, []);

  const tabs: { key: Tab; label: string }[] = [
    { key: "copy", label: "Copy Trading" },
    { key: "leaderboard", label: "Top Traders" },
    { key: "history", label: "History" },
  ];

  return (
    <div className="border-t border-[#262626] flex flex-col flex-1 min-h-0">
      {/* Tab bar */}
      <div className="flex items-center gap-0 border-b border-[#262626] px-3">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`relative whitespace-nowrap px-3 py-2 text-[11px] font-semibold transition-colors -mb-px ${
              activeTab === t.key
                ? "text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-[2px] after:bg-gradient-to-r after:from-emerald-400 after:to-emerald-400/10 after:animate-[tab-fill_0.3s_ease-out]"
                : "text-muted hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeTab === "leaderboard" && <LeaderboardContent onCopyTrader={handleCopyTrader} />}
        {activeTab === "copy" && <CopyTradingContent onRefreshRef={refreshRef} />}
        {activeTab === "history" && <CopyHistoryTab />}
      </div>

      {/* Follow Trader Dialog */}
      {copyTrader && (
        <FollowTraderDialog
          isOpen={true}
          onClose={handleDialogClose}
          onSuccess={handleDialogSuccess}
          trader={copyTrader}
        />
      )}
    </div>
  );
}
