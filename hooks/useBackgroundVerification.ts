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

      // Threshold: require balance to have moved by at least 95% of the tx
      // amount in the correct direction. The previous 50% allowed a single
      // PnL swing (e.g. +$51 on a leveraged position) to false-confirm a
      // $100 deposit before the on-chain deposit had actually landed —
      // and the opposite for withdrawals. 95% means PnL would need to
      // exceed 5% × txAmount in the correct direction, which is much rarer
      // and far less likely to coincide with an actual confirmation.
      const threshold = txAmount * 0.95;
      const targetBalance = action === "deposit"
        ? balanceBefore + threshold
        : balanceBefore - threshold;
      // Require two consecutive confirming polls. Deposits/withdrawals are
      // monotonic at the engine level — once they land, balance stays put
      // (modulo small PnL ticks well under the 5% buffer). PnL alone is
      // oscillatory: a single +$51 swing can revert to -$10 on the next
      // poll. Two-in-a-row collapses that false-positive surface.
      let consecutiveConfirms = 0;
      const REQUIRED_CONFIRMS = 2;

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
              consecutiveConfirms = 0;
            } else {
              const balanceAfter: number = data.collateral ?? 0;

              const polledConfirm = action === "deposit"
                ? balanceAfter >= targetBalance
                : balanceAfter <= targetBalance;

              if (polledConfirm) {
                consecutiveConfirms++;
              } else {
                consecutiveConfirms = 0;
              }

              if (consecutiveConfirms >= REQUIRED_CONFIRMS) {
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
          // Network hiccup — retry. Don't reset consecutiveConfirms — a
          // transient network blip between two real confirmations
          // shouldn't force us back to zero.
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
