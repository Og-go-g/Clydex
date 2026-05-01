"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/lib/auth/context";
import { useNordAccount } from "@/hooks/useNordAccount";
import { isNordWsEnabledForSession } from "@/lib/feature-flags";
import type { AlertLevel } from "@/lib/n1/alerts";

interface LiquidationAlert {
  level: AlertLevel;
  marginRatio: number;
  message: string;
}

const LEVEL_STYLES: Record<AlertLevel, { bg: string; border: string; text: string; pulse: string }> = {
  warning: {
    bg: "bg-yellow-500/10",
    border: "border-yellow-500/40",
    text: "text-yellow-400",
    pulse: "",
  },
  critical: {
    bg: "bg-orange-500/15",
    border: "border-orange-500/50",
    text: "text-orange-400",
    pulse: "animate-pulse",
  },
  emergency: {
    bg: "bg-red-500/20",
    border: "border-red-500/60",
    text: "text-red-400",
    pulse: "animate-pulse",
  },
};

/**
 * LiquidationWarning — polls account margins and shows a persistent
 * banner when the account is at risk. Emergency level shows a
 * full-screen overlay that must be actively dismissed.
 */
export function LiquidationWarning() {
  const { isAuthenticated } = useAuth();
  const [alert, setAlert] = useState<LiquidationAlert | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [emergencyDismissed, setEmergencyDismissed] = useState(false);
  // Track which position set was dismissed — only re-show if positions change
  const dismissedForRef = useRef<string | null>(null);
  // Fingerprint of current positions for dismiss tracking
  const currentFingerprintRef = useRef<string | null>(null);

  // Phase 5: WS feature flag. Same convention as the rest of the app —
  // resolve in a useEffect (not in render) so SSR/hydration stays stable.
  const [wsEnabled, setWsEnabled] = useState(false);
  useEffect(() => {
    setWsEnabled(isNordWsEnabledForSession());
  }, []);

  // accountId is plucked off the first /api/collateral response (the
  // endpoint already returns it — no separate session call). Used to
  // wire the useNordAccount subscription below.
  const [accountId, setAccountId] = useState<number | null>(null);

  // Stable handle so the WS-driven debounced refetch can call back into
  // the latest closure of `checkMargins` without forcing the outer
  // effect to re-run on every render.
  const checkMarginsRef = useRef<(() => Promise<void>) | null>(null);

  // 1s debounce on WS-event-driven refetches. Margin checks are heavier
  // than account refetches (full collateral aggregate + ratio compute),
  // and bursts of fills/cancels rarely change the ratio meaningfully —
  // a 1s window collapses them into a single check.
  const debouncedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleWsAccountUpdate = useCallback(() => {
    if (debouncedTimerRef.current) clearTimeout(debouncedTimerRef.current);
    debouncedTimerRef.current = setTimeout(() => {
      debouncedTimerRef.current = null;
      void checkMarginsRef.current?.();
    }, 1000);
  }, []);
  useNordAccount(accountId, handleWsAccountUpdate, { enabled: wsEnabled });

  // Margin check: WS-driven via useNordAccount when the flag is on,
  // 15s setInterval when off. Initial fetch runs in both modes so the
  // banner can show immediately on mount and seed accountId.
  useEffect(() => {
    if (!isAuthenticated) {
      setAlert(null);
      return;
    }

    async function checkMargins() {
      // Skip fetch if already dismissed for current positions
      if (dismissedForRef.current) return;
      try {
        const res = await fetch("/api/collateral");
        if (!res.ok) return;
        const data = await res.json();

        if (typeof data.accountId === "number" && data.accountId > 0) {
          setAccountId((prev) => (prev === data.accountId ? prev : data.accountId));
        }

        if (!data.exists || !data.marginRatio) {
          setAlert(null);
          dismissedForRef.current = null;
          return;
        }

        // Fingerprint of current positions — if positions change, re-show alert
        const posFingerprint = JSON.stringify(
          ((data.positions as Array<{ symbol: string; side: string }>) ?? [])
            .map(p => `${p.symbol}_${p.side}`).sort()
        );
        currentFingerprintRef.current = posFingerprint;

        const ratio = data.marginRatio as number;
        if (!isFinite(ratio) || ratio <= 0) {
          setAlert(null);
          return;
        }

        if (ratio <= 0.05) {
          // Emergency: only re-show if positions changed since last dismiss
          if (dismissedForRef.current === posFingerprint) return;
          setAlert({
            level: "emergency",
            marginRatio: ratio,
            message: `EMERGENCY: Margin ratio at ${(ratio * 100).toFixed(1)}%. Liquidation is imminent. Add collateral or close positions NOW.`,
          });
        } else if (ratio <= 0.10) {
          if (dismissedForRef.current === posFingerprint) return;
          setAlert({
            level: "critical",
            marginRatio: ratio,
            message: `CRITICAL: Margin ratio at ${(ratio * 100).toFixed(1)}%. High risk of liquidation. Consider adding collateral.`,
          });
        } else if (ratio <= 0.15) {
          if (dismissedForRef.current === posFingerprint) return;
          setAlert({
            level: "warning",
            marginRatio: ratio,
            message: `Warning: Margin ratio at ${(ratio * 100).toFixed(1)}%. Approaching liquidation zone.`,
          });
        } else {
          setAlert(null);
          dismissedForRef.current = null; // Reset when safe — new risky position will trigger fresh alert
        }
      } catch {
        // Non-critical — silently fail
      }
    }

    checkMarginsRef.current = checkMargins;
    checkMargins();
    // Legacy 15s polling only when WS path is disabled. WS mode drives
    // refetches through useNordAccount above (1s debounced).
    let interval: number | null = null;
    if (!wsEnabled) {
      interval = window.setInterval(checkMargins, 15_000);
    }
    return () => {
      checkMarginsRef.current = null;
      if (interval !== null) clearInterval(interval);
      if (debouncedTimerRef.current) {
        clearTimeout(debouncedTimerRef.current);
        debouncedTimerRef.current = null;
      }
    };
  }, [isAuthenticated, wsEnabled]);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    setAlert(null);
    dismissedForRef.current = currentFingerprintRef.current;
  }, []);

  const handleEmergencyDismiss = useCallback(() => {
    setEmergencyDismissed(true);
    setAlert(null);
    dismissedForRef.current = currentFingerprintRef.current;
  }, []);

  if (!alert) return null;

  const styles = LEVEL_STYLES[alert.level];

  // Emergency: full-screen overlay
  if (alert.level === "emergency" && !emergencyDismissed) {
    return (
      <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm">
        <div className={`mx-4 max-w-md rounded-2xl border-2 ${styles.border} ${styles.bg} p-8 text-center shadow-2xl`}>
          <div className={`mb-4 text-5xl ${styles.pulse}`}>
            <svg className="mx-auto h-16 w-16 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 9v4m0 4h.01M12 3l9.5 16.5H2.5L12 3z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h2 className="mb-2 text-xl font-bold text-red-400">LIQUIDATION IMMINENT</h2>
          <p className="mb-2 text-sm text-gray-300">{alert.message}</p>
          <div className="mb-6 rounded-lg bg-red-500/20 p-3">
            <div className="text-xs text-gray-400">Margin Ratio</div>
            <div className="text-2xl font-bold font-mono text-red-400">
              {(alert.marginRatio * 100).toFixed(1)}%
            </div>
          </div>
          <div className="flex gap-3">
            <a
              href="/portfolio"
              className="flex-1 rounded-xl bg-red-500 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-600"
            >
              Manage Positions
            </a>
            <button
              onClick={handleEmergencyDismiss}
              className="rounded-xl border border-gray-600 px-4 py-3 text-sm text-gray-400 transition-colors hover:bg-gray-800"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Warning/Critical: top banner
  if (dismissed) return null;

  return (
    <div
      className={`sticky top-16 z-40 border-b ${styles.border} ${styles.bg} ${styles.pulse}`}
      role="alert"
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-2.5">
        <div className="flex items-center gap-2">
          <svg className={`h-4 w-4 ${styles.text}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 9v4m0 4h.01M12 3l9.5 16.5H2.5L12 3z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className={`text-sm font-medium ${styles.text}`}>{alert.message}</span>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/portfolio"
            className={`rounded-lg px-3 py-1 text-xs font-medium ${styles.text} border ${styles.border} transition-colors hover:bg-white/5`}
          >
            Manage
          </a>
          <button
            onClick={handleDismiss}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:text-foreground transition-colors"
            aria-label="Dismiss warning"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
