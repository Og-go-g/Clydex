/**
 * Tests for the pg-boss health-scan handler.
 *
 * Strategy: mock `query` from db-history + `Sentry.captureMessage` so
 * we can assert what gets alerted on, without needing a live
 * Postgres or a Sentry endpoint. The handler is plumbing, not
 * business logic, so we focus on the alert-shape contract:
 *
 *   - failed rows → one Sentry event per (name, error_message) group
 *   - stalled schedules → one Sentry event per job name beyond 2× interval
 *   - both empty → zero Sentry events
 *   - thrown error in query → caught + emitted as captureException
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.HISTORY_DATABASE_URL ??= "postgresql://stub:stub@localhost:1/stub";

const queryMock = vi.fn();
vi.mock("@/lib/db-history", () => ({ query: queryMock }));

const captureMessageMock = vi.fn();
const captureExceptionMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureMessage: (...args: unknown[]) => captureMessageMock(...args),
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
}));

// Silence the handler's own console.warn / console.error during tests.
const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

const { handlePgbossHealthScan } = await import("./pgboss-health-scan");

const FAKE_JOB = { id: "test", name: "pgboss-health-scan", data: {} as Record<string, never> };

beforeEach(() => {
  queryMock.mockReset();
  captureMessageMock.mockReset();
  captureExceptionMock.mockReset();
  consoleWarnSpy.mockClear();
  consoleErrorSpy.mockClear();
});

describe("handlePgbossHealthScan", () => {
  it("fires no Sentry events on a healthy cluster", async () => {
    // Call 1 (detectRecentFailures) → no failures
    // Call 2 (detectStalledSchedules) → all schedules fresh
    const now = new Date();
    queryMock.mockResolvedValueOnce([]);
    queryMock.mockResolvedValueOnce([
      { name: "copy-engine-tick", last_completed_at: now },
      { name: "anomaly-scan", last_completed_at: now },
      { name: "refresh-leaderboard-tier-1", last_completed_at: now },
      { name: "refresh-leaderboard-tier-2", last_completed_at: now },
      { name: "refresh-leaderboard-tier-3", last_completed_at: now },
      { name: "refresh-leaderboard-tier-4", last_completed_at: now },
      { name: "refresh-leaderboard-tier-spot", last_completed_at: now },
      { name: "resolve-wallets", last_completed_at: now },
      { name: "sync-users-enqueuer", last_completed_at: now },
      { name: "pgboss-health-scan", last_completed_at: now },
    ]);

    await handlePgbossHealthScan(FAKE_JOB);

    expect(captureMessageMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("alerts once per (name, error_message) for recent failures", async () => {
    const lastFailed = new Date("2026-05-22T12:00:00Z");
    queryMock.mockResolvedValueOnce([
      {
        name: "refresh-leaderboard-tier-2",
        error_message: "ON CONFLICT DO UPDATE command cannot affect row a second time",
        failure_count: 3,
        last_failed_at: lastFailed,
      },
    ]);
    // No stalled schedules
    queryMock.mockResolvedValueOnce(
      Object.keys({
        "copy-engine-tick": 1, "anomaly-scan": 1, "refresh-leaderboard-tier-1": 1,
        "refresh-leaderboard-tier-2": 1, "refresh-leaderboard-tier-3": 1,
        "refresh-leaderboard-tier-4": 1, "refresh-leaderboard-tier-spot": 1,
        "resolve-wallets": 1, "sync-users-enqueuer": 1, "pgboss-health-scan": 1,
      }).map((name) => ({ name, last_completed_at: new Date() })),
    );

    await handlePgbossHealthScan(FAKE_JOB);

    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    const [msg, opts] = captureMessageMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toContain("refresh-leaderboard-tier-2 failed 3× in last 1h");
    expect(msg).toContain("ON CONFLICT DO UPDATE");
    expect(opts.level).toBe("warning");
    expect((opts.tags as Record<string, string>).event).toBe("job-failed");
  });

  it("alerts on stalled schedule beyond 2× interval", async () => {
    queryMock.mockResolvedValueOnce([]); // no failures

    const now = Date.now();
    const fresh = new Date(now - 30_000); // 30 s ago — fresh for any cron
    const veryStale = new Date(now - 6 * 60 * 60_000); // 6 h ago

    queryMock.mockResolvedValueOnce([
      // tier-1 interval is 30 min, 2× = 60 min. 6 h is >> 60 min — STALE.
      { name: "refresh-leaderboard-tier-1", last_completed_at: veryStale },
      // All others fresh.
      { name: "copy-engine-tick", last_completed_at: fresh },
      { name: "anomaly-scan", last_completed_at: fresh },
      { name: "refresh-leaderboard-tier-2", last_completed_at: fresh },
      { name: "refresh-leaderboard-tier-3", last_completed_at: fresh },
      { name: "refresh-leaderboard-tier-4", last_completed_at: fresh },
      { name: "refresh-leaderboard-tier-spot", last_completed_at: fresh },
      { name: "resolve-wallets", last_completed_at: fresh },
      { name: "sync-users-enqueuer", last_completed_at: fresh },
      { name: "pgboss-health-scan", last_completed_at: fresh },
    ]);

    await handlePgbossHealthScan(FAKE_JOB);

    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    const [msg, opts] = captureMessageMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toContain("refresh-leaderboard-tier-1 stalled");
    expect(msg).toContain("expected every 30min");
    expect((opts.tags as Record<string, string>).event).toBe("schedule-stalled");
  });

  it("treats never-completed schedule (null last) as stalled", async () => {
    queryMock.mockResolvedValueOnce([]);
    queryMock.mockResolvedValueOnce([
      { name: "refresh-leaderboard-tier-4", last_completed_at: null },
      // Others fresh
      { name: "copy-engine-tick", last_completed_at: new Date() },
    ]);

    await handlePgbossHealthScan(FAKE_JOB);

    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    const [msg] = captureMessageMock.mock.calls[0] as [string];
    expect(msg).toContain("refresh-leaderboard-tier-4 stalled");
    expect(msg).toContain("last completed: never");
  });

  it("ignores stalled schedules under 2× interval (fresh enough)", async () => {
    queryMock.mockResolvedValueOnce([]);
    const justUnderThreshold = new Date(Date.now() - 1.5 * 60 * 60_000); // 1.5 h — tier-2 interval is 1 h, 2× = 2 h
    queryMock.mockResolvedValueOnce([
      { name: "refresh-leaderboard-tier-2", last_completed_at: justUnderThreshold },
    ]);

    await handlePgbossHealthScan(FAKE_JOB);

    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it("catches its own errors and emits captureException", async () => {
    queryMock.mockRejectedValueOnce(new Error("simulated DB outage"));

    await handlePgbossHealthScan(FAKE_JOB);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, opts] = captureExceptionMock.mock.calls[0] as [Error, Record<string, unknown>];
    expect(err.message).toContain("simulated DB outage");
    expect((opts.tags as Record<string, string>).event).toBe("scan-failed");
  });
});
