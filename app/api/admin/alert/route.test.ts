/**
 * /api/admin/alert tests.
 *
 * Verifies the contract that infrastructure-side alerters (e.g. systemd
 * OnFailure hooks) depend on:
 *
 *   - Auth: rejects missing / wrong / right secret correctly.
 *   - Body validation: rejects missing required fields.
 *   - Captures into Sentry with the right scope (level, tags, context).
 *
 * Sentry is fully mocked at module boundary so the tests don't try to
 * actually upload events.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.CRON_SECRET ??= "test-secret-32-characters-long-xxxxx";

const captureMessage = vi.fn(() => "fake-event-id-123");
const setLevel = vi.fn();
const setTag = vi.fn();
const setContext = vi.fn();

// Sentry.withScope passes a Scope object to its callback; we mock just
// enough of the Scope surface to assert on the calls our route makes.
vi.mock("@sentry/nextjs", () => ({
  withScope: (fn: (scope: { setLevel: typeof setLevel; setTag: typeof setTag; setContext: typeof setContext }) => string) =>
    fn({ setLevel, setTag, setContext }),
  captureMessage,
}));

const { POST } = await import("./route");

function makeRequest(body: unknown, opts: { auth?: string } = {}) {
  return new Request("http://localhost/api/admin/alert", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.auth !== undefined ? { Authorization: opts.auth } : {}),
    },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/admin/alert", () => {
  beforeEach(() => {
    captureMessage.mockClear();
    setLevel.mockClear();
    setTag.mockClear();
    setContext.mockClear();
  });

  it("rejects missing Authorization header with 401", async () => {
    const res = await POST(makeRequest({ source: "x", message: "y" }));
    expect(res.status).toBe(401);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("rejects wrong secret with 401", async () => {
    const res = await POST(
      makeRequest({ source: "x", message: "y" }, { auth: "Bearer wrong-secret" }),
    );
    expect(res.status).toBe(401);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("rejects body missing required fields with 400", async () => {
    const res = await POST(
      makeRequest({ source: "x" /* no message */ }, { auth: `Bearer ${process.env.CRON_SECRET}` }),
    );
    expect(res.status).toBe(400);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("rejects invalid level value with 400", async () => {
    const res = await POST(
      makeRequest(
        { source: "x", message: "y", level: "catastrophic" },
        { auth: `Bearer ${process.env.CRON_SECRET}` },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("captures into Sentry with default level=fatal when level omitted", async () => {
    const res = await POST(
      makeRequest(
        { source: "systemd:postgresql@16-main", message: "PG died" },
        { auth: `Bearer ${process.env.CRON_SECRET}` },
      ),
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.eventId).toBe("fake-event-id-123");

    expect(setLevel).toHaveBeenCalledWith("fatal");
    // alert.source + alert.channel are set on every call regardless of body.tags
    expect(setTag).toHaveBeenCalledWith("alert.source", "systemd:postgresql@16-main");
    expect(setTag).toHaveBeenCalledWith("alert.channel", "systemd-hook");
    expect(captureMessage).toHaveBeenCalledWith("PG died", "fatal");
  });

  it("forwards body.tags and body.extra to the Sentry scope", async () => {
    await POST(
      makeRequest(
        {
          source: "systemd:postgresql@16-main",
          message: "PG died",
          level: "warning",
          tags: { unit: "postgresql@16-main", host: "ubuntu-4gb-nbg1-1" },
          extra: { lastBeat: "2026-05-03T10:00:00Z", oomKilled: true },
        },
        { auth: `Bearer ${process.env.CRON_SECRET}` },
      ),
    );

    expect(setLevel).toHaveBeenCalledWith("warning");
    expect(setTag).toHaveBeenCalledWith("unit", "postgresql@16-main");
    expect(setTag).toHaveBeenCalledWith("host", "ubuntu-4gb-nbg1-1");
    expect(setContext).toHaveBeenCalledWith("alert.extra", {
      lastBeat: "2026-05-03T10:00:00Z",
      oomKilled: true,
    });
  });
});
