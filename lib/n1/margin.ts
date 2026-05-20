import type { AccountMarginsView } from "@n1xyz/nord-ts";

/**
 * Margin-math helpers aligned with the 01 / Nord protocol model documented
 * at https://docs.01.xyz/margins/n1. All numeric fields on
 * `AccountMarginsView` are USD numerators that translate to ratios when
 * divided by `pon` (or `pn` for `mf`). The reference formulas:
 *
 *   AV (Account Value)  = Σ unrealized_PnL + Σ tokens × weight × p_low
 *                                                      (or p_high for debts)
 *   TV (Token Value)    = collateral only, no PnL
 *
 *   omf (API field) = min(AV, TV)       ← numerator of OMF ratio
 *   mf  (API field) = AV                 ← numerator of MF ratio
 *   imf (API field) = Σ(PON × IMF_base)  ← order-placement threshold
 *   mmf (API field) = Σ(PON × MMF_base)  ← liquidation threshold
 *   pon (API field) = Σ PON              ← positions + open-order notional
 *
 * Protocol enforces `min(AV, TV) ≥ Σ(PON × IMF_base)` for placing orders
 * AND for withdraws. Liquidation triggers when `AV < Σ(PON × MMF_base)`.
 */

/**
 * Post-withdraw margin floor as a fraction of total notional (PON).
 *
 * Audit C1 acceptance criterion: a user with open positions cannot
 * withdraw an amount that would push post-trade margin ratio below 15%
 * on any single position. In cross-margin, this collapses to the
 * aggregate `mf / pon` ratio. 15% sits ~10 percentage points above the
 * typical perp MMF_base (= 0.5 × IMF_base ≈ 5% for a 10× market),
 * giving a buffer that absorbs a meaningful adverse tick before the
 * account hits liquidation.
 *
 * Tunable: lower → friendlier UX, less safety; higher → stricter.
 */
export const POST_WITHDRAW_MARGIN_FLOOR = 0.15;

/**
 * Maximum USD amount the account can withdraw without pushing into the
 * danger zone. Returns 0 for bankrupt accounts; returns the full
 * collateral when there are no open positions or open orders (pon = 0).
 *
 * Two binding constraints, take the tightest:
 *
 *  - protocolBound = omf − imf
 *    The protocol itself enforces `min(AV, TV) − X ≥ Σ(PON × IMF_base)`
 *    after a withdraw of size X. Since `omf` is `min(AV, TV)` it caps
 *    at TV when AV > TV (positive PnL doesn't help bypass this).
 *
 *  - safetyBound = mf − POST_WITHDRAW_MARGIN_FLOOR × pon
 *    Our added pad. After withdraw, post-`mf` = `mf − X`. We require
 *    post-`mf / pon ≥ POST_WITHDRAW_MARGIN_FLOOR` so an adverse tick
 *    doesn't immediately push us through MMF. `mf` includes positive
 *    PnL, but the floor `0.15 × pon` is PnL-invariant — paper profit
 *    cannot be withdrawn while it's still paper.
 *
 * Returning the min of these two clamped at 0 covers every case:
 *   - low-leverage market: protocolBound dominates (IMF base > 15%)
 *   - high-leverage market: safetyBound dominates (IMF base < 15%)
 *   - paper PnL: omf = TV caps protocolBound; safetyBound stays tight
 */
export function computeMaxWithdraw(
  margins: Pick<AccountMarginsView, "omf" | "mf" | "imf" | "pon" | "bankruptcy">,
): number {
  if (margins.bankruptcy) return 0;
  if (!margins.pon || margins.pon <= 0) {
    return Math.max(0, margins.omf ?? 0);
  }

  const protocolBound = (margins.omf ?? 0) - (margins.imf ?? 0);
  const safetyBound = (margins.mf ?? 0) - POST_WITHDRAW_MARGIN_FLOOR * margins.pon;

  return Math.max(0, Math.min(protocolBound, safetyBound));
}
