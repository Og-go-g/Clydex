"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import type { NordUser } from "@n1xyz/nord-ts";

type ExecStatus = "idle" | "signing" | "submitting" | "verifying" | "confirmed" | "error";

export type PositionData = Record<string, unknown> | null;

/** Shape of position/order objects from /api/account */
interface AccountPosition {
  symbol?: string;
  marketSymbol?: string;
  baseAsset?: string;
  markPrice?: number;
  liqPrice?: number;
  usedMargin?: number;
  maxLeverage?: number;
  perp?: {
    baseSize?: number;
    isLong?: boolean;
    price?: number;
    sizePricePnl?: number;
    fundingPnl?: number;
  };
}

interface AccountOrder {
  symbol?: string;
  marketSymbol?: string;
}

interface OrderExecState {
  status: ExecStatus;
  error: string | null;
  txHash: string | null;
}

interface OrderData {
  market: string;
  side: "Long" | "Short";
  size: number;
  leverage: number;
  estimatedEntryPrice: number;
  orderType?: string;
  price?: number;
  previewId?: string;
  slippage?: number;
}

// ─── Consumed preview IDs (prevents double-execution across re-renders) ──
// Also persisted to localStorage so cards stay deactivated after page reload
const LS_KEY = "clydex_consumed_previews";
function loadConsumed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}
function saveConsumed(s: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    // Keep only last 200 to prevent unbounded growth
    const arr = [...s].slice(-200);
    localStorage.setItem(LS_KEY, JSON.stringify(arr));
  } catch { /* quota exceeded — ignore */ }
}
const consumedPreviews = loadConsumed();

/** Per-market close lock — prevents double-close when no previewId exists */
const closingMarkets = new Set<string>();

/** Check if a preview was already consumed (for card deactivation) */
export function isPreviewConsumed(previewId: string): boolean {
  return consumedPreviews.has(previewId);
}

// ─── Failed previews (consumed but SDK execution failed) ──
const LS_FAILED_KEY = "clydex_failed_previews";
function loadFailed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(LS_FAILED_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}
function saveFailed(s: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    const arr = [...s].slice(-200);
    localStorage.setItem(LS_FAILED_KEY, JSON.stringify(arr));
  } catch { /* quota exceeded */ }
}
const failedPreviews = loadFailed();

export function markPreviewFailed(previewId: string) {
  failedPreviews.add(previewId);
  saveFailed(failedPreviews);
}

export function isPreviewFailed(previewId: string): boolean {
  return failedPreviews.has(previewId);
}

// ─── Confirmed positions cache (module-level, survives re-renders) ──
export const confirmedPositionsCache = new Map<string, PositionData>();

/** Get confirmed position by previewId */
export function getConfirmedPosition(previewId: string): PositionData {
  return confirmedPositionsCache.get(previewId) ?? null;
}

// ─── Cached NordUser session (module-level singleton) ────────────
// Created once on first trade, reused for all subsequent trades.
// Wallet only pops up ONCE for session creation.
// Session keypair signs all orders silently — same UX as 01 Exchange.
// Session auto-expires after 30 minutes of inactivity.
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SESSION_LIFETIME_MS = 4 * 60 * 60 * 1000; // 4 hours absolute max
let cachedUser: NordUser | null = null;
let cachedWalletAddress: string | null = null;
// Use performance.now() for monotonic timing — immune to system clock changes
let sessionCreatedAtMono = 0;
let lastActivityMono = 0;
let sessionTimeoutId: ReturnType<typeof setTimeout> | null = null;

