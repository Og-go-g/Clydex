/**
 * Beta-mode caps for copy trading.
 *
 * Why this exists:
 *   During closed beta we deliberately constrain copy-trading exposure
 *   so a single bug, leader-side mishap, or follower-side
 *   misconfiguration can't drain anyone's wallet. The caps live in one
 *   module (here) so they can be raised/disabled atomically when we're
 *   confident in production.
 *
 * Defaults (closed-beta-safe):
 *   - Max allocation per subscription: $1,000
 *   - Max leverage multiplier:         3×
 *   - Max active subscriptions:        3 per follower
 *
 * Production-mode (post-beta):
 *   Set `COPY_BETA_MODE=false` to lift all caps to the legacy ranges
 *   ($10M / 5× / unlimited). Individual caps can also be tuned via
 *   `MAX_BETA_ALLOCATION_USDC`, `MAX_BETA_LEVERAGE_MULT`,
 *   `MAX_BETA_SUBSCRIPTIONS` without flipping the master switch.
 *
 * Where this is enforced:
 *   - app/api/copy/subscribe/route.ts (POST + PATCH) — primary user-facing gate
 *   - lib/copytrade/signing-policy.ts — defense-in-depth at sign time
 *   - components/copytrade/FollowTraderDialog.tsx — UX hints + input maxes
 *
 * Defaults intentionally bias to MORE restrictive, not less. If env
 * parsing fails or the var is unset, we fall to the safe defaults — a
 * misconfigured server stays in beta-safe mode, never silently opens
 * up.
 */

const DEFAULT_MAX_ALLOCATION_USDC = 1000;
const DEFAULT_MAX_LEVERAGE_MULT = 3;
const DEFAULT_MAX_SUBSCRIPTIONS = 3;

// Pre-beta legacy caps — applied only when COPY_BETA_MODE=false.
const LEGACY_MAX_ALLOCATION_USDC = 10_000_000;
const LEGACY_MAX_LEVERAGE_MULT = 5;
const LEGACY_MAX_SUBSCRIPTIONS = Number.POSITIVE_INFINITY;

/**
 * Read a positive-number env var or fall back. Refuses NaN, zero,
 * negative, and non-finite — those collapse to default so a typo never
 * silently relaxes a cap.
 */
function envPositiveNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function isBetaModeOn(): boolean {
  // Beta defaults ON. Only the literal string "false" disables it —
  // any other value (including "0", "no", typo) keeps beta on, which
  // is the safe side.
  return process.env.COPY_BETA_MODE !== "false";
}

export interface BetaLimits {
  /** True if beta caps apply. False = legacy/production caps. */
  betaMode: boolean;
  /** Per-subscription `allocationUsdc` ceiling. */
  maxAllocationUsdc: number;
  /** Per-subscription `leverageMult` ceiling. */
  maxLeverageMult: number;
  /** Max simultaneous `copy_subscriptions` rows per follower wallet. */
  maxSubscriptions: number;
}

/**
 * Resolve current beta caps from env. Read fresh on every call so
 * tests can stub env between cases — the overhead is a few env reads
 * and is dwarfed by anything that calls this (DB query, network).
 */
export function getBetaLimits(): BetaLimits {
  const betaMode = isBetaModeOn();
  if (!betaMode) {
    return {
      betaMode: false,
      maxAllocationUsdc: LEGACY_MAX_ALLOCATION_USDC,
      maxLeverageMult: LEGACY_MAX_LEVERAGE_MULT,
      maxSubscriptions: LEGACY_MAX_SUBSCRIPTIONS,
    };
  }
  return {
    betaMode: true,
    maxAllocationUsdc: envPositiveNumber(
      "MAX_BETA_ALLOCATION_USDC",
      DEFAULT_MAX_ALLOCATION_USDC,
    ),
    maxLeverageMult: envPositiveNumber(
      "MAX_BETA_LEVERAGE_MULT",
      DEFAULT_MAX_LEVERAGE_MULT,
    ),
    maxSubscriptions: envPositiveNumber(
      "MAX_BETA_SUBSCRIPTIONS",
      DEFAULT_MAX_SUBSCRIPTIONS,
    ),
  };
}

/**
 * Validate user-supplied subscription parameters against current beta
 * caps. Returns null when OK, or a string error suitable for an HTTP
 * 400 response body. The error mentions the actual cap so the user
 * understands what to change.
 *
 * Does NOT validate the universal ranges ($10 floor, etc.) — that
 * stays in the route handler so the messages stay localised to one
 * place. Beta-cap is a separate, narrower gate on top.
 */
export function validateAgainstBetaLimits(params: {
  allocationUsdc: number;
  leverageMult?: number | undefined;
}): string | null {
  const limits = getBetaLimits();
  if (params.allocationUsdc > limits.maxAllocationUsdc) {
    const formatted = limits.betaMode
      ? `$${limits.maxAllocationUsdc.toLocaleString("en-US")}`
      : `$${limits.maxAllocationUsdc}`;
    return `Closed beta limit: allocation cannot exceed ${formatted} per subscription. Caps will rise after beta — see status updates.`;
  }
  if (
    params.leverageMult !== undefined &&
    params.leverageMult > limits.maxLeverageMult
  ) {
    return `Closed beta limit: leverage cannot exceed ${limits.maxLeverageMult}× per subscription. Higher leverage unlocks after the beta period.`;
  }
  return null;
}

/**
 * Counterpart for the "how many active subs" rule. Pass the user's
 * current subscription count BEFORE attempting to create a new one.
 * Returns null if room for one more, or an error string.
 */
export function validateSubscriptionCount(currentCount: number): string | null {
  const { maxSubscriptions, betaMode } = getBetaLimits();
  if (!Number.isFinite(maxSubscriptions)) return null; // legacy mode = unlimited
  if (currentCount >= maxSubscriptions) {
    const verb = betaMode ? "Closed beta limit:" : "Limit:";
    return `${verb} you can follow at most ${maxSubscriptions} traders at a time. Unfollow someone to make room.`;
  }
  return null;
}
