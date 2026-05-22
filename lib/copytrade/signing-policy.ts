/**
 * Per-action signing policy for the copy engine.
 *
 * Background: a copy-trading service that holds AES-encrypted Ed25519
 * session keys server-side faces a real economic-loss threat even when
 * the underlying delegate cannot withdraw on chain — 3Commas (2022)
 * lost ~$22M through stolen API keys that had "trade-only" permissions
 * via self-trade pump-and-dump and slippage drain on illiquid pairs.
 * Drift (April 2026, $285M) underlines what happens when authorization
 * boundaries aren't enforced at sign time.
 *
 * The policy gate is the layer that says: even with a valid session
 * key in hand, the signer refuses any order whose params are outside
 * the user's subscription envelope. It runs in the copy engine right
 * before every placeOrder / closePosition call. Combined with B2's
 * orderbook-anchored slippage clamp and B1's withdraw stress buffer,
 * the gate turns "stolen key → drain" into "stolen key → bounded loss
 * within subscription envelope".
 *
 * IMPORTANT: this is the Week-1 control. Long-term the same policy
 * should run *inside* a TEE (Phala dStack / Nitro Enclave) so a host
 * compromise can't bypass it. Today the policy lives in the same
 * process as the key — full RCE on the worker still bypasses. The
 * gate's value today is:
 *   - defense against bugs and supply-chain attacks that produce
 *     bad order params from inside our own code
 *   - architecture preparation: when we move signing to a TEE, the
 *     policy module moves with it and becomes uncircumventable
 *   - audit trail: refused-by-policy events are explicit, logged,
 *     and actionable
 *
 * 2026-05-22: beta-mode cap layered on top — the gate now also refuses
 * leverage above the current closed-beta ceiling (3× by default; see
 * lib/copytrade/beta-limits.ts). Defense in depth: even if a
 * subscription row carries a higher leverage_mult (legacy data, direct
 * DB mutation, or future code path that skips the route validator),
 * the engine refuses to sign it.
 */

import { getBetaLimits } from "./beta-limits";

export interface SigningPolicyContext {
  /** Wallet address whose session key is about to sign. */
  walletAddr: string;
  /** Market symbol, for logging only. */
  symbol: string;
  /** Numeric market id, for logging only. */
  marketId: number;

  /** Order side as it will be signed. */
  side: "Long" | "Short";

  /** Final base-asset size that will be passed to the SDK. */
  size: number;
  /** Final leverage multiplier that will be passed to the SDK. */
  leverage: number;
  /** Slippage as a fraction (e.g. 0.005 = 0.5%). */
  slippage: number;
  /** Current mark price used to derive USD position value. */
  markPrice: number;

  /** Subscription envelope the user explicitly opted into. */
  subscription: {
    /** USDC the user committed to allocate to this leader. */
    allocationUsdc: number;
    /** Multiplier of leader size the user chose, e.g. 1× / 2× / 5×. */
    leverageMult: number;
    /** Per-market USD cap on a single open position. null = no cap. */
    maxPositionUsdc: number | null;
  };

  /** What the engine intends to do. */
  action: "open" | "increase" | "decrease" | "close" | "flip";
}

export interface PolicyVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Hard limits independent of any user subscription. These cap the
 * absolute worst case the engine can sign even if every subscription
 * cap is bypassed — a defense-in-depth bound.
 */
export const POLICY_LIMITS = {
  /** Highest leverage the engine will ever ask the SDK to sign. */
  MAX_LEVERAGE_HARD: 200,
  /** Slippage parameter cap; matches the ±5% mark-clamp in lib/n1/slippage.ts. */
  MAX_SLIPPAGE_HARD: 0.05,
  /** Anything larger than this is almost certainly a calculation overflow. */
  MAX_BASE_SIZE: 1_000_000_000,
  /** Smaller than this and the order is presumed degenerate / arithmetic dust. */
  MIN_MARK_PRICE: 0.0000001,
  /**
   * 5% slack added to USD caps before refusing. The engine rounds size
   * to 6 decimal places (lib/n1/user-client.ts:placeOrder) so the
   * actual submitted size can be a touch above the engine's pre-round
   * value × markPrice. The slack absorbs that and any markPrice drift
   * between the cap computation and the policy check.
   */
  USDC_CAP_TOLERANCE: 1.05,
} as const;

/**
 * Verify a signing context against the subscription envelope and hard
 * limits. Returns `{ ok: true }` to proceed, or `{ ok: false, reason }`
 * to refuse. The caller (engine) must surface refusals as
 * non-retryable: a refused order is a policy violation, not a transient
 * failure, and re-running with the same inputs will refuse again.
 *
 * Asymmetric rules by action: close/decrease intentionally skip the
 * USD position-size cap because shrinking exposure is always safe
 * relative to the cap. Open/increase/flip enforce the full cap.
 */
