import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getAuthAddress } from "@/lib/auth/session";
import { RATE_LIMITS, safeRateLimit } from "@/lib/ratelimit";

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

/**
 * POST /api/solana-rpc — Secure Solana JSON-RPC proxy.
 *
 * All client-side Solana interactions go through this endpoint.
 * The browser never contacts Solana directly — RPC keys stay on the server.
 *
 * Security layers:
 * 1. Authentication — only signed-in users (iron-session cookie)
 * 2. Method whitelist — only safe read methods + sendTransaction
 * 3. Rate limiting — Postgres-backed counters with in-memory last-resort
 * 4. Request validation — strict JSON-RPC format check
 * 5. Response sanitization — strip internal error details
 * 6. No batch requests — prevents whitelist bypass via batched calls
 * 7. Sentry monitoring — all errors tracked
 */

// ─── Method Whitelist ───────────────────────────────────────────
const READ_METHODS = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getEpochInfo",
  "getFeeForMessage",
  "getGenesisHash",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getRecentBlockhash",
  "getSignatureStatuses",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTransaction",
  "getVersion",
]);

const WRITE_METHODS = new Set([
  "sendTransaction",
  "simulateTransaction",
]);

/**
 * Bulk/fan-out reads. One client call here amplifies into many underlying
 * RPC lookups upstream, so we (a) cap the input size and (b) bucket them
 * against a tighter rate-limit tier (`rpc:h`) than ordinary reads.
 */
const BULK_METHODS = new Set([
  "getMultipleAccounts",
  "getTokenAccountsByOwner",
]);

/**
 * SPL Token program ID. Used as the only whitelisted `programId` filter
 * for getTokenAccountsByOwner — anything else would let a caller scan
 * arbitrary program ownership and explode the upstream cost.
 */
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** Hard cap on how many pubkeys getMultipleAccounts may fan out to. */
const GMA_MAX_KEYS = 25;

const ALL_ALLOWED = new Set([...READ_METHODS, ...WRITE_METHODS]);

// ─── Rate Limit Helper ─────────────────────────────────────────

type RateTier = "read" | "heavy" | "write";

function tierForMethod(method: string): RateTier {
  if (WRITE_METHODS.has(method)) return "write";
  if (BULK_METHODS.has(method)) return "heavy";
  return "read";
}

async function checkRate(
  userKey: string,
  tier: RateTier,
): Promise<{ success: boolean; remaining: number }> {
  const prefix =
    tier === "write" ? "rpc:w:" : tier === "heavy" ? "rpc:h:" : "rpc:r:";
  const max =
    tier === "write"
      ? RATE_LIMITS.rpcWrite
      : tier === "heavy"
        ? RATE_LIMITS.rpcHeavy
        : RATE_LIMITS.rpcRead;
  return safeRateLimit(userKey, prefix, max);
}

// ─── Param validation for bulk fan-out methods ─────────────────

interface ParamCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Reject calls that would cause unbounded upstream amplification.
 *
 * - getMultipleAccounts: client passes `params[0]` as an array of base58
 *   pubkeys; each one becomes a real account lookup at the RPC layer. We
 *   cap the array length so a logged-in attacker can't blast a single
 *   request that fans out to thousands of paid lookups.
 *
 * - getTokenAccountsByOwner: the upstream RPC accepts either
 *   `{ mint }` (cheap — single mint scoping) or `{ programId }` (can be
 *   expensive — wildcard scan over a program's accounts). We allow
 *   `{ mint: <string> }` and `{ programId: TOKEN_PROGRAM_ID }` only; any
 *   other filter shape (open scan, custom program, multi-key object) is
 *   rejected. Existing app callers use `{ mint: USDC_MINT }`.
 */
function validateBulkParams(method: string, params: unknown): ParamCheck {
  if (!Array.isArray(params)) {
    return { ok: false, reason: "params must be a positional array" };
  }

  if (method === "getMultipleAccounts") {
    const pubkeys = params[0];
    if (!Array.isArray(pubkeys)) {
      return { ok: false, reason: "getMultipleAccounts requires params[0] to be an array" };
    }
    if (pubkeys.length === 0) {
      return { ok: false, reason: "getMultipleAccounts requires at least 1 pubkey" };
    }
    if (pubkeys.length > GMA_MAX_KEYS) {
      return {
        ok: false,
        reason: `getMultipleAccounts allows at most ${GMA_MAX_KEYS} pubkeys per call`,
      };
    }
    if (!pubkeys.every((k) => typeof k === "string")) {
      return { ok: false, reason: "getMultipleAccounts pubkeys must be strings" };
    }
    return { ok: true };
  }

  if (method === "getTokenAccountsByOwner") {
    const owner = params[0];
    const filter = params[1];
    if (typeof owner !== "string") {
      return { ok: false, reason: "getTokenAccountsByOwner requires params[0] owner (string)" };
    }
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
      return { ok: false, reason: "getTokenAccountsByOwner requires a filter object as params[1]" };
    }
    const keys = Object.keys(filter as Record<string, unknown>);
    if (keys.length !== 1) {
      return { ok: false, reason: "filter must have exactly one of { mint } or { programId }" };
    }
    const filterObj = filter as { mint?: unknown; programId?: unknown };
    if ("mint" in filterObj && typeof filterObj.mint === "string") {
      return { ok: true };
    }
    if ("programId" in filterObj && filterObj.programId === TOKEN_PROGRAM_ID) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: "filter must be { mint: <string> } or { programId: TOKEN_PROGRAM_ID }",
    };
  }

  return { ok: true };
}

