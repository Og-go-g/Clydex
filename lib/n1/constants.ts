import type { N1Market } from "./types";

// ─── USDC Collateral (Solana SPL Token) ────────────────────────
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;

// ─── N1 Network Configuration ──────────────────────────────────
export const N1_MAINNET_URL = "https://zo-mainnet.n1.xyz";
export const N1_DEVNET_URL = "https://zo-devnet.n1.xyz";
export const N1_MAINNET_WS = "wss://zo-mainnet.n1.xyz/ws";
export const N1_DEVNET_WS = "wss://zo-devnet.n1.xyz/ws";
export const N1_APP_ID = "zoau54n5U24GHNKqyoziVaVxgsiQYnPMx33fKmLLCT5";

// ─── Tier Definitions ──────────────────────────────────────────
export const TIERS: Record<number, { imf: number; maxLeverage: number; label: string }> = {
  1: { imf: 0.02, maxLeverage: 50, label: "Tier 1 (Major)" },
  2: { imf: 0.05, maxLeverage: 20, label: "Tier 2 (Large Cap)" },
  3: { imf: 0.10, maxLeverage: 10, label: "Tier 3 (Mid Cap)" },
  4: { imf: 0.20, maxLeverage: 5, label: "Tier 4 (Small Cap)" },
  5: { imf: 0.33, maxLeverage: 3, label: "Tier 5 (Micro Cap)" },
};

// ─── 24 Perpetual Markets ──────────────────────────────────────
// Source: https://zo-mainnet.n1.xyz/info (01 Exchange)
export const N1_MARKETS: Record<string, N1Market> = {
  "BTC-PERP":      { id: 0,  symbol: "BTC-PERP",      baseAsset: "BTC",     tier: 1, initialMarginFraction: 0.02, maxLeverage: 50 },
  "ETH-PERP":      { id: 1,  symbol: "ETH-PERP",      baseAsset: "ETH",     tier: 1, initialMarginFraction: 0.02, maxLeverage: 50 },
  "SOL-PERP":      { id: 2,  symbol: "SOL-PERP",      baseAsset: "SOL",     tier: 2, initialMarginFraction: 0.05, maxLeverage: 20 },
  "HYPE-PERP":     { id: 3,  symbol: "HYPE-PERP",     baseAsset: "HYPE",    tier: 2, initialMarginFraction: 0.05, maxLeverage: 20 },
  "SUI-PERP":      { id: 4,  symbol: "SUI-PERP",      baseAsset: "SUI",     tier: 3, initialMarginFraction: 0.10, maxLeverage: 10 },
  "XRP-PERP":      { id: 5,  symbol: "XRP-PERP",      baseAsset: "XRP",     tier: 3, initialMarginFraction: 0.10, maxLeverage: 10 },
  "EIGEN-PERP":    { id: 6,  symbol: "EIGEN-PERP",    baseAsset: "EIGEN",   tier: 3, initialMarginFraction: 0.10, maxLeverage: 10 },
  "VIRTUAL-PERP":  { id: 7,  symbol: "VIRTUAL-PERP",  baseAsset: "VIRTUAL", tier: 3, initialMarginFraction: 0.10, maxLeverage: 10 },
  "ENA-PERP":      { id: 8,  symbol: "ENA-PERP",      baseAsset: "ENA",     tier: 3, initialMarginFraction: 0.10, maxLeverage: 10 },
  "NEAR-PERP":     { id: 9,  symbol: "NEAR-PERP",     baseAsset: "NEAR",    tier: 3, initialMarginFraction: 0.10, maxLeverage: 10 },
  "ARB-PERP":      { id: 10, symbol: "ARB-PERP",      baseAsset: "ARB",     tier: 3, initialMarginFraction: 0.10, maxLeverage: 10 },
  "ASTER-PERP":    { id: 11, symbol: "ASTER-PERP",    baseAsset: "ASTER",   tier: 3, initialMarginFraction: 0.10, maxLeverage: 10 },
  "PAXG-PERP":     { id: 12, symbol: "PAXG-PERP",     baseAsset: "PAXG",    tier: 3, initialMarginFraction: 0.10, maxLeverage: 10 },
  "BERA-PERP":     { id: 13, symbol: "BERA-PERP",     baseAsset: "BERA",    tier: 4, initialMarginFraction: 0.20, maxLeverage: 5 },
  "XPL-PERP":      { id: 14, symbol: "XPL-PERP",      baseAsset: "XPL",     tier: 4, initialMarginFraction: 0.20, maxLeverage: 5 },
  "S-PERP":        { id: 15, symbol: "S-PERP",        baseAsset: "S",       tier: 4, initialMarginFraction: 0.20, maxLeverage: 5 },
  "JUP-PERP":      { id: 16, symbol: "JUP-PERP",      baseAsset: "JUP",     tier: 4, initialMarginFraction: 0.20, maxLeverage: 5 },
  "APT-PERP":      { id: 17, symbol: "APT-PERP",      baseAsset: "APT",     tier: 4, initialMarginFraction: 0.20, maxLeverage: 5 },
  "AAVE-PERP":     { id: 18, symbol: "AAVE-PERP",     baseAsset: "AAVE",    tier: 4, initialMarginFraction: 0.20, maxLeverage: 5 },
  "ZEC-PERP":      { id: 19, symbol: "ZEC-PERP",      baseAsset: "ZEC",     tier: 4, initialMarginFraction: 0.20, maxLeverage: 5 },
  "LIT-PERP":      { id: 20, symbol: "LIT-PERP",      baseAsset: "LIT",     tier: 4, initialMarginFraction: 0.20, maxLeverage: 5 },
  "WLFI-PERP":     { id: 21, symbol: "WLFI-PERP",     baseAsset: "WLFI",    tier: 5, initialMarginFraction: 0.33, maxLeverage: 3 },
  "IP-PERP":       { id: 22, symbol: "IP-PERP",       baseAsset: "IP",      tier: 5, initialMarginFraction: 0.33, maxLeverage: 3 },
  "KAITO-PERP":    { id: 23, symbol: "KAITO-PERP",    baseAsset: "KAITO",   tier: 5, initialMarginFraction: 0.33, maxLeverage: 3 },
};