export function verifySigningPolicy(ctx: SigningPolicyContext): PolicyVerdict {
  const { side, size, leverage, slippage, markPrice, subscription, action } = ctx;

  // ─── Sanity layer: malformed numeric inputs ────────────────────

  if (!Number.isFinite(markPrice) || markPrice <= POLICY_LIMITS.MIN_MARK_PRICE) {
    return { ok: false, reason: `markPrice invalid: ${markPrice}` };
  }
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, reason: `size invalid: ${size}` };
  }
  if (size > POLICY_LIMITS.MAX_BASE_SIZE) {
    return { ok: false, reason: `size ${size} exceeds absolute max ${POLICY_LIMITS.MAX_BASE_SIZE}` };
  }
  if (side !== "Long" && side !== "Short") {
    return { ok: false, reason: `side invalid: ${String(side)}` };
  }

  // ─── Leverage bounds ────────────────────────────────────────────

  if (!Number.isFinite(leverage) || leverage < 1 || leverage > POLICY_LIMITS.MAX_LEVERAGE_HARD) {
    return {
      ok: false,
      reason: `leverage ${leverage} out of [1, ${POLICY_LIMITS.MAX_LEVERAGE_HARD}]`,
    };
  }
  // Must match the user's chosen multiplier exactly (engine computes
  // size with this same number). 0.01 fuzz absorbs float rounding.
  if (Math.abs(leverage - subscription.leverageMult) > 0.01) {
    return {
      ok: false,
      reason: `signed leverage ${leverage} does not match subscription mult ${subscription.leverageMult}`,
    };
  }

  // Beta-mode cap. The subscribe/PATCH routes already refuse out-of-
  // cap subscriptions, but we re-check at sign time so a row inserted
  // before the cap landed (or any future direct-DB mutation) can't
  // produce a high-leverage signed order. Fail-closed is correct:
  // refusing one order is much cheaper than mis-leveraged execution.
  const betaLimits = getBetaLimits();
  if (leverage > betaLimits.maxLeverageMult + 0.01) {
    return {
      ok: false,
      reason: `leverage ${leverage} exceeds beta-mode cap ${betaLimits.maxLeverageMult}`,
    };
  }

  // ─── Slippage bounds ────────────────────────────────────────────

  if (!Number.isFinite(slippage) || slippage < 0 || slippage > POLICY_LIMITS.MAX_SLIPPAGE_HARD) {
    return {
      ok: false,
      reason: `slippage ${slippage} out of [0, ${POLICY_LIMITS.MAX_SLIPPAGE_HARD}]`,
    };
  }

  // ─── USD position-size caps (open/increase/flip only) ───────────

  if (action === "open" || action === "increase" || action === "flip") {
    const positionUsdc = size * markPrice;
    if (!Number.isFinite(positionUsdc) || positionUsdc < 0) {
      return { ok: false, reason: `positionUsdc invalid: ${positionUsdc}` };
    }

    // Per-market cap explicitly set by user.
    if (
      subscription.maxPositionUsdc != null &&
      Number.isFinite(subscription.maxPositionUsdc) &&
      subscription.maxPositionUsdc > 0
    ) {
      const cap = subscription.maxPositionUsdc * POLICY_LIMITS.USDC_CAP_TOLERANCE;
      if (positionUsdc > cap) {
        return {
          ok: false,
          reason: `position $${positionUsdc.toFixed(2)} > subscription maxPositionUsdc $${subscription.maxPositionUsdc} (+5% slack)`,
        };
      }
    }

    // Hard cap from allocation × leverage — the highest notional the
    // engine math could legitimately produce. Catches arithmetic bugs
    // and amplified-input attacks even when the user didn't set a
    // per-market cap.
    if (
      Number.isFinite(subscription.allocationUsdc) &&
      subscription.allocationUsdc > 0 &&
      Number.isFinite(subscription.leverageMult) &&
      subscription.leverageMult > 0
    ) {
      const allocCap =
        subscription.allocationUsdc *
        subscription.leverageMult *
        POLICY_LIMITS.USDC_CAP_TOLERANCE;
      if (positionUsdc > allocCap) {
        return {
          ok: false,
          reason: `position $${positionUsdc.toFixed(2)} > allocation × mult cap $${allocCap.toFixed(2)}`,
        };
      }
    }
  }

  return { ok: true };
}
