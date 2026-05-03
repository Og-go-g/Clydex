/**
 * /api/health route tests.
 *
 * The route does two things: ping each pool and aggregate. We mock both
 * pool layers so the test runs without a real Postgres, and exercise the
 * three meaningful states:
 *
 *   1. both pools healthy → 200, body.ok=true, latency numbers present
 *   2. main pool down     → 503, body.ok=false, body.main.error set,
 *                                 body.history still ok (independence)
 *   3. history pool down  → 503, body.ok=false, body.history.error set
 *
 * The pings run in parallel (Promise.all in the route), so this also
 * verifies that one pool's failure doesn't gate the other.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub env + module-level pool dependencies before route imports them.
process.env.DATABASE_URL ??= "postgresql://stub:stub@localhost:1/stub";
process.env.HISTORY_DATABASE_URL ??= "postgresql://stub:stub@localhost:1/stub";

const prismaQuery = vi.fn();
const historyQuery = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: { $queryRaw: prismaQuery },
}));

vi.mock("@/lib/db-history", () => ({
  historyPool: { query: historyQuery },
}));

const { GET } = await import("./route");

describe("GET /api/health", () => {
  beforeEach(() => {
    prismaQuery.mockReset();
    historyQuery.mockReset();
  });

  it("returns 200 when both pools are healthy", async () => {
    prismaQuery.mockResolvedValue([{ "?column?": 1 }]);
    historyQuery.mockResolvedValue({ rows: [{ "?column?": 1 }] });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.main.ok).toBe(true);
    expect(body.history.ok).toBe(true);
    expect(body.main.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body.history.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns 503 with main.error when main pool fails", async () => {
    prismaQuery.mockRejectedValue(new Error("main DB down"));
    historyQuery.mockResolvedValue({ rows: [{ "?column?": 1 }] });

    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.main.ok).toBe(false);
    expect(body.main.error).toBe("main DB down");
    // History pool's success is not gated by main's failure — Promise.all
    // resolves both regardless. Confirms parallel execution.
    expect(body.history.ok).toBe(true);
  });

  it("returns 503 with history.error when history pool fails", async () => {
    prismaQuery.mockResolvedValue([{ "?column?": 1 }]);
    historyQuery.mockRejectedValue(new Error("history DB down"));

    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.history.ok).toBe(false);
    expect(body.history.error).toBe("history DB down");
    expect(body.main.ok).toBe(true);
  });

  it("returns 503 when BOTH pools fail and reports both errors", async () => {
    prismaQuery.mockRejectedValue(new Error("main fault"));
    historyQuery.mockRejectedValue(new Error("history fault"));

    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.main.error).toBe("main fault");
    expect(body.history.error).toBe("history fault");
  });

  it("sets Cache-Control: no-store so monitors never see a stale 200", async () => {
    prismaQuery.mockResolvedValue([{ "?column?": 1 }]);
    historyQuery.mockResolvedValue({ rows: [{ "?column?": 1 }] });

    const res = await GET();
    const cc = res.headers.get("Cache-Control") ?? "";
    expect(cc).toContain("no-store");
  });
});
