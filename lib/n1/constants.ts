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
// Based on per-market IMF from API (NOT doubled). Max leverage = floor(1 / imf).
export const TIERS: Record<number, { imf: number; maxLeverage: number; label: string }> = {
  1: { imf: 0.02, maxLeverage: 50, label: "Tier 1 (Major)" },
  2: { imf: 0.05, maxLeverage: 20, label: "Tier 2 (Large Cap)" },
  3: { imf: 0.10, maxLeverage: 10, label: "Tier 3 (Mid Cap)" },
  4: { imf: 0.20, maxLeverage: 5, label: "Tier 4 (Small Cap)" },
  5: { imf: 0.33, maxLeverage: 3, label: "Tier 5 (Micro Cap)" },
};

// ─── Market Cache (populated from API at startup) ──────────────
// IDs come from the 01 Exchange API — never hardcode them.
let _marketCache: N1Market[] | null = null;
let _marketCachePromise: Promise<N1Market[]> | null = null;

/**
 * Populate market cache from the live API info response.
 * Called by the API route after fetching getInfo().
 */
export function setMarketCache(markets: N1Market[]): void {
  _marketCache = markets;
  _marketCachePromise = null; // Clear promise so it won't re-fetch
}

/** Get cached markets. Falls back to empty array if not yet populated. */
export function getCachedMarkets(): N1Market[] {
  return _marketCache ?? [];
}

/** Derive tier from per-market IMF value (raw from API, NOT doubled) */
export function tierFromImf(imf: number): { tier: number; maxLeverage: number } {
  if (!isFinite(imf) || imf <= 0) return { tier: 5, maxLeverage: 1 };

  for (const [tierNum, tierDef] of Object.entries(TIERS)) {
    if (Math.abs(imf - tierDef.imf) < 0.005) {
      return { tier: Number(tierNum), maxLeverage: tierDef.maxLeverage };
    }
  }
  const maxLev = Math.min(200, Math.max(1, Math.floor(1 / imf)));
  if (imf <= 0.03) return { tier: 1, maxLeverage: maxLev };
  if (imf <= 0.07) return { tier: 2, maxLeverage: maxLev };
  if (imf <= 0.15) return { tier: 3, maxLeverage: maxLev };
  if (imf <= 0.25) return { tier: 4, maxLeverage: maxLev };
  return { tier: 5, maxLeverage: maxLev };
}

/**
 * Ensure market cache is populated (lazy init from API).
 * Safe to call multiple times — deduplicates the fetch.
 */
export async function ensureMarketCache(): Promise<N1Market[]> {
  if (_marketCache) return _marketCache;

  if (!_marketCachePromise) {
    // Dynamic import to avoid circular deps
    _marketCachePromise = import("./client").then(async ({ getMarketsInfo }) => {
      const info = await getMarketsInfo();
      const markets: N1Market[] = info.markets.map((apiMarket) => {
        // Per-market IMF from API is the correct trading IMF (NOT halved)
      // Note: only account-level margins.imf needs *2, not per-market imf
      const { tier, maxLeverage } = tierFromImf(apiMarket.imf);
        return {
          id: apiMarket.marketId,
          symbol: apiMarket.symbol,
          baseAsset: apiMarket.symbol.replace(/USD$/, ""),
          tier,
          initialMarginFraction: apiMarket.imf,
          maxLeverage,
        };
      });
      _marketCache = markets;
      return markets;
    }).catch((err) => {
      _marketCachePromise = null;
      throw err;
    });
  }

  return _marketCachePromise;
}

// ─── Market Lookup Helpers ─────────────────────────────────────

/** Find market by base asset name, symbol, or ID (case-insensitive). */
export function resolveMarket(input: string): N1Market | null {
  const markets = getCachedMarkets();
  const upper = input.toUpperCase().trim();

  // Direct symbol match: "BTCUSD" or "BTC-PERP"
  const bySymbol = markets.find((m) => m.symbol.toUpperCase() === upper);
  if (bySymbol) return bySymbol;

  // Base asset match: "BTC" -> look for symbol containing "BTC"
  const byBase = markets.find((m) => m.baseAsset.toUpperCase() === upper);
  if (byBase) return byBase;

  // Try with USD suffix: "BTC" -> "BTCUSD"
  const withUsd = `${upper}USD`;
  const byUsd = markets.find((m) => m.symbol.toUpperCase() === withUsd);
  if (byUsd) return byUsd;

  // Try with -PERP suffix: legacy compatibility
  const withPerp = `${upper}-PERP`;
  const byPerp = markets.find((m) => m.symbol.toUpperCase() === withPerp);
  if (byPerp) return byPerp;

  return null;
}

/** Get all markets as a sorted array */
export function getAllMarkets(): N1Market[] {
  return getCachedMarkets().sort((a, b) => a.id - b.id);
}

/** Get max leverage for a market */
export function getMaxLeverage(market: N1Market): number {
  return TIERS[market.tier]?.maxLeverage ?? 1;
}

/** Validate leverage for a market — returns error message or null */
export function validateLeverage(market: N1Market, leverage: number): string | null {
  if (!Number.isFinite(leverage)) return "Invalid leverage value";
  const max = getMaxLeverage(market);
  if (leverage < 1) return "Leverage must be at least 1x";
  if (leverage > max) return `Max leverage for ${market.symbol} is ${max}x (${TIERS[market.tier]?.label})`;
  return null;
}

// ─── Solana Configuration ──────────────────────────────────────
export const SOLANA_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
export const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";

// ─── Solscan Explorer ──────────────────────────────────────────
export function getSolscanUrl(address: string, type: "account" | "tx" = "account"): string {
  return `https://solscan.io/${type}/${address}`;
}
