import type { AccountMarginsView } from "@n1xyz/nord-ts";

// ─── Alert Types ─────────────────────────────────────────────────

export type AlertLevel = "warning" | "critical" | "emergency";

export interface LiquidationAlert {
  level: AlertLevel;
  marginRatio: number;
  message: string;
  timestamp: number;
}

// ─── Thresholds ──────────────────────────────────────────────────
// Margin ratio = omf / pon (higher = healthier)
// When omf/pon drops below mmf/pon, positions get liquidated

const THRESHOLDS: Record<AlertLevel, number> = {
  warning: 0.15,    // 15% — approaching danger
  critical: 0.10,   // 10% — high risk of liquidation
  emergency: 0.05,  // 5% — imminent liquidation
};

// ─── Check Functions ─────────────────────────────────────────────

/**
 * Evaluate account margins and return an alert if the account is at risk.
 * Returns null if the account is healthy.
 */
export function checkLiquidationRisk(margins: AccountMarginsView): LiquidationAlert | null {
  // If no open positions (pon = 0), no risk
  if (!margins.pon || margins.pon === 0) return null;

  // If already bankrupt
  if (margins.bankruptcy) {
    return {
      level: "emergency",
      marginRatio: 0,
      message: "Account is bankrupt. Positions may be liquidated immediately.",
      timestamp: Date.now(),
    };
  }

  // Margin ratio: omf / pon
  const marginRatio = margins.omf / margins.pon;

  if (marginRatio <= THRESHOLDS.emergency) {
    return {
      level: "emergency",
      marginRatio,
      message: `EMERGENCY: Margin ratio at ${(marginRatio * 100).toFixed(1)}%. Liquidation is imminent. Add collateral or close positions now.`,
      timestamp: Date.now(),
    };
  }

  if (marginRatio <= THRESHOLDS.critical) {
    return {
      level: "critical",
      marginRatio,
      message: `CRITICAL: Margin ratio at ${(marginRatio * 100).toFixed(1)}%. High risk of liquidation. Consider adding collateral.`,
      timestamp: Date.now(),
    };
  }

  if (marginRatio <= THRESHOLDS.warning) {
    return {
      level: "warning",
      marginRatio,
      message: `Warning: Margin ratio at ${(marginRatio * 100).toFixed(1)}%. Approaching liquidation zone.`,
      timestamp: Date.now(),
    };
  }

  return null;
}

/**
 * Get the display color class for an alert level.
 */
export function getAlertColor(level: AlertLevel): string {
  switch (level) {
    case "warning": return "text-yellow-400 border-yellow-500/30 bg-yellow-500/10";
    case "critical": return "text-orange-400 border-orange-500/30 bg-orange-500/10";
    case "emergency": return "text-red-400 border-red-500/30 bg-red-500/10";
  }
}
