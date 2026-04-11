"use client";

import { useState, useCallback, useRef } from "react";
import { useAuth } from "@/lib/auth/context";
import { CopyTradingContent } from "./CopyTradingPanel";
import { LeaderboardContent } from "./CompactLeaderboard";
import { FollowTraderDialog } from "./FollowTraderDialog";
import type { LeaderboardEntry } from "./CompactLeaderboard";

type Tab = "leaderboard" | "copy";

export function CopyTradeSection() {
  const { isAuthenticated } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>("copy");
  const [copyTrader, setCopyTrader] = useState<LeaderboardEntry | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);

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