// ─── Route Handler ──────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    // 1. Auth — only signed-in users
    const address = await getAuthAddress();
    if (!address) {
      return NextResponse.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Authentication required" }, id: null },
        { status: 401 }
      );
    }

    // 2. Parse and validate JSON-RPC request
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null },
        { status: 400 }
      );
    }

    // Block batch requests (arrays) — prevents whitelist bypass
    if (Array.isArray(body)) {
      return NextResponse.json(
        { jsonrpc: "2.0", error: { code: -32600, message: "Batch requests not supported" }, id: null },
        { status: 400 }
      );
    }

    if (!body || typeof body.method !== "string") {
      return NextResponse.json(
        { jsonrpc: "2.0", error: { code: -32600, message: "Invalid request" }, id: null },
        { status: 400 }
      );
    }

    const method = body.method;
    const requestId = body.id ?? null;

    // 3. Method whitelist
    if (!ALL_ALLOWED.has(method)) {
      Sentry.captureMessage(`Blocked RPC method: ${method}`, {
        level: "warning",
        extra: { user: address.slice(0, 8), method },
      });
      return NextResponse.json(
        { jsonrpc: "2.0", error: { code: -32601, message: "Method not allowed" }, id: requestId },
        { status: 403 }
      );
    }

    // 4. Param validation for amplification-prone bulk methods. Must run
    // before the rate-limit check so a malformed bulk request gets a
    // clean 400 and doesn't burn the user's budget.
    if (BULK_METHODS.has(method)) {
      const check = validateBulkParams(method, body.params);
      if (!check.ok) {
        Sentry.captureMessage(`Blocked bulk RPC params: ${method}`, {
          level: "warning",
          extra: { user: address.slice(0, 8), method, reason: check.reason },
        });
        return NextResponse.json(
          {
            jsonrpc: "2.0",
            error: { code: -32602, message: check.reason ?? "Invalid params" },
            id: requestId,
          },
          { status: 400 },
        );
      }
    }

    // 5. Rate limit per user (wallet address). Bulk methods go in a
    // tighter `rpc:h:` bucket — see RATE_LIMITS.rpcHeavy.
    const tier = tierForMethod(method);
    const { success: allowed, remaining } = await checkRate(address, tier);
    const isWrite = tier === "write";

    if (!allowed) {
      Sentry.captureMessage("RPC rate limit exceeded", {
        level: "warning",
        extra: { user: address.slice(0, 8), method, isWrite },
      });
      const res = NextResponse.json(
        { jsonrpc: "2.0", error: { code: -32005, message: "Rate limit exceeded. Please wait." }, id: requestId },
        { status: 429 }
      );
      res.headers.set("Retry-After", "60");
      res.headers.set("X-RateLimit-Remaining", "0");
      return res;
    }

    // 6. Forward to Solana RPC
    const rpcRes = await fetch(SOLANA_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method,
        params: Array.isArray(body.params) ? body.params : [],
      }),
    });

    if (!rpcRes.ok) {
      Sentry.captureMessage(`RPC upstream error: ${rpcRes.status}`, {
        level: "error",
        extra: { user: address.slice(0, 8), method, status: rpcRes.status },
      });
      return NextResponse.json(
        { jsonrpc: "2.0", error: { code: -32603, message: "RPC temporarily unavailable" }, id: requestId },
        { status: 502 }
      );
    }

    let data: unknown;
    try {
      data = await rpcRes.json();
    } catch {
      return NextResponse.json(
        { jsonrpc: "2.0", error: { code: -32603, message: "Invalid RPC response" }, id: requestId },
        { status: 502 }
      );
    }

    // 7. Return with rate limit headers
    const res = NextResponse.json(data);
    res.headers.set("X-RateLimit-Remaining", String(remaining));
    return res;
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "solana-rpc" },
    });
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32603, message: "Internal proxy error" }, id: null },
      { status: 500 }
    );
  }
}
