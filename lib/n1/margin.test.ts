/**
 * computeMaxWithdraw — covers every meaningful branch of the audit C1
 * fix. The scenarios trace through the official 01 / Nord margin model
 * (https://docs.01.xyz/margins/n1) so we can defend the formula even
 * when only some of the binding constraints are tight.
 *
 * Variables follow the N1 OpenAPI naming exactly:
 *   omf = min(AV, TV)             — protocol bound's numerator
 *   mf  = AV                      — safety bound's numerator
 *   imf = Σ(PON × IMF_base)       — protocol IMF threshold
 *   pon = Σ PON                   — aggregate notional
 *   bankruptcy = boolean
 */

import { describe, it, expect } from "vitest";
import { computeMaxWithdraw, POST_WITHDRAW_MARGIN_FLOOR } from "./margin";

// Type matches AccountMarginsView's subset we actually depend on.
type Margins = {
  omf: number;
  mf: number;
  imf: number;
  cmf?: number;
  mmf?: number;
  pon: number;
  pn?: number;
  bankruptcy: boolean;
};

function m(partial: Partial<Margins>): Margins {
  return {
    omf: 0,
    mf: 0,
    imf: 0,
    pon: 0,
    bankruptcy: false,
    ...partial,
  };
}

describe("computeMaxWithdraw — no positions / no orders", () => {
  it("returns full omf when pon=0 (free collateral, withdraw all)", () => {
    // No positions, no orders. AV = TV = USDC. omf = mf = collateral.
    expect(computeMaxWithdraw(m({ omf: 150, mf: 150, pon: 0 }))).toBe(150);
  });

  it("returns 0 when pon=0 and omf<0 (debt-only account, defensive)", () => {
    expect(computeMaxWithdraw(m({ omf: -10, mf: -10, pon: 0 }))).toBe(0);
  });
});

describe("computeMaxWithdraw — bankruptcy guard", () => {
  it("returns 0 for bankrupt accounts regardless of headroom", () => {
    expect(
      computeMaxWithdraw(
        m({ omf: 100, mf: 100, imf: 50, pon: 500, bankruptcy: true }),
      ),
    ).toBe(0);
  });
});

describe("computeMaxWithdraw — paper PnL doesn't bypass safety", () => {
  it("blocks paper-PnL withdraw when collateral is already at safety floor", () => {
    // The canonical bug scenario:
    //   USDC $100, BTC long $1000 notional, +$50 PnL, 10x leverage.
    //   AV = $150, TV = $100. omf = min(150,100) = 100. mf = 150.
    //   imf = $100 (10% × $1000). pon = $1000.
    //   protocol bound = 100 − 100 = $0
    //   safety bound = 150 − 0.15 × 1000 = $0
    //   maxWithdraw = max(0, min(0, 0)) = $0 — paper PnL stays locked.
    const result = computeMaxWithdraw(
      m({ omf: 100, mf: 150, imf: 100, pon: 1000 }),
    );
    expect(result).toBe(0);
  });

  it("allows withdrawing realized profit after a position is closed", () => {
    // Position closed → PnL realized into USDC. pon → 0.
    // omf = mf = $150 (full collateral). Withdraw the full $150.
    expect(computeMaxWithdraw(m({ omf: 150, mf: 150, pon: 0 }))).toBe(150);
  });

  it("partially allows withdraw when collateral exceeds safety floor", () => {
    // USDC $200, BTC long $1000 notional, +$50 PnL, 10x leverage.
    //   AV = $250, TV = $200. omf = 200. mf = 250.
    //   imf = $100. pon = $1000.
    //   protocol bound = 200 − 100 = $100
    //   safety bound = 250 − 0.15 × 1000 = $100
    // Both bounds coincide → withdraw $100 max (= the real USDC, paper
    // PnL stays locked behind the 15% floor).
    const result = computeMaxWithdraw(
      m({ omf: 200, mf: 250, imf: 100, pon: 1000 }),
    );
    expect(result).toBeCloseTo(100, 6);
  });
});

describe("computeMaxWithdraw — bound selection", () => {
  it("safety bound dominates on high-leverage markets", () => {
    // 20x perp: IMF_base = 5%. $1000 notional → imf = $50.
    //   AV = TV = USDC = $200 (no positions PnL, opened fresh).
    //   protocol bound = 200 − 50 = $150
    //   safety bound = 200 − 0.15 × 1000 = $50
    // Safety bound wins at $50.
    const result = computeMaxWithdraw(
      m({ omf: 200, mf: 200, imf: 50, pon: 1000 }),
    );
    expect(result).toBe(50);
  });

  it("protocol bound dominates on low-leverage markets", () => {
    // 2x perp: IMF_base = 50%. $1000 notional → imf = $500.
    //   AV = TV = $600.
    //   protocol bound = 600 − 500 = $100
    //   safety bound = 600 − 0.15 × 1000 = $450
    // Protocol bound wins at $100.
    const result = computeMaxWithdraw(
      m({ omf: 600, mf: 600, imf: 500, pon: 1000 }),
    );
    expect(result).toBe(100);
  });
});

describe("computeMaxWithdraw — never returns negative", () => {
  it("clamps to 0 when safety bound is deeply negative (account under-margined)", () => {
    // Account with heavy negative PnL: AV << TV.
    //   AV = $40, TV = $100. omf = 40 (min). mf = 40.
    //   imf = $100. pon = $1000.
    //   protocol bound = 40 − 100 = −60
    //   safety bound = 40 − 150 = −110
    // Clamps to 0.
    const result = computeMaxWithdraw(
      m({ omf: 40, mf: 40, imf: 100, pon: 1000 }),
    );
    expect(result).toBe(0);
  });
});

describe("computeMaxWithdraw — defensive missing-fields handling", () => {
  it("treats nullish omf/mf/imf as 0", () => {
    // Defensive — the SDK is strongly typed but lib/n1/margin.ts is
    // called from API routes that have nullable wrappers.
    const result = computeMaxWithdraw(
      m({ omf: undefined as unknown as number, mf: 0, pon: 0 }),
    );
    expect(result).toBe(0);
  });
});

describe("POST_WITHDRAW_MARGIN_FLOOR constant", () => {
  it("is exposed at 15% for the API layer to display in warnings", () => {
    // If this changes without an audit refresh, route.ts warning copy
    // ("would push margin ratio below 15%") drifts out of sync.
    expect(POST_WITHDRAW_MARGIN_FLOOR).toBe(0.15);
  });
});
