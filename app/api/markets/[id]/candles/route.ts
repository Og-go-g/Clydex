import { NextRequest, NextResponse } from "next/server";
import { N1_MAINNET_URL } from "@/lib/n1/constants";
import {
  INTERVAL_TO_N1,
  VALID_INTERVALS,
  type OHLCVPoint,
  type Interval,
} from "@/lib/n1/candles";

// ─── Server-side cache ──────────────────────────────────────────
const cache = new Map<string, { data: unknown; time: number }>();
const CACHE_TTL_DEFAULT = 60_000; // 60s
const CACHE_TTL_1M = 30_000;     // 30s for 1-minute candles
const MAX_CACHE = 200;

// ─── Countback limits per resolution ────────────────────────────
const COUNTBACK: Record<string, number> = {
  "1":  360,   // 6 hours of 1m
  "5":  500,   // ~42 hours of 5m
  "15": 500,   // ~5 days
  "30": 500,   // ~10 days
  "60": 720,   // 30 days of 1H
  "4H": 500,   // ~83 days
  "1D": 365,   // 1 year
  "1W": 200,   // ~4 years
  "1M": 120,   // 10 years
};

/**
 * GET /api/markets/[id]/candles?interval=1H
 *
 * Fetches OHLCV candle data from the N1/01 Exchange TradingView datafeed.
 * Returns native perp prices — no Binance dependency.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const marketId = parseInt(id, 10);
  if (isNaN(marketId) || marketId < 0) {
    return NextResponse.json({ error: "Invalid market ID" }, { status: 400 });
  }

  const interval = (request.nextUrl.searchParams.get("interval") || "1H") as Interval;
  if (!VALID_INTERVALS.has(interval)) {
    return NextResponse.json({ error: "Invalid interval" }, { status: 400 });
  }

  const n1Resolution = INTERVAL_TO_N1[interval];
  const cacheKey = `${marketId}:${interval}`;
  const ttl = interval === "1m" ? CACHE_TTL_1M : CACHE_TTL_DEFAULT;

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < ttl) {
    return NextResponse.json(cached.data);
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const countback = COUNTBACK[n1Resolution] ?? 500;
    const url = `${N1_MAINNET_URL}/tv/history?market_id=${marketId}&resolution=${n1Resolution}&to=${now}&countback=${countback}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      return NextResponse.json({ points: [] });
    }

    const raw = await res.json() as {
      s: string;
      t?: number[];
      o?: number[];
      h?: number[];
      l?: number[];
      c?: number[];
      v?: number[];
    };

    if (raw.s !== "ok" || !raw.t?.length) {
      return NextResponse.json({ points: [] });
    }

    // Zip TradingView arrays into OHLCV points
    const len = raw.t.length;
    const points: OHLCVPoint[] = new Array(len);
    const t = raw.t, o = raw.o!, h = raw.h!, l = raw.l!, c = raw.c!, v = raw.v!;

    for (let i = 0; i < len; i++) {
      points[i] = {
        time: t[i],
        open: o[i],
        high: h[i],
        low: l[i],
        close: c[i],
        volume: v[i],
      };
    }

    const result = { points };

    // Store in cache
    cache.set(cacheKey, { data: result, time: Date.now() });

    // Evict old entries
    if (cache.size > MAX_CACHE) {
      const cutoff = Date.now();
      for (const [key, val] of cache) {
        if (cutoff - val.time > ttl * 3) cache.delete(key);
      }
    }

    return NextResponse.json(result);
  } catch {
    // N1 unreachable — return empty gracefully (no 500)
    return NextResponse.json({ points: [] });
  }
}