export async function getOrCreateUser(params: {
  walletPubkey: PublicKey;
  signMessageFn: (message: Uint8Array) => Promise<Uint8Array>;
  signTransactionFn: (tx: import("@solana/web3.js").Transaction) => Promise<import("@solana/web3.js").Transaction>;
}): Promise<NordUser> {
  const address = params.walletPubkey.toBase58();

  // Reuse cached session if same wallet and not expired
  if (cachedUser && cachedWalletAddress === address) {
    const now = performance.now();
    const idleTime = now - lastActivityMono;
    const totalLifetime = now - sessionCreatedAtMono;

    if (idleTime < SESSION_TIMEOUT_MS && totalLifetime < MAX_SESSION_LIFETIME_MS) {
      // Reset inactivity timeout on activity
      lastActivityMono = now;
      resetSessionTimeout();

      // Lazy hydrate: if the session was created before the first deposit
      // was indexed by the engine, accountIds is still empty. Re-fetch
      // before returning so trading actions don't trip "Account ID is
      // undefined". No wallet popup — pure GET /user/{pubkey}.
      if (!cachedUser.accountIds || cachedUser.accountIds.length === 0) {
        const { hydrateAccountIds } = await import("@/lib/n1/user-client");
        try { await hydrateAccountIds(cachedUser); } catch { /* keep cached user */ }
      }
      return cachedUser;
    }
    // Session expired (idle or max lifetime) — invalidate
    invalidateSession();
  }

  // Create new session. Pre-check whether the engine knows this wallet —
  // if not, skip refreshSession to avoid a wasted signMessage popup
  // (engine would reject with USER_NOT_FOUND anyway). Failing the
  // pre-check is non-fatal: createNordUser tolerates USER_NOT_FOUND on its
  // own as defence-in-depth.
  let skipSession = false;
  try {
    const res = await fetch("/api/collateral");
    if (res.ok) {
      const data = await res.json();
      if (data?.exists === false) skipSession = true;
    }
  } catch {
    // Non-critical
  }
  const { createNordUser } = await import("@/lib/n1/user-client");
  cachedUser = await createNordUser({ ...params, skipSession });
  cachedWalletAddress = address;
  sessionCreatedAtMono = performance.now();
  lastActivityMono = sessionCreatedAtMono;
  resetSessionTimeout();
  return cachedUser;
}

function resetSessionTimeout() {
  if (sessionTimeoutId) clearTimeout(sessionTimeoutId);
  sessionTimeoutId = setTimeout(() => {
    invalidateSession();
  }, SESSION_TIMEOUT_MS);
}

// Invalidate cache (on wallet disconnect, session error, or timeout)
export function invalidateSession() {
  cachedUser = null;
  cachedWalletAddress = null;
  sessionCreatedAtMono = 0;
  lastActivityMono = 0;
  if (sessionTimeoutId) { clearTimeout(sessionTimeoutId); sessionTimeoutId = null; }
}

/**
 * Pre-create NordUser session so first trade is instant (no wallet popup).
 * Call this when user signs in — session will be ready when they trade.
 */
export async function ensureSession(params: {
  walletPubkey: PublicKey;
  signMessageFn: (message: Uint8Array) => Promise<Uint8Array>;
  signTransactionFn: (tx: import("@solana/web3.js").Transaction) => Promise<import("@solana/web3.js").Transaction>;
}): Promise<void> {
  await getOrCreateUser(params);
}

/**
 * Verify that a trade actually executed on-chain by checking the account state.
 * Retries up to 5 times with 3s delay to allow for block confirmation on illiquid pairs.
 */
