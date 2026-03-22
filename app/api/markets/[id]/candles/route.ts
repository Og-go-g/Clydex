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
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1H": "1h",
};

// Binance candle limits per interval
const BINANCE_LIMIT: Record<string, number> = {
  "1m": 360,   // 6 hours of 1m candles
  "5m": 500,   // ~1.7 days of 5m candles
  "15m": 500,  // ~5 days of 15m candles
  "30m": 500,  // ~10 days
  "1H": 720,   // ~30 days
};

// Minimum DB points needed before we prefer DB over Binance.
// Until our DB has a week of data, Binance is primary.
// For 1m/5m we never use DB (DB stores 15-min granularity).
const MIN_DB_POINTS_TO_PREFER: Record<string, number> = {
  "1m": Infinity,  // DB doesn't have 1m data — always Binance
  "5m": Infinity,  // DB doesn't have 5m data — always Binance
  "15m": 672,      // 7 days × 24h × 4 = 672
  "30m": 336,      // 7 days × 24h × 2 = 336
  "1H": 168,       // 7 days × 24h = 168
};

// Cache: per-key, 5 min TTL
const cache = new Map<string, { data: unknown; time: number }>();
const CACHE_TTL = 300_000;

interface PricePoint {
  time: number;
  price: number;
}

/**
 * GET /api/markets/[id]/candles?baseAsset=ETH&interval=1H
 *
 * Chart data strategy:
 * 1. BINANCE is always the PRIMARY source (1 month of data)
 * 2. DB is used ONLY when it has >= 1 week of data (after deployment accumulates)
 * 3. When DB has enough data, DB replaces Binance entirely
 * 4. Over time: deploy → accumulate → 1 week DB → DB becomes primary → 1 year DB = 1 year chart
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
  const cacheKey = `${marketId}:${baseAsset}:${interval}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  let points: PricePoint[] = [];
  const minDbPoints = MIN_DB_POINTS_TO_PREFER[interval] || 168;

  // ── 1. Check DB first — use it only if we have >= 1 week of data ──
  let dbPoints: PricePoint[] = [];
  try {
    const dbRows = await prisma.priceHistory.findMany({
      where: { marketId },
      orderBy: { time: "asc" },
    });

    // DB stores 15-min data — skip DB entirely for 1m/5m intervals
    if (interval !== "1m" && interval !== "5m") {
      for (const row of dbRows) {
        const ts = Math.floor(row.time.getTime() / 1000);
        const mins = new Date(row.time).getMinutes();
        if (interval === "30m" && mins !== 0 && mins !== 30) continue;
        if (interval === "1H" && mins !== 0) continue;
        dbPoints.push({ time: ts, price: Number(row.price) });
      }
    }
  } catch {
    // DB unavailable — will use Binance
  }

  // ── 2. Decision: DB or Binance? ────────────────────────────────
  if (dbPoints.length >= minDbPoints) {
    // DB has enough data (>= 1 week) — use DB as primary
    // This means: after deployment, once we accumulate a week of data,
    // we switch to our own data permanently. 1 year of running = 1 year chart.
    points = dbPoints;
  } else {
    // DB doesn't have enough — use Binance as primary (up to 1 month)
    const binanceSymbol = BINANCE_MAP[baseAsset.toUpperCase()];
    const binanceInterval = BINANCE_INTERVAL[interval] || "1h";
    const binanceLimit = BINANCE_LIMIT[interval] || 720;

    if (binanceSymbol) {
      try {
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${binanceSymbol}&interval=${binanceInterval}&limit=${binanceLimit}`;
        let res = await fetch(url);
        if (!res.ok) {
          // Fallback to spot API if futures API fails
          res = await fetch(
            `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${binanceInterval}&limit=${binanceLimit}`
          );
        }
        if (res.ok) {
          const raw = (await res.json()) as unknown[];
          for (const k of raw) {
            if (!Array.isArray(k) || k.length < 5) continue;
            // k[0] = open time (ms), k[4] = close price
            const t = Math.floor(Number(k[0]) / 1000);
            const price = Number(k[4]);
            if (!isFinite(t) || !isFinite(price) || price <= 0) continue;
            points.push({ time: t, price });
          }
        }
      } catch {
        // Binance unavailable
      }
    }

    // If Binance returned nothing and DB has some data, use whatever DB has
    if (points.length === 0 && dbPoints.length > 0) {
      points = dbPoints;
    }
  }

  // ── 3. Sort + deduplicate ──────────────────────────────────────
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
