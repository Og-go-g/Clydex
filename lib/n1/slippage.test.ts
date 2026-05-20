/**
 * Slippage worst-price helper — covers the audit C4 fix.
 *
 * The failure mode we're closing: on a Tier 4-5 perp with a 200 bps
 * spread, a user setting 0.5% slippage previously got `markPrice ×
 * 1.005` as their IOC ceiling. mark sits inside the spread, so any
 * fill happened deeper than the slippage budget. New formula anchors
 * on the best opposite quote and clamps to ±5% around mark to catch
 * empty / stale / manipulated books.
 *
 * Variables follow N1's API naming:
 *   Side.Bid = buy (long); needs bestAsk (we hit asks to buy)
 *   Side.Ask = sell (short); needs bestBid (we hit bids to sell)
 */

import { describe, it, expect } from "vitest";
import { Side } from "@n1xyz/nord-ts";
import {
  computeWorstPrice,
  SLIPPAGE_MAX_DEVIATION,
  type SlippageInputs,
} from "./slippage";

function inputs(partial: Partial<SlippageInputs>): SlippageInputs {
  return {
    side: Side.Bid,
    bestAsk: 100,
    bestBid: 99,
    markPrice: 99.5,
    slippage: 0.005,
    ...partial,
  };
}

describe("computeWorstPrice — buy side (Side.Bid)", () => {
  it("anchors on best ask + slippage when within clamp", () => {
    // Tight spread (asks=100, bids=99.9, mark=99.95). 0.5% slippage.
    // worstFromBook = 100 × 1.005 = 100.5
    // clamp upper = 99.95 × 1.05 = 104.95 — not binding
    expect(
      computeWorstPrice(
        inputs({ bestAsk: 100, bestBid: 99.9, markPrice: 99.95, slippage: 0.005 }),
      ),
    ).toBeCloseTo(100.5, 6);
  });

  it("uses best ask not mark even on a wide spread", () => {
    // The canonical bug scenario: mark=$100, spread 100–101.
    // Old formula: 100 × 1.005 = 100.5 — below bestAsk → wouldn't fill.
    // New formula: 101 × 1.005 = 101.505 — fills at bestAsk and a hair past.
    const result = computeWorstPrice(
      inputs({ bestAsk: 101, bestBid: 99, markPrice: 100, slippage: 0.005 }),
    );
    expect(result).toBeCloseTo(101.505, 6);
    // Sanity: must be ≥ bestAsk, otherwise no fill.
    expect(result).toBeGreaterThanOrEqual(101);
  });
});

describe("computeWorstPrice — sell side (Side.Ask)", () => {
  it("anchors on best bid − slippage when within clamp", () => {
    // 0.5% slippage. worstFromBook = 99.9 × 0.995 = 99.4005
    const result = computeWorstPrice(
      inputs({
        side: Side.Ask,
        bestAsk: 100,
        bestBid: 99.9,
        markPrice: 99.95,
        slippage: 0.005,
      }),
    );
    expect(result).toBeCloseTo(99.4005, 4);
  });

  it("uses best bid on a wide spread", () => {
    // mark=$100, spread 99–101. Sell 0.5%: 99 × 0.995 = 98.505.
    const result = computeWorstPrice(
      inputs({
        side: Side.Ask,
        bestAsk: 101,
        bestBid: 99,
        markPrice: 100,
        slippage: 0.005,
      }),
    );
    expect(result).toBeCloseTo(98.505, 6);
    expect(result).toBeLessThanOrEqual(99);
  });
});

describe("computeWorstPrice — safety clamp", () => {
  it("clamps upper when stale/empty book has best ask wildly above mark", () => {
    // bestAsk way above mark (book gapped or stale).
    // worstFromBook = 200 × 1.005 = 201
    // clamp upper = 100 × 1.05 = 105 — binding
    const result = computeWorstPrice(
      inputs({ bestAsk: 200, bestBid: 99, markPrice: 100, slippage: 0.005 }),
    );
    expect(result).toBe(100 * (1 + SLIPPAGE_MAX_DEVIATION));
  });

  it("clamps lower when stale book has best bid wildly below mark", () => {
    // bestBid way below mark.
    // worstFromBook = 50 × 0.995 = 49.75
    // clamp lower = 100 × 0.95 = 95 — binding
    const result = computeWorstPrice(
      inputs({
        side: Side.Ask,
        bestAsk: 101,
        bestBid: 50,
        markPrice: 100,
        slippage: 0.005,
      }),
    );
    expect(result).toBe(100 * (1 - SLIPPAGE_MAX_DEVIATION));
  });

  it("does NOT clamp when slippage budget itself stays within ±5% of mark", () => {
    // 3% slippage, normal spread. Clamp band ±5% — not binding.
    const result = computeWorstPrice(
      inputs({ bestAsk: 100.1, bestBid: 99.9, markPrice: 100, slippage: 0.03 }),
    );
    // 100.1 × 1.03 = 103.103 (inside ±5% = 95–105)
    expect(result).toBeCloseTo(103.103, 6);
  });
});

describe("computeWorstPrice — fail-closed edge cases", () => {
  it("throws when buying and bestAsk is missing (empty asks side)", () => {
    expect(() =>
      computeWorstPrice(inputs({ side: Side.Bid, bestAsk: null })),
    ).toThrow(/best ask is empty/);
  });

  it("throws when selling and bestBid is missing (empty bids side)", () => {
    expect(() =>
      computeWorstPrice(inputs({ side: Side.Ask, bestBid: null })),
    ).toThrow(/best bid is empty/);
  });

  it("throws when bestAsk is non-positive (sanity guard)", () => {
    expect(() =>
      computeWorstPrice(inputs({ side: Side.Bid, bestAsk: 0 })),
    ).toThrow(/best ask is empty/);
    expect(() =>
      computeWorstPrice(inputs({ side: Side.Bid, bestAsk: -1 })),
    ).toThrow(/best ask is empty/);
  });

  it("throws when markPrice is non-positive (clamp anchor invalid)", () => {
    expect(() =>
      computeWorstPrice(inputs({ markPrice: 0 })),
    ).toThrow(/markPrice/);
    expect(() =>
      computeWorstPrice(inputs({ markPrice: -1 })),
    ).toThrow(/markPrice/);
  });

  it("throws on negative slippage (caller bug)", () => {
    expect(() => computeWorstPrice(inputs({ slippage: -0.01 }))).toThrow(/slippage/);
  });

  it("accepts zero slippage (price equals best opposite exactly)", () => {
    // Edge: user sets slippage = 0 to demand best-quote-only. Buy →
    // worst = bestAsk. Sell → worst = bestBid.
    expect(
      computeWorstPrice(inputs({ side: Side.Bid, bestAsk: 100, slippage: 0 })),
    ).toBeCloseTo(100, 6);
    expect(
      computeWorstPrice(inputs({ side: Side.Ask, bestBid: 99, slippage: 0 })),
    ).toBeCloseTo(99, 6);
  });
});

describe("SLIPPAGE_MAX_DEVIATION constant", () => {
  it("is exposed at 5% — changes here must update the runbook", () => {
    // The clamp doubles as a safety-net for stale orderbooks. Lowering
    // it tightens the runway on volatile markets; raising it loosens
    // the protection. Either direction warrants a manual eval against
    // prod fill data.
    expect(SLIPPAGE_MAX_DEVIATION).toBe(0.05);
  });
});
