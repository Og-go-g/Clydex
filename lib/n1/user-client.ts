import { NordUser, Side, FillMode, TriggerKind } from "@n1xyz/nord-ts";
import type { PublicKey, Transaction } from "@solana/web3.js";
import { getNord } from "./client";
import { resolveMarket, validateLeverage } from "./constants";
import type { OrderSide } from "./types";

// ─── Types ───────────────────────────────────────────────────────

export interface CreateUserParams {
  walletPubkey: PublicKey;
  signMessageFn: (message: Uint8Array) => Promise<Uint8Array>;
  signTransactionFn: (tx: Transaction) => Promise<Transaction>;
}

export interface PlaceOrderParams {
  symbol: string;
  side: OrderSide;
  size: number;
  price?: number;
  leverage: number;
  orderType?: "market" | "limit" | "postOnly";
  reduceOnly?: boolean;
  accountId?: number;
  /** Slippage tolerance as decimal (0.001 = 0.1%). For market orders, sets worst acceptable fill price. */
  slippage?: number;
}

export interface SetTriggerParams {
  symbol: string;
  side: OrderSide;
  kind: "StopLoss" | "TakeProfit";
  triggerPrice: number;
  limitPrice?: number;
  accountId?: number;
}

// ─── Side/FillMode Conversion ────────────────────────────────────

function toSdkSide(side: OrderSide): Side {
  return side === "Long" ? Side.Bid : Side.Ask;
}

function toFillMode(orderType: string): FillMode {
  switch (orderType) {
    case "limit": return FillMode.Limit;
    case "postOnly": return FillMode.PostOnly;
    case "market": return FillMode.ImmediateOrCancel;
    default: return FillMode.ImmediateOrCancel;
  }
}

function toTriggerKind(kind: "StopLoss" | "TakeProfit"): TriggerKind {
  return kind === "StopLoss" ? TriggerKind.StopLoss : TriggerKind.TakeProfit;
}

// ─── Session Key Management ──────────────────────────────────────

import nacl from "tweetnacl";

/**
 * Create a NordUser with a fresh ephemeral session keypair.
 * The session keypair is generated in-memory and never persisted.
 * The wallet signs the session creation message, then the session key
 * signs all subsequent trading actions.
 */
export async function createNordUser(params: CreateUserParams): Promise<NordUser> {
  const nord = await getNord();
  const sessionKeypair = nacl.sign.keyPair();

  const user = await NordUser.new({
    nord,
    walletPubkey: params.walletPubkey,
    sessionPubkey: sessionKeypair.publicKey,
    signMessageFn: params.signMessageFn,
    signTransactionFn: params.signTransactionFn,
    signSessionFn: async (message: Uint8Array) => {
      return nacl.sign.detached(message, sessionKeypair.secretKey);
    },
  });

  // Create a session on the exchange
  await user.refreshSession();
  // Fetch account IDs and balances
  await user.updateAccountId();
  await user.fetchInfo();

  return user;
}

// ─── Trading Operations ──────────────────────────────────────────

/**
 * Place an order on the exchange.
 * Validates leverage against market tier limits before submitting.
 */
export async function placeOrder(user: NordUser, params: PlaceOrderParams) {
  // Ensure market cache is populated (needed on client-side)
  const { ensureMarketCache } = await import("./constants");
  await ensureMarketCache();

  const market = resolveMarket(params.symbol);
  if (!market) {
    throw new Error(`Unknown market: ${params.symbol}`);
  }

  // Validate leverage
  const leverageError = validateLeverage(market, params.leverage);
  if (leverageError) {
    throw new Error(leverageError);
  }

  const side = toSdkSide(params.side);
  const fillMode = toFillMode(params.orderType ?? "market");
  const isReduceOnly = params.reduceOnly ?? false;

  // Price is required for limit orders
  if (fillMode === FillMode.Limit && !params.price) {
    throw new Error("Limit orders require a price");
  }

  // For market orders with slippage: calculate worst acceptable fill price
  // This acts as a price ceiling (long) or floor (short) — IOC cancels unfilled remainder
  let effectivePrice = params.price;
  if (fillMode === FillMode.ImmediateOrCancel && !params.price && params.slippage) {
    const { getMarketStats } = await import("./client");
    const stats = await getMarketStats(market.id);
    const markPrice = stats.perpStats?.mark_price ?? stats.indexPrice ?? 0;
    if (markPrice > 0) {
      effectivePrice = side === Side.Bid
        ? markPrice * (1 + params.slippage) // Long: max price
        : markPrice * (1 - params.slippage); // Short: min price
    }
  }

  // Avoid "Precision loss when converting to scaled integer" SDK error.
  // SDK rounds size using market.sizeDecimals (e.g., 1 for SUI = min 0.1 SUI).
  // We don't have sizeDecimals in our market cache, so round to 1 decimal (safe for all markets).
  // Math.round avoids floating-point drift (e.g., 52.0833... → 52.1).
  const roundedSize = Math.round(params.size * 10) / 10;

  if (roundedSize <= 0) {
    throw new Error(`Order size too small (${params.size.toFixed(4)} base units). Minimum is 0.1. Try a larger dollar amount.`);
  }

  return user.placeOrder({
    marketId: market.id,
    side,
    fillMode,
    isReduceOnly,
    size: roundedSize,
    price: effectivePrice,
    accountId: params.accountId,
  });
}

/**
 * Cancel an existing order.
 */
export async function cancelOrder(user: NordUser, orderId: string | number, accountId?: number) {
  return user.cancelOrder(BigInt(orderId), accountId);
}

/**
 * Edit an order atomically: cancel old + place new in a single transaction.
 * Uses SDK's `atomic()` to ensure the old order is cancelled and new one placed
 * without a gap where neither exists.
 */
