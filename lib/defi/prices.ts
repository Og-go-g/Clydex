// DEX Screener API — URLs from DEXSCREENER_URLS env var
// Docs: https://docs.dexscreener.com

import { DEXSCREENER_URLS } from "./constants";

export interface TokenPrice {
  symbol: string;
  name: string;
  address: string;
  priceUsd: number;
  priceChange24h: number;
  volume24h: number;
  liquidity: number;
  fdv: number;
  pairAddress: string;
  dexId: string;
  url: string;
}

const REQUEST_TIMEOUT = 8_000;

// Well-known stablecoins and tokens that DexScreener may not find as baseToken
const KNOWN_STABLECOINS: Record<string, TokenPrice> = {
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    priceUsd: 1.0,
    priceChange24h: 0,
    volume24h: 0,
    liquidity: 0,
    fdv: 0,
    pairAddress: "",
    dexId: "",
    url: "https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
};

/** Fetch with timeout + automatic fallback across all configured DexScreener URLs. */
async function fetchDexScreener(
  path: string
): Promise<Response> {
  let lastError: Error | null = null;

  for (const baseUrl of DEXSCREENER_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const res = await fetch(`${baseUrl}${path}`, {
        signal: controller.signal,
        next: { revalidate: 30 },
      } as RequestInit);

      if (res.status === 429) {
        lastError = new Error(`DexScreener rate limited (429) at ${baseUrl}`);
        continue;
      }

      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("All DexScreener endpoints failed");
}

export async function getTokenPrice(query: string): Promise<TokenPrice | null> {
  // Check stablecoins first — DexScreener often doesn't list them as baseToken
  const upper = query.toUpperCase().trim();
  if (KNOWN_STABLECOINS[upper]) {
    return KNOWN_STABLECOINS[upper];
  }

  const res = await fetchDexScreener(
    `/latest/dex/search?q=${encodeURIComponent(query)}`
  );
  if (!res.ok) return null;

  const data = await res.json();
  const pairs = data.pairs || [];

  // Find best Base chain pair where the query matches baseToken
  const basePair = pairs.find(
    (p: Record<string, unknown>) => p.chainId === "base" && p.baseToken
  );

  if (!basePair) return null;

  return {
    symbol: basePair.baseToken.symbol,
    name: basePair.baseToken.name,
    address: basePair.baseToken.address,
    priceUsd: parseFloat(basePair.priceUsd || "0"),
    priceChange24h: basePair.priceChange?.h24 || 0,
    volume24h: basePair.volume?.h24 || 0,
    liquidity: basePair.liquidity?.usd || 0,
    fdv: basePair.fdv || 0,
    pairAddress: basePair.pairAddress,
    dexId: basePair.dexId,
    url: basePair.url,
  };
}

export async function getTopBaseTokens(): Promise<TokenPrice[]> {
  // Search for popular Base tokens
  const tokens = ["AERO", "BRETT", "TOSHI", "DEGEN", "WELL"];
  const results = await Promise.allSettled(
    tokens.map((t) => getTokenPrice(t))
  );

  return results
    .filter(
      (r): r is PromiseFulfilledResult<TokenPrice> =>
        r.status === "fulfilled" && r.value !== null
    )
    .map((r) => r.value);
}
