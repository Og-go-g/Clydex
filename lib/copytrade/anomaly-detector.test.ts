/**
 * Anomaly detector — covers the orchestration (which detectors are
 * wired into scanForAnomalies) and the persist dedup contract.
 *
 * The per-detector SQL itself is integration territory (only a real
 * Postgres can verify the window functions + partition behaviour).
 * We mock the `query` interface here just enough to assert that:
 *   - the four detectors are all invoked
 *   - persistAlert returns true/false based on the ON CONFLICT path
 *   - alert kinds + scope keys round-trip through the SQL params
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.HISTORY_DATABASE_URL ??= "postgresql://stub:stub@localhost:1/stub";

const queryMock = vi.fn();
const executeMock = vi.fn();

vi.mock("../db-history", () => ({
  query: queryMock,
  execute: executeMock,
}));

const {
  scanForAnomalies,
  persistAlert,
  BURST_THRESHOLD,
  BURST_WINDOW_S,
  REFUSED_THRESHOLD,
  REFUSED_WINDOW_S,
  DEVIATION_PCT,
  LEVERAGE_MULT,
} = await import("./anomaly-detector");

describe("scanForAnomalies — wiring", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue([]);
  });

  it("invokes every detector even when no alerts fire", async () => {
    const alerts = await scanForAnomalies();
    expect(alerts).toEqual([]);
    // 4 detectors hit at least once. Some hit twice (e.g. mark
    // deviation has a CTE) but we just check the lower bound.
    expect(queryMock.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("returns the union of all firing detector outputs", async () => {
    queryMock
      // detectBurst → 1 row
      .mockResolvedValueOnce([{ follower_wallet: "burstFollower", sign_count: "12" }])
      // detectRefusedSpike → returns aggregate count
      .mockResolvedValueOnce([{ refused_count: "7" }])
      // detectMarkDeviation → 1 row
      .mockResolvedValueOnce([
        {
          id: 42,
          follower_wallet: "deviationFollower",
          market_id: 1,
          symbol: "BTC-PERP",
          mark_price: "120000",
          trailing_avg: "100000",
          deviation: "0.2",
        },
      ])
      // detectLeverageSpike → 1 row
      .mockResolvedValueOnce([
        {
          id: 43,
          follower_wallet: "levFollower",
          symbol: "ETH-PERP",
          market_id: 2,
          leverage: "20",
          median_leverage: "5",
        },
      ]);

    const alerts = await scanForAnomalies();
    expect(alerts).toHaveLength(4);
    const kinds = alerts.map((a) => a.kind).sort();
    expect(kinds).toEqual(
      ["burst", "leverage-spike", "mark-deviation", "refused-spike"].sort(),
    );
  });
});

describe("persistAlert — dedup contract", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("returns true when the INSERT actually wrote a new row", async () => {
    queryMock.mockResolvedValueOnce([{ id: 1 }]);

    const ok = await persistAlert({
      kind: "burst",
      scopeKey: "FollowerA",
      windowMinute: new Date("2026-05-21T12:34:00Z"),
      severity: "warning",
      message: "test",
      details: { observed: 12 },
    });

    expect(ok).toBe(true);
  });

  it("returns false when ON CONFLICT DO NOTHING swallowed the insert", async () => {
    queryMock.mockResolvedValueOnce([]);

    const ok = await persistAlert({
      kind: "burst",
      scopeKey: "FollowerA",
      windowMinute: new Date("2026-05-21T12:34:00Z"),
      severity: "warning",
      message: "dup",
      details: {},
    });

    expect(ok).toBe(false);
  });

  it("serializes details as JSON to fit the jsonb column", async () => {
    queryMock.mockResolvedValueOnce([{ id: 1 }]);

    await persistAlert({
      kind: "leverage-spike",
      scopeKey: "FollowerB",
      windowMinute: new Date("2026-05-21T12:34:00Z"),
      severity: "critical",
      message: "lev",
      details: { observedLeverage: 50, medianLeverage: 5 },
    });

    const [, params] = queryMock.mock.calls[0];
    // The last positional param is the JSON-encoded details string.
    const detailsParam = params[params.length - 1];
    expect(typeof detailsParam).toBe("string");
    expect(JSON.parse(detailsParam)).toEqual({
      observedLeverage: 50,
      medianLeverage: 5,
    });
  });
});

describe("threshold constants", () => {
  it("burst threshold sensible (catches sustained signing, not occasional bursts)", () => {
    // A normal copy follower's rate is ~1 sign per copy engine cycle
    // when the leader is trading. 10/min is well above any natural
    // pattern but low enough to catch an attacker mid-drain.
    expect(BURST_THRESHOLD).toBeGreaterThanOrEqual(5);
    expect(BURST_THRESHOLD).toBeLessThanOrEqual(50);
    expect(BURST_WINDOW_S).toBe(60);
  });

  it("refused-spike threshold tighter than burst (probing is rare)", () => {
    // Refused signs SHOULD be near-zero in normal operation, so a
    // spike is more suspicious than a burst of approved signs.
    expect(REFUSED_THRESHOLD).toBeLessThanOrEqual(BURST_THRESHOLD);
    expect(REFUSED_WINDOW_S).toBeGreaterThanOrEqual(60);
  });

  it("deviation threshold matches lib/n1/slippage.ts safety clamp", () => {
    // Both are 5% — the runtime clamp and post-hoc detection should
    // agree on what "off mark" means.
    expect(DEVIATION_PCT).toBe(0.05);
  });

  it("leverage-spike multiplier sensible", () => {
    // 2× the follower's median catches the "5× → 50×" hijack pattern
    // without false-positiving on someone legitimately bumping
    // leverage from 2× to 4×.
    expect(LEVERAGE_MULT).toBeGreaterThanOrEqual(2);
    expect(LEVERAGE_MULT).toBeLessThanOrEqual(5);
  });
});