export async function editOrder(
  user: NordUser,
  params: {
    oldOrderId: string | number;
    symbol: string;
    side: OrderSide;
    size: number;
    price: number;
    leverage: number;
    accountId?: number;
  }
) {
  const { ensureMarketCache } = await import("./constants");
  await ensureMarketCache();

  const market = resolveMarket(params.symbol);
  if (!market) throw new Error(`Unknown market: ${params.symbol}`);

  const leverageError = validateLeverage(market, params.leverage);
  if (leverageError) throw new Error(leverageError);

  const sdkSide = toSdkSide(params.side);
  const roundedSize = Math.round(params.size * 10) / 10;
  if (roundedSize <= 0) throw new Error("Order size too small");

  return user.atomic([
    { kind: "cancel", orderId: BigInt(params.oldOrderId) },
    {
      kind: "place",
      marketId: market.id,
      side: sdkSide,
      fillMode: FillMode.Limit,
      isReduceOnly: false,
      size: roundedSize,
      price: params.price,
    },
  ], params.accountId);
}

/**
 * Add a stop-loss or take-profit trigger.
 */
export async function setTrigger(user: NordUser, params: SetTriggerParams) {
  const { ensureMarketCache } = await import("./constants");
  await ensureMarketCache();

  const market = resolveMarket(params.symbol);
  if (!market) {
    throw new Error(`Unknown market: ${params.symbol}`);
  }

  // Round trigger price to avoid precision SDK errors
  const roundedTriggerPrice = Math.round(params.triggerPrice * 1e6) / 1e6;
  const roundedLimitPrice = params.limitPrice ? Math.round(params.limitPrice * 1e6) / 1e6 : undefined;


  // Trigger side = closing side (opposite of position side):
  // Long position → trigger sells (Ask), Short position → trigger buys (Bid)
  const closingSide = params.side === "Long" ? Side.Ask : Side.Bid;

  // limitPrice: if user provided one, use it (rounded). Otherwise undefined = market execution.
  // SDK handles undefined limitPrice gracefully (no limit set → executes at market when trigger fires).
  const effectiveLimitPrice = roundedLimitPrice
    ? Math.round(roundedLimitPrice * 1e6) / 1e6
    : undefined;

  return user.addTrigger({
    marketId: market.id,
    side: closingSide,
    kind: toTriggerKind(params.kind),
    triggerPrice: roundedTriggerPrice,
    limitPrice: effectiveLimitPrice,
    accountId: params.accountId,
  });
}

/**
 * Remove a trigger.
 */
export async function removeTrigger(
  user: NordUser,
  params: {
    symbol: string;
    side: OrderSide;
    kind: "StopLoss" | "TakeProfit";
    triggerPrice: number;
    accountId?: number;
  }
) {
  const { ensureMarketCache } = await import("./constants");
  await ensureMarketCache();

  const market = resolveMarket(params.symbol);
  if (!market) {
    throw new Error(`Unknown market: ${params.symbol}`);
  }

  // Trigger side = closing side (opposite of position side)
  const closingSide = params.side === "Long" ? Side.Ask : Side.Bid;

  return user.removeTrigger({
    marketId: market.id,
    side: closingSide,
    kind: toTriggerKind(params.kind),
    triggerPrice: params.triggerPrice,
    accountId: params.accountId,
  });
}

/**
 * Deposit USDC to the exchange.
 */
export async function depositUsdc(user: NordUser, amount: number) {
  return user.deposit({
    amount,
    tokenId: 0, // USDC is always token 0
  });
}

/**
 * Withdraw USDC from the exchange.
 */
export async function withdrawUsdc(user: NordUser, amount: number) {
  return user.withdraw({
    amount,
    tokenId: 0,
  });
}

/**
 * Close a position (full or partial) via reduce-only market order.
 */
export async function closePosition(
  user: NordUser,
  params: { symbol: string; side: OrderSide; size: number; slippage?: number; accountId?: number }
) {
  const { ensureMarketCache } = await import("./constants");
  await ensureMarketCache();

  const market = resolveMarket(params.symbol);
  if (!market) throw new Error(`Unknown market: ${params.symbol}`);

  // Close = opposite side, reduce-only market order
  // For close orders: round DOWN to avoid exceeding position size.
  // Math.floor ensures we never close more than we have (0.05 → 0.0, not 0.1).
  // If floor zeros out, use the original size (SDK will clamp to position size for reduce-only).
  const closeSide = params.side === "Long" ? Side.Ask : Side.Bid;
  const flooredSize = Math.floor(params.size * 10) / 10;
  const safeSize = flooredSize > 0 ? flooredSize : params.size;

  // Slippage protection for close orders
  let closePrice: number | undefined;
  if (params.slippage) {
    const { getMarketStats } = await import("./client");
    const stats = await getMarketStats(market.id);
    const markPrice = stats.perpStats?.mark_price ?? stats.indexPrice ?? 0;
    if (markPrice > 0) {
      // Close long = sell (ask) → min acceptable price
      // Close short = buy (bid) → max acceptable price
      closePrice = closeSide === Side.Ask
        ? markPrice * (1 - params.slippage)
        : markPrice * (1 + params.slippage);
    }
  }

  return user.placeOrder({
    marketId: market.id,
    side: closeSide,
    fillMode: FillMode.ImmediateOrCancel,
    isReduceOnly: true,
    size: safeSize,
    price: closePrice,
    accountId: params.accountId,
  });
}

/**
 * Get on-chain Solana token balances for this user.
 */
export async function getSolanaBalances(user: NordUser) {
  return user.getSolanaBalances({
    includeZeroBalances: false,
    includeTokenAccounts: true,
  });
}

/** @deprecated — use the closePosition defined above */
// (duplicate removed)