// ─── Market Lookup Helpers ─────────────────────────────────────

/** Find market by base asset name (case-insensitive). e.g. "btc" -> "BTC-PERP" */
export function resolveMarket(input: string): N1Market | null {
  const upper = input.toUpperCase().trim();

  // Direct match: "BTC-PERP"
  if (N1_MARKETS[upper]) return N1_MARKETS[upper];

  // Base asset match: "BTC" -> "BTC-PERP"
  const withPerp = `${upper}-PERP`;
  if (N1_MARKETS[withPerp]) return N1_MARKETS[withPerp];

  // Search by baseAsset field
  const found = Object.values(N1_MARKETS).find(
    (m) => m.baseAsset.toUpperCase() === upper
  );
  return found ?? null;
}

/** Get all markets as a sorted array */
export function getAllMarkets(): N1Market[] {
  return Object.values(N1_MARKETS).sort((a, b) => a.id - b.id);
}

/** Get max leverage for a market */
export function getMaxLeverage(market: N1Market): number {
  return TIERS[market.tier]?.maxLeverage ?? 1;
}

/** Validate leverage for a market — returns error message or null */
export function validateLeverage(market: N1Market, leverage: number): string | null {
  const max = getMaxLeverage(market);
  if (leverage < 1) return "Leverage must be at least 1x";
  if (leverage > max) return `Max leverage for ${market.symbol} is ${max}x (${TIERS[market.tier]?.label})`;
  if (!Number.isFinite(leverage)) return "Invalid leverage value";
  return null;
}

// ─── Solana Configuration ──────────────────────────────────────
export const SOLANA_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
export const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";

// ─── Solscan Explorer ──────────────────────────────────────────
export function getSolscanUrl(address: string, type: "account" | "tx" = "account"): string {
  return `https://solscan.io/${type}/${address}`;
}
