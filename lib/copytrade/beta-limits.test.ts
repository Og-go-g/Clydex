/**
 * Tests for the closed-beta caps module.
 *
 * Coverage:
 *   - Default caps when no env set
 *   - Env overrides honoured for finite positive numbers
 *   - Typo / non-numeric env falls back to defaults (security guarantee)
 *   - COPY_BETA_MODE=false unlocks legacy caps
 *   - Boundary conditions (equal-to-cap allowed; over-cap refused)
 *   - Subscription-count gate
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getBetaLimits,
  validateAgainstBetaLimits,
  validateSubscriptionCount,
} from "./beta-limits";

const originalEnv = { ...process.env };

beforeEach(() => {
  // Reset to a known baseline before each case so a stray var from a
  // previous test never bleeds into this one.
  delete process.env.COPY_BETA_MODE;
  delete process.env.MAX_BETA_ALLOCATION_USDC;
  delete process.env.MAX_BETA_LEVERAGE_MULT;
  delete process.env.MAX_BETA_SUBSCRIPTIONS;
});

afterEach(() => {
  // Restore whatever the process had at start of file so unrelated
  // tests in the same vitest run aren't affected.
  process.env = { ...originalEnv };
});

describe("getBetaLimits — defaults", () => {
  it("returns closed-beta defaults when no env is set", () => {
    const limits = getBetaLimits();
    expect(limits.betaMode).toBe(true);
    expect(limits.maxAllocationUsdc).toBe(1000);
    expect(limits.maxLeverageMult).toBe(3);
    expect(limits.maxSubscriptions).toBe(3);
  });

  it("honours numeric env overrides", () => {
    process.env.MAX_BETA_ALLOCATION_USDC = "500";
    process.env.MAX_BETA_LEVERAGE_MULT = "2";
    process.env.MAX_BETA_SUBSCRIPTIONS = "5";
    const limits = getBetaLimits();
    expect(limits.maxAllocationUsdc).toBe(500);
    expect(limits.maxLeverageMult).toBe(2);
    expect(limits.maxSubscriptions).toBe(5);
  });

  it("falls back to defaults on garbage env (typo / non-numeric)", () => {
    process.env.MAX_BETA_ALLOCATION_USDC = "ten-thousand";
    process.env.MAX_BETA_LEVERAGE_MULT = "";
    process.env.MAX_BETA_SUBSCRIPTIONS = "-1";
    const limits = getBetaLimits();
    expect(limits.maxAllocationUsdc).toBe(1000);
    expect(limits.maxLeverageMult).toBe(3);
    expect(limits.maxSubscriptions).toBe(3);
  });

  it("rejects zero / negative envs and falls to defaults", () => {
    process.env.MAX_BETA_ALLOCATION_USDC = "0";
    expect(getBetaLimits().maxAllocationUsdc).toBe(1000);
    process.env.MAX_BETA_ALLOCATION_USDC = "-100";
    expect(getBetaLimits().maxAllocationUsdc).toBe(1000);
  });
});

describe("getBetaLimits — legacy / production mode", () => {
  it("COPY_BETA_MODE=false lifts caps to legacy values", () => {
    process.env.COPY_BETA_MODE = "false";
    const limits = getBetaLimits();
    expect(limits.betaMode).toBe(false);
    expect(limits.maxAllocationUsdc).toBe(10_000_000);
    expect(limits.maxLeverageMult).toBe(5);
    expect(limits.maxSubscriptions).toBe(Number.POSITIVE_INFINITY);
  });

  it("only the literal 'false' disables beta — other values keep it on", () => {
    for (const v of ["0", "no", "off", "FALSE", "False", ""]) {
      process.env.COPY_BETA_MODE = v;
      expect(getBetaLimits().betaMode).toBe(true);
    }
  });
});

describe("validateAgainstBetaLimits", () => {
  it("accepts allocation under cap + leverage under cap", () => {
    expect(
      validateAgainstBetaLimits({ allocationUsdc: 500, leverageMult: 2 }),
    ).toBeNull();
  });

  it("accepts equal-to-cap", () => {
    expect(
      validateAgainstBetaLimits({ allocationUsdc: 1000, leverageMult: 3 }),
    ).toBeNull();
  });

  it("rejects allocation over cap with a helpful message", () => {
    const msg = validateAgainstBetaLimits({ allocationUsdc: 1001 });
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/allocation/i);
    expect(msg).toMatch(/\$1,000/);
  });

  it("rejects leverage over cap with a helpful message", () => {
    const msg = validateAgainstBetaLimits({
      allocationUsdc: 100,
      leverageMult: 5,
    });
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/leverage/i);
    expect(msg).toMatch(/3×|3x/i);
  });

  it("treats undefined leverageMult as OK (defaults to 1× in routes)", () => {
    expect(
      validateAgainstBetaLimits({ allocationUsdc: 500 }),
    ).toBeNull();
  });
});

describe("validateSubscriptionCount", () => {
  it("returns null when room for one more", () => {
    expect(validateSubscriptionCount(0)).toBeNull();
    expect(validateSubscriptionCount(2)).toBeNull(); // default cap=3
  });

  it("returns error at exactly the cap", () => {
    const msg = validateSubscriptionCount(3);
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/3 traders/);
  });

  it("returns error over cap", () => {
    expect(validateSubscriptionCount(10)).not.toBeNull();
  });

  it("never refuses in legacy mode (infinite cap)", () => {
    process.env.COPY_BETA_MODE = "false";
    expect(validateSubscriptionCount(9999)).toBeNull();
  });
});
