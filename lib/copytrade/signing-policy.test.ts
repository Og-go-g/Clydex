/**
 * Signing policy gate — covers each refuse branch + happy path.
 *
 * Threat scenarios traced:
 *   - Leverage spike (mult bypass) → refuse.
 *   - Position size dump beyond subscription cap → refuse.
 *   - Slippage parameter pushed past clamp → refuse.
 *   - Mark price junk → refuse.
 *   - Close path: USD cap relaxed (shrink is always safe).
 */

import { describe, it, expect } from "vitest";
import {
  verifySigningPolicy,
  POLICY_LIMITS,
  type SigningPolicyContext,
} from "./signing-policy";

const BASE_CTX: SigningPolicyContext = {
  walletAddr: "FollowerWalletA",
  symbol: "BTC-PERP",
  marketId: 1,
  side: "Long",
  size: 0.01, // 0.01 BTC
  leverage: 2,
  slippage: 0.005,
  markPrice: 100_000, // $100k
  subscription: {
    allocationUsdc: 1000,
    leverageMult: 2,
    maxPositionUsdc: 5000,
  },
  action: "open",
};

function ctx(partial: Partial<SigningPolicyContext>): SigningPolicyContext {
  return {
    ...BASE_CTX,
    ...partial,
    subscription: { ...BASE_CTX.subscription, ...(partial.subscription ?? {}) },
  };
}

describe("verifySigningPolicy — happy path", () => {
  it("approves a within-envelope open order", () => {
    // 0.01 BTC × $100k = $1000 notional. Allocation $1000 × leverage 2 = $2000 cap. Under it.
    const verdict = verifySigningPolicy(ctx({}));
    expect(verdict.ok).toBe(true);
  });

  it("approves just under the per-market cap boundary (with 5% slack)", () => {
    // maxPositionUsdc $5000 × 1.05 slack = $5250 effective cap.
    // 0.05 BTC × $100k = $5000. Under cap.
    const verdict = verifySigningPolicy(
      ctx({
        size: 0.05,
        leverage: 1,
        subscription: { allocationUsdc: 5000, leverageMult: 1, maxPositionUsdc: 5000 },
      }),
    );
    expect(verdict.ok).toBe(true);
  });
});

describe("verifySigningPolicy — leverage refusals", () => {
  it("refuses leverage above hard cap (defense against arithmetic overflow)", () => {
    const verdict = verifySigningPolicy(
      ctx({ leverage: 250, subscription: { leverageMult: 250 } as SigningPolicyContext["subscription"] }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/leverage 250 out of/);
  });

  it("refuses signed leverage that doesn't match subscription mult (tamper detection)", () => {
    // Subscription says 2×, but engine code somehow tries to sign 5×.
    // This catches a compromised dependency injecting wrong leverage.
    const verdict = verifySigningPolicy(ctx({ leverage: 5 }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/does not match subscription mult/);
  });

  it("refuses leverage below 1 (degenerate)", () => {
    const verdict = verifySigningPolicy(
      ctx({ leverage: 0.5, subscription: { leverageMult: 0.5 } as SigningPolicyContext["subscription"] }),
    );
    expect(verdict.ok).toBe(false);
  });
});

describe("verifySigningPolicy — position-size refusals", () => {
  it("refuses positionUsdc above per-market cap (open)", () => {
    // 0.1 BTC × $100k = $10000 > $5000 cap × 1.05 slack = $5250.
    const verdict = verifySigningPolicy(ctx({ size: 0.1 }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/maxPositionUsdc/);
  });

  it("refuses positionUsdc above allocation × leverage cap (open) when per-market is unset", () => {
    // No maxPositionUsdc set, but allocation $1000 × 2× = $2000 × 1.05 = $2100.
    // Size 0.025 BTC × $100k = $2500 > $2100.
    const verdict = verifySigningPolicy(
      ctx({
        size: 0.025,
        subscription: { allocationUsdc: 1000, leverageMult: 2, maxPositionUsdc: null },
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/allocation × mult/);
  });

  it("APPROVES oversized notional on close action (shrink is safe)", () => {
    // Close at huge size is fine — server-side reduce-only flag clamps
    // to actual position. Cap doesn't apply.
    const verdict = verifySigningPolicy(ctx({ action: "close", size: 100 }));
    expect(verdict.ok).toBe(true);
  });

  it("APPROVES oversized notional on decrease action (shrink is safe)", () => {
    const verdict = verifySigningPolicy(ctx({ action: "decrease", size: 100 }));
    expect(verdict.ok).toBe(true);
  });

  it("refuses oversized notional on increase action", () => {
    const verdict = verifySigningPolicy(ctx({ action: "increase", size: 0.1 }));
    expect(verdict.ok).toBe(false);
  });

  it("refuses oversized notional on flip action (flip opens new direction)", () => {
    const verdict = verifySigningPolicy(ctx({ action: "flip", size: 0.1 }));
    expect(verdict.ok).toBe(false);
  });
});

describe("verifySigningPolicy — slippage refusals", () => {
  it("refuses slippage above hard cap", () => {
    const verdict = verifySigningPolicy(ctx({ slippage: 0.2 }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/slippage 0.2 out of/);
  });

  it("refuses negative slippage", () => {
    const verdict = verifySigningPolicy(ctx({ slippage: -0.001 }));
    expect(verdict.ok).toBe(false);
  });

  it("approves slippage = 0 (best-quote-only intent)", () => {
    const verdict = verifySigningPolicy(ctx({ slippage: 0 }));
    expect(verdict.ok).toBe(true);
  });
});

describe("verifySigningPolicy — sanity refusals", () => {
  it("refuses non-finite markPrice", () => {
    expect(verifySigningPolicy(ctx({ markPrice: NaN })).ok).toBe(false);
    expect(verifySigningPolicy(ctx({ markPrice: Infinity })).ok).toBe(false);
    expect(verifySigningPolicy(ctx({ markPrice: 0 })).ok).toBe(false);
    expect(verifySigningPolicy(ctx({ markPrice: -1 })).ok).toBe(false);
  });

  it("refuses non-finite or non-positive size", () => {
    expect(verifySigningPolicy(ctx({ size: 0 })).ok).toBe(false);
    expect(verifySigningPolicy(ctx({ size: -1 })).ok).toBe(false);
    expect(verifySigningPolicy(ctx({ size: NaN })).ok).toBe(false);
  });

  it("refuses arbitrary-large size (catch overflow)", () => {
    const verdict = verifySigningPolicy(ctx({ size: POLICY_LIMITS.MAX_BASE_SIZE + 1 }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/exceeds absolute max/);
  });

  it("refuses invalid side string", () => {
    const verdict = verifySigningPolicy(
      ctx({ side: "Diagonal" as unknown as SigningPolicyContext["side"] }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/side invalid/);
  });
});

describe("POLICY_LIMITS constants", () => {
  it("hard slippage cap matches lib/n1/slippage.ts MAX_DEVIATION (5%)", () => {
    // If these drift apart, slippage.ts could permit a value the
    // policy gate refuses, and vice versa.
    expect(POLICY_LIMITS.MAX_SLIPPAGE_HARD).toBe(0.05);
  });

  it("hard leverage cap reflects 01 Exchange's known max (200x)", () => {
    expect(POLICY_LIMITS.MAX_LEVERAGE_HARD).toBe(200);
  });
});
