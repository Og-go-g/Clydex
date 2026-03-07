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

/** Only allow URLs from trusted DeFi domains in API responses. */
const TRUSTED_URL_DOMAINS = Object.freeze([
  "dexscreener.com",
  "basescan.org",
  "etherscan.io",
]);

function sanitizeUrl(url: unknown): string {
  if (typeof url !== "string" || !url.startsWith("https://")) return "";
  try {
    const hostname = new URL(url).hostname;
    if (TRUSTED_URL_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
      return url;
    }
  } catch { /* invalid URL */ }
  return "";
}

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
    url: sanitizeUrl(basePair.url),
  };
}

/** Known Base token addresses — curated to avoid scams, sorted by typical market cap.
 *  DexScreener /tokens endpoint accepts up to 30 addresses at once. */
const BASE_TOKEN_ADDRESSES: readonly string[] = Object.freeze([
  "0x4200000000000000000000000000000000000006", // WETH
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
  "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC
  "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", // cbETH
  "0x940181a94A35A4569E4529A3CDfB74e38FD98631", // AERO
  "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842", // MORPHO
  "0xA88594D404727625A9437C3f886C7643872296AE", // WELL
  "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", // VIRTUAL
  "0x532f27101965dd16442E59d40670FaF5eBB142E4", // BRETT
  "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", // DEGEN
  "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4", // TOSHI
  "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", // DAI
  "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", // USDbC
  "0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe", // HIGHER
  "0x6921B130D297cc43754afba22e5EAc0FBf8Db75b", // doginme
  "0xBC45647eA894030a4E9801Ec03479739FA2485F0", // KEYCAT
  "0x768BE13e1680b5ebE0024C42c896E3dB59ec0149", // SKI
  "0xB1a03EdA10342529bBF8EB700a06C60441fEf25d", // MIGGLES
  "0x1C7a460413dD4e964f96D8dFC56E7223cE88CD85", // SEAM
  "0xcfA3Ef56d303AE4fAabA0592388F19d7C3399FB4", // eUSD
]);

export async function getTopBaseTokens(): Promise<TokenPrice[]> {
  // Fetch all known tokens from DexScreener in one batch call
  const addressList = BASE_TOKEN_ADDRESSES.join(",");
  const res = await fetchDexScreener(`/tokens/v1/base/${addressList}`);
  if (!res.ok) {
    // Fallback: fetch individually if batch endpoint fails
    return getTopBaseTokensFallback();
  }

  const pairs: Record<string, unknown>[] = await res.json();
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return getTopBaseTokensFallback();
  }

  // Group pairs by base token address, pick highest-volume pair per token
  const tokenMap = new Map<string, TokenPrice>();

  for (const pair of pairs) {
    const baseToken = pair.baseToken as { address: string; symbol: string; name: string } | undefined;
    if (!baseToken || (pair as Record<string, unknown>).chainId !== "base") continue;

    const addr = baseToken.address.toLowerCase();
    const volume = ((pair as Record<string, { h24?: number }>).volume?.h24) || 0;
    const existing = tokenMap.get(addr);

    if (!existing || volume > existing.volume24h) {
      tokenMap.set(addr, {
        symbol: baseToken.symbol,
        name: baseToken.name,
        address: baseToken.address,
        priceUsd: parseFloat(String((pair as Record<string, unknown>).priceUsd || "0")),
        priceChange24h: ((pair as Record<string, { h24?: number }>).priceChange?.h24) || 0,
        volume24h: volume,
        liquidity: ((pair as Record<string, { usd?: number }>).liquidity?.usd) || 0,
        fdv: (pair as Record<string, number>).fdv || 0,
        pairAddress: String((pair as Record<string, unknown>).pairAddress || ""),
        dexId: String((pair as Record<string, unknown>).dexId || ""),
        url: sanitizeUrl((pair as Record<string, unknown>).url),
      });
    }
  }

  // Sort by 24h volume descending, return top 10
  return [...tokenMap.values()]
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, 10);
}

/** Fallback: fetch tokens individually if batch endpoint fails */
async function getTopBaseTokensFallback(): Promise<TokenPrice[]> {
  const tokens = ["ETH", "AERO", "cbBTC", "WELL", "BRETT", "DEGEN", "VIRTUAL", "MORPHO"];
  const results = await Promise.allSettled(
    tokens.map((t) => getTokenPrice(t))
  );

  return results
    .filter(
      (r): r is PromiseFulfilledResult<TokenPrice> =>
        r.status === "fulfilled" && r.value !== null
    )
    .map((r) => r.value)
    .sort((a, b) => b.volume24h - a.volume24h);
}