async function verifyExecution(
  marketSymbol: string,
  kind: "position" | "order" | "close",
  maxRetries = 5,
  delayMs = 3000
): Promise<boolean> {
  const MAX_RETRIES = maxRetries;
  const DELAY_MS = delayMs;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await new Promise((r) => setTimeout(r, DELAY_MS));
    try {
      // Add cache-bust param to get fresh data
      const res = await fetch(`/api/account?_t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) continue;
      const data = await res.json();
      const positions = data.positions ?? [];
      const orders = data.orders ?? data.openOrders ?? [];

      // Normalize symbol: "SUIUSD" -> match against position/order symbol
      const sym = marketSymbol.replace(/\//, "").toUpperCase();

      // Match strictly on the normalised symbol. A startsWith fallback would
      // false-positive between markets that share a prefix (e.g. SOL vs SOLO,
      // BTC vs BTCBEAR), confirming a phantom fill the user never made.
      if (kind === "position") {
        const found = (positions as AccountPosition[]).some((p) => {
          const pSym = (p.symbol ?? p.marketSymbol ?? "").toUpperCase();
          const hasSize = Math.abs(p.perp?.baseSize ?? 0) > 1e-12;
          return pSym === sym && hasSize;
        });
        if (found) return true;
      } else if (kind === "order") {
        // Limit order: check if open order exists OR if it filled instantly into a position
        const orderFound = (orders as AccountOrder[]).some((o) =>
          o.symbol === sym || o.marketSymbol === sym
        );
        if (orderFound) return true;
        // Instant fill: order went straight to position (price was very close to market)
        const posFound = (positions as AccountPosition[]).some((p) => {
          const pSym = (p.symbol ?? p.marketSymbol ?? "").toUpperCase();
          const hasSize = Math.abs(p.perp?.baseSize ?? 0) > 1e-12;
          return pSym === sym && hasSize;
        });
        if (posFound) return true;
      } else if (kind === "close") {
        // Close: check if position for this market is gone or reduced
        const found = (positions as AccountPosition[]).some((p) =>
          (p.symbol === sym || p.marketSymbol === sym) && Math.abs(p.perp?.baseSize ?? 0) > 1e-12
        );
        if (!found) return true; // position gone = close successful
      }
    } catch {
      // Network error — retry
    }
  }
  return false;
}

/**
 * After verification confirms, fetch the actual position data for display.
 */
async function fetchConfirmedPosition(marketSymbol: string): Promise<PositionData> {
  try {
    const res = await fetch(`/api/account?_t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    const sym = marketSymbol.replace(/\//, "").toUpperCase();
    const pos = ((data.positions ?? []) as AccountPosition[]).find((p) => {
      const pSym = (p.symbol ?? p.marketSymbol ?? "").toUpperCase();
      return pSym === sym && Math.abs(p.perp?.baseSize ?? 0) > 1e-12;
    });
    if (!pos) return null;
    return {
      symbol: pos.symbol ?? sym,
      baseAsset: pos.baseAsset ?? sym.replace(/USD$/, ""),
      side: pos.perp?.isLong ? "Long" : "Short",
      size: pos.perp?.baseSize ?? 0,
      absSize: Math.abs(pos.perp?.baseSize ?? 0),
      entryPrice: pos.perp?.price ?? 0,
      markPrice: pos.markPrice ?? pos.perp?.price ?? 0,
      positionValue: Math.abs(pos.perp?.baseSize ?? 0) * (pos.markPrice ?? pos.perp?.price ?? 0),
      unrealizedPnl: pos.perp?.sizePricePnl ?? 0,
      fundingPnl: pos.perp?.fundingPnl ?? 0,
      liqPrice: pos.liqPrice ?? 0,
      usedMargin: pos.usedMargin ?? 0,
      maxLeverage: pos.maxLeverage ?? 1,
      pnlPercent: 0,
    };
  } catch {
    return null;
  }
}

/**
 * Hook for executing trading operations via the Nord SDK.
 *
 * Session is created ONCE — wallet signs session creation.
 * All subsequent trades use the cached session keypair (no wallet popup).
 * Same UX as 01 Exchange: sign once, trade freely.
 *
 * Security:
 * - Ephemeral session keypair (in-memory only, never persisted)
 * - Session cached per wallet address
 * - If session expires, auto-recreates (one wallet popup)
 * - Abort guard prevents double-execution
 */
export function useOrderExecution() {
  const { publicKey, signMessage, signTransaction } = useSolanaWallet();
  const [state, setState] = useState<OrderExecState>({
    status: "idle",
    error: null,
    txHash: null,
  });
  const executingRef = useRef(false);

  // Invalidate session when wallet disconnects or changes
  const prevPubkeyRef = useRef(publicKey?.toBase58() ?? null);
  useEffect(() => {
    const currentAddr = publicKey?.toBase58() ?? null;
    if (prevPubkeyRef.current && currentAddr !== prevPubkeyRef.current) {
      invalidateSession();
    }
    prevPubkeyRef.current = currentAddr;
  }, [publicKey]);

  // Helper: get user, execute fn, handle session expiry with retry
  const withUser = useCallback(
    async <T>(fn: (user: NordUser) => Promise<T>, actionName: string): Promise<T> => {
      const safePubkey = new PublicKey(publicKey!.toBase58());
      let user: NordUser;
      try {
        user = await getOrCreateUser({
          walletPubkey: safePubkey,
          signMessageFn: signMessage!,
          signTransactionFn: signTransaction as (tx: import("@solana/web3.js").Transaction) => Promise<import("@solana/web3.js").Transaction>,
        });
      } catch (sessionErr) {
        // Session creation failed — clear cached state to prevent reusing broken session
        invalidateSession();
        throw sessionErr;
      }

      try {
        return await fn(user);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "";
        // Session-expiry retry: narrow to SDK's actual session errors. Avoid
        // matching "invalid" alone — it also matches "Invalid market",
        // "Invalid order size", "invalid leverage", which would tear down a
        // good session, prompt a wallet popup, and re-submit the same bad
        // order. Real SDK session error: "Invalid or empty session ID.
        // Please create or refresh your session." Engine error variants:
        // "session expired", "session not found", "Invalid session".
        const isSessionError =
          /invalid\s+or\s+empty\s+session\s+id/i.test(msg) ||
          /session\s+(expired|not\s+found|invalid|revoked)/i.test(msg) ||
          /invalid\s+session/i.test(msg) ||
          /please\s+(create|refresh)\s+your\s+session/i.test(msg);
        if (isSessionError) {
          invalidateSession();
          const freshUser = await getOrCreateUser({
            walletPubkey: safePubkey,
            signMessageFn: signMessage!,
            signTransactionFn: signTransaction as (tx: import("@solana/web3.js").Transaction) => Promise<import("@solana/web3.js").Transaction>,
          });
          return await fn(freshUser);
        }
        throw err;
      }
    },
    [publicKey, signMessage, signTransaction]
  );

  const executeOrder = useCallback(
    async (orderData: OrderData) => {
      if (executingRef.current) return;
      // Prevent double-execution of same preview across re-renders
      if (orderData.previewId && consumedPreviews.has(orderData.previewId)) {
        setState({ status: "error", error: "This order was already submitted", txHash: null });
        return;
      }
      if (!publicKey || !signMessage || !signTransaction) {
        setState({ status: "error", error: "Wallet not connected", txHash: null });
        return;
      }
      // Client-side validation
      if (!orderData.size || orderData.size <= 0 || !isFinite(orderData.size)) {
        setState({ status: "error", error: "Invalid order size", txHash: null });
        return;
      }
      if (!orderData.market) {
        setState({ status: "error", error: "Market not specified", txHash: null });
        return;
      }

      executingRef.current = true;
      setState({ status: "signing", error: null, txHash: null });

      try {
        // Step 1: Consume preview server-side (atomic single-use check)
        // Client-side consumed marking happens AFTER server confirmation
        // Use server-validated params (not DOM data) to prevent client-side tampering
        let validatedParams = {
          symbol: orderData.market,
          side: orderData.side as "Long" | "Short",
          size: orderData.size,
          leverage: orderData.leverage,
          price: orderData.price,
          orderType: (orderData.orderType as "market" | "limit") ?? "market",
          slippage: orderData.slippage,
        };

        if (orderData.previewId) {
          const consumeRes = await fetch("/api/order", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "execute", previewId: orderData.previewId }),
          });
          const serverData = await consumeRes.json().catch(() => ({}));
          if (!consumeRes.ok) {
            throw new Error(serverData.error || "Preview expired or already used. Please create a new order.");
          }
          // Server confirmed consumption — NOW mark client-side
          consumedPreviews.add(orderData.previewId);
          saveConsumed(consumedPreviews);
          // Use server-validated preview data instead of client-side DOM data
          if (serverData) {
            const p = serverData;
            validatedParams = {
              symbol: p.market ?? validatedParams.symbol,
              side: p.side ?? validatedParams.side,
              size: typeof p.size === "number" ? p.size : validatedParams.size,
              leverage: typeof p.leverage === "number" ? p.leverage : validatedParams.leverage,
              price: typeof p.price === "number" ? p.price : validatedParams.price,
              orderType: p.orderType ?? validatedParams.orderType,
              slippage: validatedParams.slippage,
            };
          }
        }

        // Step 2: Execute via SDK using server-validated parameters
        const { placeOrder } = await import("@/lib/n1/user-client");

        setState({ status: "submitting", error: null, txHash: null });

        const result = await withUser(
          (user) => placeOrder(user, validatedParams),
          "placeOrder"
        );

        const raw = result as Record<string, unknown>;
        const txHash = typeof result === "string"
          ? result
          : String(raw?.txHash ?? raw?.signature ?? raw?.tx ?? "submitted");

        // Step 3: Verify the position/order actually appeared on-chain
        setState({ status: "verifying", error: null, txHash });
        const isMarket = (orderData.orderType ?? "market") === "market";
        const kind = isMarket ? "position" as const : "order" as const;

        // First attempt: 5 tries × 3s = 15s
        let verified = await verifyExecution(orderData.market, kind, 5, 3000);
        if (!verified) {
          // Second attempt: 5 more tries × 5s = 25s (illiquid pairs)
          verified = await verifyExecution(orderData.market, kind, 5, 5000);
        }
        if (verified && orderData.previewId) {
          const posData = await fetchConfirmedPosition(orderData.market);
          if (posData) {
            confirmedPositionsCache.set(orderData.previewId, posData);
          }
          setState({ status: "confirmed", error: null, txHash });
        } else if (verified) {
          setState({ status: "confirmed", error: null, txHash });
        } else {
          // Verification window expired (40s) but the tx WAS submitted —
          // engine indexing on illiquid pairs can lag. We must NOT show
          // "error" here: the preview is already consumed server-side, and
          // a retry would create a fresh preview that double-executes when
          // the original lands. Treat as confirmed-pending; the Portfolio
          // surfaces the position once the engine catches up.
          setState({ status: "confirmed", error: null, txHash });
        }
      } catch (err: unknown) {
        if (orderData.previewId) markPreviewFailed(orderData.previewId);
        handleError(err, "placeOrder", orderData.market, setState);
      } finally {
        executingRef.current = false;
      }
    },
    [publicKey, signMessage, signTransaction, withUser]
  );

  const executeClose = useCallback(
    async (data: { market: string; side: "Long" | "Short"; size: number; previewId?: string; slippage?: number }) => {
      if (executingRef.current) return;
      // Prevent double-close of same preview
      if (data.previewId && consumedPreviews.has(data.previewId)) {
        setState({ status: "error", error: "This close was already submitted", txHash: null });
        return;
      }
      // Per-tab fast-path lock — prevents racing within one tab while the
      // server-side lock (below) is being acquired. Authoritative lock is
      // server-side via /api/order action=close-acquire.
      const closeKey = `${data.market}:${data.side}`;
      if (!data.previewId && closingMarkets.has(closeKey)) {
        setState({ status: "error", error: "Close already in progress for this position", txHash: null });
        return;
      }
      if (!publicKey || !signMessage || !signTransaction) {
        setState({ status: "error", error: "Wallet not connected", txHash: null });
        return;
      }

      executingRef.current = true;
      if (!data.previewId) closingMarkets.add(closeKey);
      setState({ status: "signing", error: null, txHash: null });

      // Server-side close-lock — authoritative across tabs and devices.
      // Acquired before any wallet popup so we don't ask the user to sign
      // a close that'll race with another tab's already-in-flight close.
      let serverLockAcquired = false;
      try {
        const lockRes = await fetch("/api/order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "close-acquire", symbol: data.market, side: data.side }),
        });
        if (lockRes.status === 409) {
          setState({ status: "error", error: "Close already in progress for this position", txHash: null });
          executingRef.current = false;
          closingMarkets.delete(closeKey);
          return;
        }
        serverLockAcquired = lockRes.ok;
      } catch {
        // Network/PG outage — proceed without server lock; per-tab guard still in place.
      }

      try {
        // Step 1: Consume preview server-side (only if previewId exists from chat flow)
        // Close from confirmed position card has no previewId — skip consume
        if (data.previewId) {
          const consumeRes = await fetch("/api/order", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "execute", previewId: data.previewId }),
          });
          if (!consumeRes.ok) {
            const err = await consumeRes.json().catch(() => ({}));
            throw new Error(err.error || "Preview expired or already used.");
          }
          // Server confirmed consumption — NOW mark client-side
          consumedPreviews.add(data.previewId);
          saveConsumed(consumedPreviews);
        }

        // Step 2: Execute close via SDK
        const { closePosition } = await import("@/lib/n1/user-client");

        setState({ status: "submitting", error: null, txHash: null });

        const result = await withUser(
          (user) => closePosition(user, {
            symbol: data.market,
            side: data.side,
            size: data.size,
            slippage: data.slippage,
          }),
          "closePosition"
        );

        const raw = result as Record<string, unknown>;
        const txHash = typeof result === "string"
          ? result
          : String(raw?.txHash ?? raw?.signature ?? raw?.tx ?? "submitted");

        // Step 3: Verify the position was actually closed
        setState({ status: "verifying", error: null, txHash });
        const verified = await verifyExecution(data.market, "close");
        if (verified) {
          setState({ status: "confirmed", error: null, txHash });
        } else {
          setState({ status: "error", error: "Transaction submitted but position still appears open. The close may have been rejected.", txHash });
        }
      } catch (err: unknown) {
        handleError(err, "closePosition", data.market, setState);
      } finally {
        executingRef.current = false;
        // Release per-tab + server-side close-locks. Server release is
        // best-effort — the lock has a 30s TTL so a missed release just
        // delays the next attempt slightly.
        const ck = `${data.market}:${data.side}`;
        closingMarkets.delete(ck);
        if (serverLockAcquired) {
          void fetch("/api/order", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "close-release", symbol: data.market, side: data.side }),
          }).catch(() => {});
        }
      }
    },
    [publicKey, signMessage, signTransaction, withUser]
  );

  const executeTrigger = useCallback(
    async (data: { market: string; side: "Long" | "Short"; triggerPrice: number; kind: "StopLoss" | "TakeProfit" }) => {
      if (executingRef.current) return;
      if (!publicKey || !signMessage || !signTransaction) {
        setState({ status: "error", error: "Wallet not connected", txHash: null });
        return;
      }

      executingRef.current = true;
      setState({ status: "signing", error: null, txHash: null });

      try {
        const { setTrigger } = await import("@/lib/n1/user-client");

        setState({ status: "submitting", error: null, txHash: null });

        const result = await withUser(
          (user) => setTrigger(user, {
            symbol: data.market,
            side: data.side,
            triggerPrice: data.triggerPrice,
            kind: data.kind,
          }),
          "setTrigger"
        );

        const raw = result as Record<string, unknown>;
        const txHash = typeof result === "string"
          ? result
          : String(raw?.txHash ?? raw?.signature ?? raw?.tx ?? "submitted");
        setState({ status: "confirmed", error: null, txHash });
      } catch (err: unknown) {
        handleError(err, "setTrigger", data.market, setState);
      } finally {
        executingRef.current = false;
      }
    },
    [publicKey, signMessage, signTransaction, withUser]
  );

  /**
   * Re-check if a position/order appeared on-chain without re-executing.
   * Safe: only reads account state, never submits a new transaction.
   * If found → confirmed. If not found → stays in error state.
   */
  const recheck = useCallback(
    async (marketSymbol: string, kind: "position" | "order" | "close") => {
      const prevTxHash = state.txHash;
      setState({ status: "verifying", error: null, txHash: prevTxHash });
      const found = await verifyExecution(marketSymbol, kind, 3, 2000);
      if (found) {
        setState({ status: "confirmed", error: null, txHash: prevTxHash });
      } else {
        setState({
          status: "error",
          error: kind === "close"
            ? "Position still open. It may take more time on illiquid pairs."
            : "Position/order still not found. It may take more time on illiquid pairs.",
          txHash: prevTxHash,
        });
      }
    },
    [state.txHash]
  );

  const reset = useCallback(() => {
    executingRef.current = false;
    // Never re-enable consumed previews — server already consumed them.
    // User must create a new preview via chat to retry.
    setState({ status: "idle", error: null, txHash: null });
  }, []);

  return {
    executeOrder,
    executeClose,
    executeTrigger,
    recheck,
    reset,
    status: state.status,
    error: state.error,
    txHash: state.txHash,
    hasSession: cachedUser !== null && cachedWalletAddress === publicKey?.toBase58(),
  };
}

