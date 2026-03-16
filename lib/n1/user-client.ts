import { NordUser, Side, FillMode, TriggerKind } from "@n1xyz/nord-ts";
import type { PublicKey, Transaction } from "@solana/web3.js";
import { getNord } from "./client";
import { N1_MARKETS, validateLeverage } from "./constants";
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
  const market = N1_MARKETS[params.symbol] ?? N1_MARKETS[`${params.symbol}-PERP`];
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

  // For market orders, use quoteSize if no explicit size
  // Price is required for limit orders
  if (fillMode === FillMode.Limit && !params.price) {
    throw new Error("Limit orders require a price");
  }

  return user.placeOrder({
    marketId: market.id,
    side,
    fillMode,
    isReduceOnly,
    size: params.size,
    price: params.price,
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
 * Add a stop-loss or take-profit trigger.
 */
export async function setTrigger(user: NordUser, params: SetTriggerParams) {
  const market = N1_MARKETS[params.symbol] ?? N1_MARKETS[`${params.symbol}-PERP`];
  if (!market) {
    throw new Error(`Unknown market: ${params.symbol}`);
  }

  return user.addTrigger({
    marketId: market.id,
    side: toSdkSide(params.side),
    kind: toTriggerKind(params.kind),
    triggerPrice: params.triggerPrice,
    limitPrice: params.limitPrice,
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
  const market = N1_MARKETS[params.symbol] ?? N1_MARKETS[`${params.symbol}-PERP`];
  if (!market) {
    throw new Error(`Unknown market: ${params.symbol}`);
  }

  return user.removeTrigger({
    marketId: market.id,
    side: toSdkSide(params.side),
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
 * Get on-chain Solana token balances for this user.
 */
export async function getSolanaBalances(user: NordUser) {
  return user.getSolanaBalances({
    includeZeroBalances: false,
    includeTokenAccounts: true,
  });
}

/**
 * Close a position by placing a reduce-only market order in the opposite direction.
 */
export async function closePosition(
  user: NordUser,
  params: {
    symbol: string;
    side: OrderSide;
    size: number;
    accountId?: number;
  }
) {
  const market = N1_MARKETS[params.symbol] ?? N1_MARKETS[`${params.symbol}-PERP`];
  if (!market) {
    throw new Error(`Unknown market: ${params.symbol}`);
  }

  // To close a Long, we sell (Ask). To close a Short, we buy (Bid).
  const closeSide = params.side === "Long" ? Side.Ask : Side.Bid;

  return user.placeOrder({
    marketId: market.id,
    side: closeSide,
    fillMode: FillMode.ImmediateOrCancel,
    isReduceOnly: true,
    size: params.size,
    accountId: params.accountId,
  });
}
