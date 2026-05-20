/**
 * /api/solana-rpc — bulk-method amplification guard (C3 audit item).
 *
 * The proxy whitelists `getMultipleAccounts` and `getTokenAccountsByOwner`,
 * both of which fan out to many underlying RPC lookups per single client
 * call. Before this fix a logged-in user could send one HTTP request that
 * caused thousands of paid RPC calls upstream — classic amplification DoS
 * against the project's paid Helius/Triton quota.
 *
 * Two-part guard:
 *   1. Cap `getMultipleAccounts` to ≤ 25 pubkeys.
 *   2. Restrict `getTokenAccountsByOwner` filter to `{ mint: <string> }` or
 *      `{ programId: TOKEN_PROGRAM_ID }`. Anything else (open scan, custom
 *      program, missing filter) → 400.
 * Plus: bulk methods route through a tighter `rpc:h:` bucket
 * (RATE_LIMITS.rpcHeavy, half of rpcRead).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

process.env.DATABASE_URL ??= "postgresql://stub:stub@localhost:1/stub";
process.env.SESSION_SECRET ??= "x".repeat(32);
process.env.SOLANA_RPC_URL ??= "http://stub.invalid/rpc";

const getAuthAddressMock = vi.fn();
const safeRateLimitMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  getAuthAddress: getAuthAddressMock,
}));

vi.mock("@/lib/ratelimit", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/ratelimit")>();
  return {
    ...orig,
    safeRateLimit: safeRateLimitMock,
  };
});

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

const { POST } = await import("./route");

// Replace global fetch (upstream RPC call) for the entire test file.
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  getAuthAddressMock.mockReset();
  safeRateLimitMock.mockReset();
  fetchMock.mockReset();

  getAuthAddressMock.mockResolvedValue("FakeWalletAddress1111111111111111111111111111");
  safeRateLimitMock.mockResolvedValue({ success: true, remaining: 50 });
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
});

function buildReq(body: unknown): NextRequest {
  return new NextRequest("http://example.test/api/solana-rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const PUBKEY = "11111111111111111111111111111111";

describe("POST /api/solana-rpc — getMultipleAccounts cap", () => {
  it("forwards when pubkey array length ≤ 25", async () => {
    const params = [Array.from({ length: 25 }, () => PUBKEY)];

    const res = await POST(
      buildReq({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params }),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects when pubkey array length > 25 (amplification cap)", async () => {
    const params = [Array.from({ length: 26 }, () => PUBKEY)];

    const res = await POST(
      buildReq({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params }),
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error.message).toMatch(/25/);
  });

  it("rejects when params[0] is not an array", async () => {
    const res = await POST(
      buildReq({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [PUBKEY] }),
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty pubkey array (no useful work, just budget burn)", async () => {
    const res = await POST(
      buildReq({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [[]] }),
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/solana-rpc — getTokenAccountsByOwner filter whitelist", () => {
  const owner = PUBKEY;
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  it("forwards { mint: <string> } filter (DepositWithdrawModal happy path)", async () => {
    const res = await POST(
      buildReq({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [owner, { mint: USDC }, { encoding: "jsonParsed" }],
      }),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("forwards { programId: TOKEN_PROGRAM_ID } filter", async () => {
    const res = await POST(
      buildReq({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [owner, { programId: TOKEN_PROGRAM_ID }],
      }),
    );

    expect(res.status).toBe(200);
  });

  it("rejects { programId: <non-token-program> } (would open arbitrary scan)", async () => {
    const res = await POST(
      buildReq({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [owner, { programId: "SomeOtherProgram11111111111111111111111111" }],
      }),
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when filter object is missing", async () => {
    const res = await POST(
      buildReq({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [owner],
      }),
    );

    expect(res.status).toBe(400);
  });

  it("rejects multi-key filter object", async () => {
    const res = await POST(
      buildReq({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [owner, { mint: USDC, programId: TOKEN_PROGRAM_ID }],
      }),
    );

    expect(res.status).toBe(400);
  });

  it("rejects non-string owner", async () => {
    const res = await POST(
      buildReq({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [123, { mint: USDC }],
      }),
    );

    expect(res.status).toBe(400);
  });
});

describe("POST /api/solana-rpc — bulk methods use rpc:h: bucket", () => {
  it("getMultipleAccounts hits the heavy bucket (rpc:h:), not the read bucket", async () => {
    await POST(
      buildReq({
        jsonrpc: "2.0",
        id: 1,
        method: "getMultipleAccounts",
        params: [[PUBKEY]],
      }),
    );

    expect(safeRateLimitMock).toHaveBeenCalledOnce();
    const [, prefix, max] = safeRateLimitMock.mock.calls[0];
    expect(prefix).toBe("rpc:h:");
    expect(max).toBe(60); // RATE_LIMITS.rpcHeavy
  });

  it("plain getAccountInfo still goes through the rpc:r: bucket", async () => {
    await POST(
      buildReq({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [PUBKEY] }),
    );

    const [, prefix, max] = safeRateLimitMock.mock.calls[0];
    expect(prefix).toBe("rpc:r:");
    expect(max).toBe(120); // RATE_LIMITS.rpcRead
  });

  it("sendTransaction still uses the rpc:w: write bucket", async () => {
    await POST(
      buildReq({
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: ["dGVzdA=="],
      }),
    );

    const [, prefix, max] = safeRateLimitMock.mock.calls[0];
    expect(prefix).toBe("rpc:w:");
    expect(max).toBe(10); // RATE_LIMITS.rpcWrite
  });
});
