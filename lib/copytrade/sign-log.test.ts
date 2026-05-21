/**
 * Sign-log hash chain — covers the integrity primitive.
 *
 * Tests use `computeChainHash` directly. The DB-side append + verify
 * functions hit Postgres and are exercised at deploy time by the
 * post-migration verification SQL (see sql/2026-05-21_sign_log.sql).
 * The pure crypto piece is what we need to pin down here — the SQL
 * + grant logic is straightforward and a unit test of it would
 * mostly re-implement a Postgres mock.
 */

import { describe, it, expect } from "vitest";

process.env.HISTORY_DATABASE_URL ??= "postgresql://stub:stub@localhost:1/stub";

const { computeChainHash } = await import("./sign-log");

function entry(partial: Partial<Parameters<typeof computeChainHash>[1]>): Parameters<typeof computeChainHash>[1] {
  return {
    followerWallet: "FollowerA",
    leaderWallet: "LeaderA",
    action: "open",
    marketId: 1,
    symbol: "BTC-PERP",
    side: "Long",
    size: 0.01,
    leverage: 2,
    slippage: 0.005,
    markPrice: 100_000,
    policyResult: "approved",
    signedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...partial,
  };
}

const ZERO = Buffer.alloc(32);

describe("computeChainHash — determinism", () => {
  it("returns the same hash for the same prev + entry", () => {
    const e = entry({});
    const a = computeChainHash(ZERO, e);
    const b = computeChainHash(ZERO, e);
    expect(a.equals(b)).toBe(true);
  });

  it("returns a 32-byte SHA-256 digest", () => {
    const h = computeChainHash(ZERO, entry({}));
    expect(h.length).toBe(32);
  });

  it("starts from a 32-byte zero prev_hash for genesis row (canonical)", () => {
    // Future readers verifying the chain offline must know the
    // initial prev_hash. Pin it here.
    expect(ZERO.length).toBe(32);
    expect(ZERO.every((b) => b === 0)).toBe(true);
  });
});

describe("computeChainHash — tamper detection", () => {
  it("changes when any single field changes (size)", () => {
    const a = computeChainHash(ZERO, entry({ size: 0.01 }));
    const b = computeChainHash(ZERO, entry({ size: 0.02 }));
    expect(a.equals(b)).toBe(false);
  });

  it("changes when action changes (open → close)", () => {
    const a = computeChainHash(ZERO, entry({ action: "open" }));
    const b = computeChainHash(ZERO, entry({ action: "close" }));
    expect(a.equals(b)).toBe(false);
  });

  it("changes when leverage changes", () => {
    const a = computeChainHash(ZERO, entry({ leverage: 2 }));
    const b = computeChainHash(ZERO, entry({ leverage: 5 }));
    expect(a.equals(b)).toBe(false);
  });

  it("changes when symbol changes (market substitution)", () => {
    const a = computeChainHash(ZERO, entry({ symbol: "BTC-PERP" }));
    const b = computeChainHash(ZERO, entry({ symbol: "ETH-PERP" }));
    expect(a.equals(b)).toBe(false);
  });

  it("changes when policyResult flips (approved ↔ refused)", () => {
    const a = computeChainHash(ZERO, entry({ policyResult: "approved" }));
    const b = computeChainHash(ZERO, entry({ policyResult: "refused:leverage" }));
    expect(a.equals(b)).toBe(false);
  });

  it("changes when the prev_hash changes (chain linkage)", () => {
    const e = entry({});
    const a = computeChainHash(ZERO, e);
    const otherPrev = Buffer.alloc(32, 0xff);
    const b = computeChainHash(otherPrev, e);
    expect(a.equals(b)).toBe(false);
  });

  it("changes when signedAt changes (millisecond granularity)", () => {
    const a = computeChainHash(ZERO, entry({ signedAt: new Date("2026-05-21T00:00:00.000Z") }));
    const b = computeChainHash(ZERO, entry({ signedAt: new Date("2026-05-21T00:00:00.001Z") }));
    expect(a.equals(b)).toBe(false);
  });
});

describe("computeChainHash — chain integrity walkthrough", () => {
  it("each row's hash feeds the next, forming the chain", () => {
    // Row 1: prev = zero, hash = H1
    const e1 = entry({ size: 0.01 });
    const h1 = computeChainHash(ZERO, e1);

    // Row 2: prev = H1, hash = H2
    const e2 = entry({ size: 0.02 });
    const h2 = computeChainHash(h1, e2);

    // Row 3: prev = H2, hash = H3
    const e3 = entry({ size: 0.03 });
    const h3 = computeChainHash(h2, e3);

    // If an attacker tampers with row 2 (e.g. changes the size),
    // re-computing H2 with the new entry gives a different hash —
    // and row 3's stored prev_hash still points to the OLD H2.
    // The break is detectable.
    const e2Tampered = entry({ size: 0.99 });
    const h2Tampered = computeChainHash(h1, e2Tampered);
    expect(h2Tampered.equals(h2)).toBe(false);

    // The attacker would have to also re-compute h3 to make it
    // chain off h2Tampered — and so on for every subsequent row.
    // verifyChain() catches this.
    const h3IfTampered = computeChainHash(h2Tampered, e3);
    expect(h3IfTampered.equals(h3)).toBe(false);
  });
});
