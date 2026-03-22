"use client";

import { useCallback, useRef } from "react";
import * as Sentry from "@sentry/nextjs";
import { useToast } from "@/components/alerts/ToastProvider";

// Verification schedule: 0–60s every 3s, 60–120s every 10s, 120–300s every 20s
const VERIFY_SCHEDULE: Array<{ until: number; interval: number }> = [
  { until: 60_000, interval: 3_000 },
  { until: 120_000, interval: 10_000 },
  { until: 300_000, interval: 20_000 },
];

function formatUsd(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Background collateral balance verification.
 * Lives at app level (never unmounts), so polling survives modal close.
 * After tx is sent, polls /api/collateral until balance changes → shows toast.
 * Supports multiple concurrent verifications (deposit + withdraw, or rapid deposits).
 */
export function useBackgroundVerification() {
  const { addToast } = useToast();
  const activeCountRef = useRef(0);
  const MAX_CONCURRENT = 3;

  const startVerification = useCallback(
    (action: "deposit" | "withdraw", txAmount: number, balanceBefore: number | null, onSuccess?: () => void) => {
      if (balanceBefore === null) {
        addToast({
          type: "success",
          title: action === "deposit" ? "Deposit sent" : "Withdrawal sent",
          message: `${formatUsd(txAmount)} USDC — transaction submitted`,
          duration: 5000,
        });
        onSuccess?.();
        return;
      }

      // Prevent too many concurrent verification chains
      if (activeCountRef.current >= MAX_CONCURRENT) {
        addToast({
          type: "info",
          title: action === "deposit" ? "Deposit sent" : "Withdrawal sent",
          message: `${formatUsd(txAmount)} USDC — check your portfolio for confirmation`,
          duration: 5000,
        });
        return;
      }
      activeCountRef.current++;
      const startTime = Date.now();
      let stopped = false;

      // Threshold: confirm if balance moved at least 50% of tx amount in the right direction.
      // This accounts for PnL fluctuations on open positions.
      const threshold = txAmount * 0.5;
      const targetBalance = action === "deposit"
        ? balanceBefore + threshold
        : balanceBefore - threshold;

      const getInterval = (elapsed: number): number | null => {
        for (const phase of VERIFY_SCHEDULE) {
          if (elapsed < phase.until) return phase.interval;
        }
        return null;
      };

      const finish = () => {
        if (stopped) return;
        stopped = true;
        activeCountRef.current = Math.max(0, activeCountRef.current - 1);
      };

      const check = async () => {
        if (stopped) return;

        try {
          const res = await fetch("/api/collateral");
          if (res.ok) {
            const data = await res.json();

            // Skip if account doesn't exist yet (first deposit still processing)
            if (data.exists === false) {
              // Don't confirm, don't fail — just keep polling
            } else {
              const balanceAfter: number = data.collateral ?? 0;

              const confirmed = action === "deposit"
                ? balanceAfter >= targetBalance
                : balanceAfter <= targetBalance;

              if (confirmed) {
                finish();
                addToast({
                  type: "success",
                  title: action === "deposit" ? "Deposit confirmed" : "Withdrawal confirmed",
                  message: `${formatUsd(txAmount)} USDC ${action === "deposit" ? "credited" : "withdrawn"}`,
                  duration: 5000,
                });
                try { onSuccess?.(); } catch (cbErr) { console.error("[BackgroundVerification] onSuccess callback error:", cbErr); }
                return;
              }
            }
          }
        } catch {
          // Network hiccup — retry
        }

        const elapsed = Date.now() - startTime;
        const nextInterval = getInterval(elapsed);

        if (nextInterval === null) {
          finish();
          Sentry.captureMessage("Collateral verification timeout", {
            level: "warning",
            extra: { action, txAmount, balanceBefore, elapsedMs: elapsed },
          });
          addToast({
            type: "warning",
            title: "Verification timeout",
            message: "Transaction was sent but balance hasn't updated yet. Check your portfolio.",
            duration: 8000,
          });
          return;
        }

        setTimeout(check, nextInterval);
      };

      // First check after 3s
      setTimeout(check, 3000);
    },
    [addToast]
  );

  return { startVerification };
}
