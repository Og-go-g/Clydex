// DeFi Llama Yields API — URLs from DEFILLAMA_URLS env var
// Docs: https://defillama.com/docs/api

import { DEFILLAMA_URLS } from "./constants";

export interface YieldPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apyBase: number | null;
  apyReward: number | null;
  apy: number;
  apyMean30d: number | null;
  rewardTokens: string[] | null;
  underlyingTokens: string[] | null;
  poolMeta: string | null;
}

const REQUEST_TIMEOUT = 15_000; // DeFi Llama can be slow — 15s

// In-memory cache for Base yields (the full /pools response is ~17MB,
// too large for Next.js fetch cache which has a 2MB limit).
// We filter to Base chain immediately and cache only the result (~50KB).
const YIELDS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let yieldsCache: { data: YieldPool[]; ts: number } | null = null;

/** Fetch with timeout + automatic fallback across all configured DeFi Llama URLs. */
async function fetchDefiLlama(
  path: string
): Promise<Response> {
  let lastError: Error | null = null;

  for (const baseUrl of DEFILLAMA_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const res = await fetch(`${baseUrl}${path}`, {
        signal: controller.signal,
        // Skip Next.js fetch cache — response is too large (17MB).
        // We use our own in-memory cache instead.
        cache: "no-store",
      });

      if (res.status === 429) {
        lastError = new Error(`DeFi Llama rate limited (429) at ${baseUrl}`);
        continue;
      }

      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("All DeFi Llama endpoints failed");
}

export async function getBaseYields(): Promise<YieldPool[]> {
  // Return from in-memory cache if fresh
  if (yieldsCache && Date.now() - yieldsCache.ts < YIELDS_CACHE_TTL) {
    return yieldsCache.data;
  }

  const res = await fetchDefiLlama("/pools");
  if (!res.ok) throw new Error(`DeFi Llama API error: ${res.status}`);

  const data = await res.json();
  const pools: YieldPool[] = data.data;

  // Filter Base chain, minimum $10K TVL, positive APY
  const filtered = pools
    .filter(
      (p) =>
        p.chain === "Base" &&
        p.tvlUsd > 10_000 &&
        p.apy > 0
    )
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, 100);

  // Cache the filtered result (~50KB instead of 17MB)
  yieldsCache = { data: filtered, ts: Date.now() };

  return filtered;
}

export async function searchYields(
  query: string
): Promise<YieldPool[]> {
  const pools = await getBaseYields();
  const q = query.toLowerCase();

  return pools.filter(
    (p) =>
      p.symbol.toLowerCase().includes(q) ||
      p.project.toLowerCase().includes(q)
  );
}
