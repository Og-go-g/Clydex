/**
 * Kill-switch reader — covers the fail-closed contract.
 *
 * The threat: if the engine sees a "not paused" result while the
 * actual DB flag is set OR while the DB itself is unreachable, an
 * attacker holding a stolen key can keep signing. Both cases must
 * fail closed.
 *
 * In normal operation the reader uses a 2s in-memory cache to avoid
 * issuing one query per signing call at peak — but the cache is
 * invalidated by setCopyTradingPaused() so a flip is immediately
 * visible.
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
  isCopyTradingPaused,
  setCopyTradingPaused,
  __resetKillSwitchCacheForTests,
} = await import("./kill-switch");

beforeEach(() => {
  queryMock.mockReset();
  executeMock.mockReset();
  __resetKillSwitchCacheForTests();
});

describe("isCopyTradingPaused — happy path", () => {
  it("returns paused=false with reason=null when flag is OFF", async () => {
    queryMock.mockResolvedValue([{ enabled: false, reason: null }]);
    const res = await isCopyTradingPaused();
    expect(res).toEqual({ paused: false, reason: null });
  });

  it("returns paused=true with the stored reason when flag is ON", async () => {
    queryMock.mockResolvedValue([
      { enabled: true, reason: "anomaly alert sign-burst" },
    ]);
    const res = await isCopyTradingPaused();
    expect(res).toEqual({ paused: true, reason: "anomaly alert sign-burst" });
  });
});

describe("isCopyTradingPaused — fail closed", () => {
  it("treats DB error as paused (do not sign while flag undetermined)", async () => {
    queryMock.mockRejectedValue(new Error("connection refused"));
    const res = await isCopyTradingPaused();
    expect(res.paused).toBe(true);
    expect(res.reason).toMatch(/DB read failed/);
  });

  it("treats missing row as paused (misdeployed instance, fail closed)", async () => {
    queryMock.mockResolvedValue([]);
    const res = await isCopyTradingPaused();
    expect(res.paused).toBe(true);
    expect(res.reason).toMatch(/missing/);
  });
});

describe("isCopyTradingPaused — caching", () => {
  it("caches the value for subsequent calls within TTL (~2s)", async () => {
    queryMock.mockResolvedValue([{ enabled: false, reason: null }]);

    await isCopyTradingPaused();
    await isCopyTradingPaused();
    await isCopyTradingPaused();

    // Three calls, one DB query.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe("setCopyTradingPaused — invalidates cache immediately", () => {
  it("a flip is visible on the next read without waiting for TTL", async () => {
    // First read: not paused.
    queryMock.mockResolvedValueOnce([{ enabled: false, reason: null }]);
    expect((await isCopyTradingPaused()).paused).toBe(false);

    // Admin hits pause — cache invalidated by setCopyTradingPaused.
    executeMock.mockResolvedValue(undefined);
    await setCopyTradingPaused(true, "test", "admin:test");

    // Next read returns the new value without waiting 2s.
    queryMock.mockResolvedValueOnce([
      { enabled: true, reason: "test" },
    ]);
    const res = await isCopyTradingPaused();
    expect(res.paused).toBe(true);
    expect(res.reason).toBe("test");
  });
});
