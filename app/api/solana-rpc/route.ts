import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getAuthAddress } from "@/lib/auth/session";
import {
  rpcReadLimiter,
  rpcWriteLimiter,
  memRateLimit,
  memCleanup,
} from "@/lib/ratelimit";

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
 * 3. Rate limiting — Upstash Redis (production) or in-memory fallback (dev)
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

const ALL_ALLOWED = new Set([...READ_METHODS, ...WRITE_METHODS]);

// ─── Rate Limit Helper ─────────────────────────────────────────

async function checkRate(
  userKey: string,
  isWrite: boolean
): Promise<{ success: boolean; remaining: number }> {
  const limiter = isWrite ? rpcWriteLimiter : rpcReadLimiter;

  // Upstash available → use it
  if (limiter) {
    const result = await limiter.limit(userKey);
    return { success: result.success, remaining: result.remaining };
  }

  // Fallback: in-memory (dev / no Upstash configured)
  memCleanup();
  const prefix = isWrite ? "rpc:w:" : "rpc:r:";
  const limit = isWrite ? 10 : 120;
  return memRateLimit(prefix + userKey, limit);
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

    // 4. Rate limit per user (wallet address)
    const isWrite = WRITE_METHODS.has(method);
    const { success: allowed, remaining } = await checkRate(address, isWrite);

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

    // 5. Forward to Solana RPC
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

    // 6. Return with rate limit headers
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
