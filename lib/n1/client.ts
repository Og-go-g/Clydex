import { Nord } from "@n1xyz/nord-ts";
import { Connection } from "@solana/web3.js";
import {
  N1_MAINNET_URL,
  N1_APP_ID,
  SOLANA_MAINNET_RPC,
} from "./constants";

// ─── Singleton Nord Client (public data, no auth) ───────────────

let nordInstance: Nord | null = null;
let initPromise: Promise<Nord> | null = null;

/**
 * Get or initialize the singleton Nord client.
 * Thread-safe: concurrent callers share the same init promise.
 */
export async function getNord(): Promise<Nord> {
  if (nordInstance) return nordInstance;

  if (!initPromise) {
    initPromise = Nord.new({
      app: N1_APP_ID,
      solanaConnection: new Connection(
        process.env.SOLANA_RPC_URL || SOLANA_MAINNET_RPC,
        "confirmed"
      ),
      webServerUrl: process.env.N1_API_URL || N1_MAINNET_URL,
    }).then((nord) => {
      nordInstance = nord;
      return nord;
    }).catch((err) => {
      initPromise = null; // allow retry on failure
      throw err;
    });
  }

  return initPromise;
}

// ─── Public Data Helpers ─────────────────────────────────────────

/** Fetch market stats (price, volume, OI, funding) for a given market ID */
export async function getMarketStats(marketId: number) {
  const nord = await getNord();
  return nord.getMarketStats({ marketId });
}

/** Fetch orderbook for a market by symbol or ID */
export async function getOrderbook(opts: { symbol?: string; marketId?: number }) {
  const nord = await getNord();
  return nord.getOrderbook(opts);
}

/** Fetch all markets info */
export async function getMarketsInfo() {
  const nord = await getNord();
  return nord.getInfo();
}

/** Fetch account by ID */
export async function getAccount(accountId: number) {
  const nord = await getNord();
  return nord.getAccount(accountId);
}

/** Fetch account orders */
export async function getAccountOrders(accountId: number) {
  const nord = await getNord();
  return nord.getAccountOrders(accountId);
}

/** Fetch account triggers (stop-loss / take-profit) */
export async function getAccountTriggers(accountId: number) {
  const nord = await getNord();
  return nord.getAccountTriggers({ accountId });
}

/** Find user by Solana pubkey — returns account IDs */
export async function getUser(pubkey: string) {
  const nord = await getNord();
  return nord.getUser({ pubkey });
}

/** Fetch recent trades for a market */
export async function getRecentTrades(marketId: number, pageSize = 50) {
  const nord = await getNord();
  return nord.getTrades({ marketId, pageSize });
}

/** Fetch server timestamp */
export async function getServerTimestamp() {
  const nord = await getNord();
  return nord.getTimestamp();
}

/** Get fee brackets */
export async function getFeeBrackets() {
  const nord = await getNord();
  return nord.getFeeBrackets();
}

/** Get account fee tier */
export async function getAccountFeeTier(accountId: number) {
  const nord = await getNord();
  return nord.getAccountFeeTier(accountId);
}

/** Get market fee for a specific account and role */
export async function getMarketFee(marketId: number, feeKind: "maker" | "taker", accountId: number) {
  const nord = await getNord();
  return nord.getMarketFee({ marketId, feeKind, accountId });
}
