import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// ─── Binance symbol mapping ─────────────────────────────────────

const BINANCE_MAP: Record<string, string> = {
  BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT", ARB: "ARBUSDT",
  SUI: "SUIUSDT", APT: "APTUSDT", JUP: "JUPUSDT", RNDR: "RENDERUSDT",
  BONK: "BONKUSDT", WIF: "WIFUSDT", JTO: "JTOUSDT", PYTH: "PYTHUSDT",
  TIA: "TIAUSDT", SEI: "SEIUSDT", INJ: "INJUSDT", DOGE: "DOGEUSDT",
  AVAX: "AVAXUSDT", LINK: "LINKUSDT", OP: "OPUSDT", NEAR: "NEARUSDT",
  HYPE: "HYPEUSDT", TRUMP: "TRUMPUSDT", XRP: "XRPUSDT", LIT: "LITUSDT",
  PAXG: "PAXGUSDT", MELANIA: "MELANIAUSDT", BERA: "BERAUSDT",
  EIGEN: "EIGENUSDT", VIRTUAL: "VIRTUALUSDT", ENA: "ENAUSDT",
  ZEC: "ZECUSDT", AAVE: "AAVEUSDT", KAITO: "KAITOUSDT", ASTER: "ASTERUSDT",
};

// Map our intervals to Binance kline intervals
const BINANCE_INTERVAL: Record<string, string> = {
  "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1H": "1h",
};

// Binance candle limits per interval
const BINANCE_LIMIT: Record<string, number> = {
  "1m": 360, "5m": 500, "15m": 500, "30m": 500, "1H": 720,
};

// Minimum DB points needed before we prefer DB over Binance.
const MIN_DB_POINTS_TO_PREFER: Record<string, number> = {
  "1m": Infinity, "5m": Infinity, "15m": 672, "30m": 336, "1H": 168,
};

// DB doesn't have 1m/5m data — skip DB entirely for these
const DB_SKIP_INTERVALS = new Set(["1m", "5m"]);

// Cache: per-key, 60s TTL (short enough for fresh data, long enough to avoid spam)
const cache = new Map<string, { data: unknown; time: number }>();
const CACHE_TTL = 60_000;

interface PricePoint {
  time: number;
  price: number;
}

// ─── Binance fetch with parallel race ───────────────────────────
// Fires all endpoints concurrently, takes first success
async function fetchBinance(symbol: string, interval: string, limit: number): Promise<PricePoint[]> {
  const binanceInterval = BINANCE_INTERVAL[interval] || "1h";
  const endpoints = [
    `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`,
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`,
    `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`,
  ];

  // Race all endpoints — first successful response wins
  const controller = new AbortController();
  const results = endpoints.map(async (ep) => {
    try {
      const res = await fetch(ep, { signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status}`);
      const raw = (await res.json()) as unknown[];
      controller.abort(); // Cancel others
      const points: PricePoint[] = [];
      for (const k of raw) {
        if (!Array.isArray(k) || k.length < 5) continue;
        const t = Math.floor(Number(k[0]) / 1000);
        const price = Number(k[4]);
        if (!isFinite(t) || !isFinite(price) || price <= 0) continue;
        points.push({ time: t, price });
      }
      return points;
    } catch {
      return null;
    }
  });

  // Wait for first non-null result
  const settled = await Promise.allSettled(results);
  for (const s of settled) {
    if (s.status === "fulfilled" && s.value && s.value.length > 0) return s.value;
  }
  return [];
}

// ─── DB fetch ───────────────────────────────────────────────────
async function fetchDb(marketId: number, interval: string): Promise<PricePoint[]> {
  if (DB_SKIP_INTERVALS.has(interval)) return [];

  try {
    // Limit DB query to prevent OOM on markets with extensive history
    // 30 days of 15-min data ≈ 2880 rows — well within safe limits
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const dbRows = await prisma.priceHistory.findMany({
      where: { marketId, time: { gte: thirtyDaysAgo } },
      orderBy: { time: "asc" },
      take: 3000,
    });

    const points: PricePoint[] = [];
    for (const row of dbRows) {
      const ts = Math.floor(row.time.getTime() / 1000);
      const mins = new Date(row.time).getMinutes();
      if (interval === "30m" && mins !== 0 && mins !== 30) continue;
      if (interval === "1H" && mins !== 0) continue;
      points.push({ time: ts, price: Number(row.price) });
    }
    return points;
  } catch {
    return [];
  }
}

/**
 * GET /api/markets/[id]/candles?baseAsset=ETH&interval=1H
 *
 * Strategy:
 * - 1m/5m: always Binance (DB doesn't have this granularity)
 * - 15m/30m/1H: DB if >= 1 week of data, otherwise Binance
 * - Binance endpoints raced in parallel for speed
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

  const baseAsset = request.nextUrl.searchParams.get("baseAsset") || "";
  const interval = request.nextUrl.searchParams.get("interval") || "1H";

  // Validate interval and baseAsset before caching
  if (!(interval in BINANCE_INTERVAL)) {
    return NextResponse.json({ error: "Invalid interval" }, { status: 400 });
  }
  if (baseAsset && !(baseAsset.toUpperCase() in BINANCE_MAP)) {
    return NextResponse.json({ error: "Unknown base asset" }, { status: 400 });
  }

  const cacheKey = `${marketId}:${baseAsset}:${interval}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  const binanceSymbol = BINANCE_MAP[baseAsset.toUpperCase()];
  const binanceLimit = BINANCE_LIMIT[interval] || 720;
  const minDbPoints = MIN_DB_POINTS_TO_PREFER[interval] || 168;
  const skipDb = DB_SKIP_INTERVALS.has(interval);

  let points: PricePoint[] = [];

  if (skipDb) {
    // 1m/5m: Binance only, skip DB entirely
    if (binanceSymbol) {
      points = await fetchBinance(binanceSymbol, interval, binanceLimit);
    }
  } else {
    // 15m/30m/1H: fetch DB and Binance in parallel, pick best
    const [dbPoints, binancePoints] = await Promise.all([
      fetchDb(marketId, interval),
      binanceSymbol ? fetchBinance(binanceSymbol, interval, binanceLimit) : Promise.resolve([]),
    ]);

    if (dbPoints.length >= minDbPoints) {
      // DB has enough data (>= 1 week) — use DB as primary
      points = dbPoints;
    } else if (binancePoints.length > 0) {
      points = binancePoints;
    } else if (dbPoints.length > 0) {
      // Binance failed, use whatever DB has
      points = dbPoints;
    }
  }

  // Sort + deduplicate
  points.sort((a, b) => a.time - b.time);
  const seen = new Set<number>();
  const unique = points.filter((p) => {
    if (seen.has(p.time)) return false;
    seen.add(p.time);
    return true;
  });

  const result = { points: unique };
  cache.set(cacheKey, { data: result, time: Date.now() });

  // Evict old cache entries
  if (cache.size > 100) {
    const now = Date.now();
    for (const [key, val] of cache) {
      if (now - val.time > CACHE_TTL * 3) cache.delete(key);
    }
  }

  return NextResponse.json(result);
}
