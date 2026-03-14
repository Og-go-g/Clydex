// GeckoTerminal OHLCV API — 7-day daily candles for sparkline charts
// Docs: https://apiguide.geckoterminal.com

import { NextResponse } from "next/server";
import { GECKOTERMINAL_URLS } from "@/lib/defi/constants";
import { getAuthAddress } from "@/lib/auth/session";

const REQUEST_TIMEOUT = 10_000;

/** Validate Ethereum address format. */
function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

/** Fetch with timeout + fallback across configured GeckoTerminal URLs. */
async function fetchGeckoTerminal(path: string): Promise<Response> {
  let lastError: Error | null = null;

  for (const baseUrl of GECKOTERMINAL_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const res = await fetch(`${baseUrl}${path}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
        next: { revalidate: 300 },
      } as RequestInit);

      if (res.status === 429) {
        lastError = new Error(`GeckoTerminal rate limited (429) at ${baseUrl}`);
        continue;
      }

      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("All GeckoTerminal endpoints failed");
}

export async function GET(request: Request) {
  // Require auth to prevent abuse as free API proxy
  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const tokenAddress = searchParams.get("token");

  if (!tokenAddress || !isValidAddress(tokenAddress)) {
    return NextResponse.json({ error: "Invalid token address" }, { status: 400 });
  }

  try {
    // Step 1: Find the top pool for this token on Base
    const poolsRes = await fetchGeckoTerminal(
      `/api/v2/networks/base/tokens/${tokenAddress}/pools?page=1`
    );

    if (!poolsRes.ok) {
      return NextResponse.json({ prices: [] }, { status: 200 });
    }

    const poolsData = await poolsRes.json();
    const pools = poolsData?.data;
    if (!Array.isArray(pools) || pools.length === 0) {
      return NextResponse.json({ prices: [] }, { status: 200 });
    }

    const poolAddress: string = pools[0]?.attributes?.address;
    if (!poolAddress || !isValidAddress(poolAddress)) {
      return NextResponse.json({ prices: [] }, { status: 200 });
    }

    // Step 2: Fetch 7-day daily OHLCV candles for that pool
    const ohlcvRes = await fetchGeckoTerminal(
      `/api/v2/networks/base/pools/${poolAddress}/ohlcv/day?limit=7&currency=usd`
    );

    if (!ohlcvRes.ok) {
      return NextResponse.json({ prices: [] }, { status: 200 });
    }

    const json = await ohlcvRes.json();
    const candles: number[][] = json?.data?.attributes?.ohlcv_list || [];

    // Extract close prices, sorted by timestamp ascending
    const prices = candles
      .map((c: number[]) => ({
        timestamp: c[0],
        close: c[4],
      }))
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((c) => c.close);

    return NextResponse.json({ prices });
  } catch {
    return NextResponse.json({ prices: [], error: "Failed to fetch chart data" }, { status: 502 });
  }
}
