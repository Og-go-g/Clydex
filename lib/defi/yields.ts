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
        next: { revalidate: 300 },
      } as RequestInit);

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
  const res = await fetchDefiLlama("/pools");
  if (!res.ok) throw new Error(`DeFi Llama API error: ${res.status}`);

  const data = await res.json();
  const pools: YieldPool[] = data.data;

  // Filter Base chain, minimum $10K TVL, positive APY
  return pools
    .filter(
      (p) =>
        p.chain === "Base" &&
        p.tvlUsd > 10_000 &&
        p.apy > 0
    )
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, 100);
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