// ─── Error handling (shared) ─────────────────────────────────────

function handleError(
  err: unknown,
  action: string,
  market: string,
  setState: (s: OrderExecState) => void
) {
  const rawMsg = err instanceof Error ? err.message : "";
  const isUserReject =
    rawMsg.includes("User rejected") ||
    rawMsg.includes("user rejected") ||
    rawMsg.includes("Transaction cancelled") ||
    rawMsg.includes("User denied");

  const isSlippageError =
    rawMsg.includes("slippage") ||
    rawMsg.includes("Slippage") ||
    rawMsg.includes("price exceeds") ||
    rawMsg.includes("price limit") ||
    rawMsg.includes("would exceed") ||
    rawMsg.includes("fill price");

  console.error(`[OrderExecution] ${action} error:`, rawMsg, err);
  let safeMsg: string;
  if (isUserReject) {
    safeMsg = "Transaction cancelled by user";
  } else if (isSlippageError) {
    safeMsg = "Order failed due to slippage. Try again with higher slippage tolerance.";
  } else if (rawMsg.includes("Account ID is undefined")) {
    // Trade attempted before the engine indexed the first deposit. The
    // on-chain Deposit normally takes 10-20s to be picked up. Once the
    // verification toast confirms the deposit, accountIds will hydrate
    // on the next trade attempt.
    safeMsg = "Your 01 Exchange account is being activated after your first deposit. Please wait ~10-20 seconds and try again.";
  } else if (rawMsg.includes("insufficient") || rawMsg.includes("Insufficient")) {
    safeMsg = "Insufficient margin for this order";
  } else if (rawMsg.includes("timeout") || rawMsg.includes("Timeout")) {
    safeMsg = "Transaction timed out. Please try again.";
  } else {
    safeMsg = "Order execution failed. Please try again.";
    Sentry.captureException(err, {
      tags: { component: "useOrderExecution", action },
      extra: { market },
    });
  }

  setState({ status: "error", error: safeMsg, txHash: null });
}
