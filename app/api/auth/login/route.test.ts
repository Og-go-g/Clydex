/**
 * /api/auth/login route — integration test for the C2 fail-closed wiring.
 *
 * The audit acceptance criterion is specifically: "when pgConsumeNonce
 * throws, the route returns 503 (not 200, not 401)". We mock consumeNonce
 * to throw NonceStoreUnavailableError (keeping the real exported class so
 * `instanceof` in the route still matches) and assert the status code.
 *
 * Returning 401 would be the bug: a 401 looks identical to a real bad-
 * credential response and would lead clients (and humans) to retry with a
 * fresh nonce that ALSO can't be consumed — same outage, same 401, opaque
 * failure mode. 503 telegraphs "infra issue, retry later".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.DATABASE_URL ??= "postgresql://stub:stub@localhost:1/stub";
process.env.SESSION_SECRET ??= "x".repeat(32);

const consumeNonceMock = vi.fn();

vi.mock("@/lib/auth/nonce-store", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/auth/nonce-store")>();
  return {
    ...orig, // keep real NonceStoreUnavailableError so `instanceof` works
    consumeNonce: consumeNonceMock,
  };
});

vi.mock("@/lib/auth/siws", () => ({
  parseSiwsMessage: vi.fn(() => ({
    domain: "example.test",
    address: "11111111111111111111111111111111",
    nonce: "abc123",
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + 60_000).toISOString(),
  })),
  verifySiwsSignature: vi.fn(() => true),
  isValidSolanaAddress: vi.fn(() => true),
}));

// iron-session: minimal mock so getSession().destroy()/save() don't blow up.
vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(async () => ({
    address: undefined,
    createdAt: undefined,
    destroy: vi.fn(),
    save: vi.fn(),
  })),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

const { NonceStoreUnavailableError } = await import("@/lib/auth/nonce-store");
const { POST } = await import("./route");

function buildRequest(): Request {
  return new Request("http://example.test/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://example.test",
    },
    body: JSON.stringify({
      message: "ignored-by-parser-mock",
      signature: "ignored-by-verify-mock",
    }),
  });
}

describe("POST /api/auth/login — nonce store fail-closed wiring", () => {
  beforeEach(() => {
    consumeNonceMock.mockReset();
  });

  it("returns 503 when consumeNonce throws NonceStoreUnavailableError", async () => {
    consumeNonceMock.mockRejectedValue(
      new NonceStoreUnavailableError(new Error("PG outage")),
    );

    const res = await POST(buildRequest());

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/temporarily unavailable/i);
  });

  it("returns 401 (NOT 503) when consumeNonce returns false (nonce simply not found)", async () => {
    // Sanity check: a regular "nonce expired or already used" path must
    // still surface as 401 — otherwise we'd be telling every bad-nonce
    // client to retry forever.
    consumeNonceMock.mockResolvedValue(false);

    const res = await POST(buildRequest());

    expect(res.status).toBe(401);
  });

  it("returns 500 for other unexpected errors (not collapsed into 503)", async () => {
    consumeNonceMock.mockRejectedValue(new Error("some other failure"));

    const res = await POST(buildRequest());

    expect(res.status).toBe(500);
  });
});
