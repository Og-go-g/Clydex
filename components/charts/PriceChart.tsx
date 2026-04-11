"use client";

import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type LineData,
  type HistogramData,
  type Time,
  ColorType,
  CrosshairMode,
} from "lightweight-charts";
import {
  INTERVALS,
  INTERVAL_BUCKET_SEC,
  type Interval,
  type OHLCVPoint,
} from "@/lib/n1/candles";
import type { CandleUpdate } from "@/hooks/useCandleStream";

// ─── Indicator Types ─────────────────────────────────────────────
export type IndicatorId = "MA7" | "MA25" | "MA99" | "EMA20";

const INDICATOR_COLORS: Record<IndicatorId, string> = {
  MA7: "#f59e0b",   // amber
  MA25: "#6366f1",   // indigo
  MA99: "#ec4899",   // pink
  EMA20: "#06b6d4",  // cyan
};

// ─── Indicator Math ──────────────────────────────────────────────
function computeMA(points: OHLCVPoint[], period: number): LineData<Time>[] {
  const result: LineData<Time>[] = [];
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    sum += points[i].close;
    if (i >= period) sum -= points[i - period].close;
    if (i >= period - 1) {
      result.push({ time: points[i].time as Time, value: sum / period });
    }
  }
  return result;
}

function computeEMA(points: OHLCVPoint[], period: number): LineData<Time>[] {
  if (points.length < period) return [];
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += points[i].close;
  let ema = sum / period;
  const result: LineData<Time>[] = [{ time: points[period - 1].time as Time, value: ema }];
  for (let i = period; i < points.length; i++) {
    ema = points[i].close * k + ema * (1 - k);
    result.push({ time: points[i].time as Time, value: ema });
  }
  return result;
}

function computeVolume(points: OHLCVPoint[]): HistogramData<Time>[] {
  return points.map((p) => ({
    time: p.time as Time,
    value: p.volume,
    color: p.close >= p.open ? "rgba(34, 197, 94, 0.25)" : "rgba(239, 68, 68, 0.25)",
  }));
}

// ─── Chart Actions (exposed via ref) ─────────────────────────────
export interface PriceChartHandle {
  screenshot: () => string | undefined;
  fitContent: () => void;
  toggleCrosshair: () => boolean;
}

// ─── Props ───────────────────────────────────────────────────────
interface TriggerOrder {
  price: number;
  kind: string;
}

interface PriceChartProps {
  marketId: number;
  baseAsset: string;
  currentPrice?: number;
  change24h?: number | null;
  entryPrice?: number;
  liqPrice?: number;
  isLong?: boolean;
  triggerOrders?: TriggerOrder[];
  compact?: boolean;
  candleUpdate?: CandleUpdate | null;
  interval?: Interval;
  onIntervalChange?: (interval: Interval) => void;
  /** Active indicators to overlay on chart */
  indicators?: Set<IndicatorId>;
  /** Show volume histogram below candles */
  showVolume?: boolean;
}

const COLORS = {
  bg: "#0a0a0a",
  text: "#555",
  grid: "#141414",
  border: "#1a1a1a",
  crosshair: "#444",
} as const;

// In-memory cache
const chartCache = new Map<string, { points: OHLCVPoint[]; ts: number }>();
const CACHE_TTL = 2 * 60_000;
const MAX_CACHE_ENTRIES = 50;

export const PriceChart = forwardRef<PriceChartHandle, PriceChartProps>(function PriceChart({
  marketId,
  baseAsset,
  currentPrice,
  change24h,
  entryPrice,
  liqPrice,
  isLong,
  triggerOrders,
  compact,
  candleUpdate,
  interval: controlledInterval,
  onIntervalChange,
  indicators,
  showVolume,
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [loading, setLoading] = useState(true);
  const [pointCount, setPointCount] = useState(0);
  const [internalInterval, setInternalInterval] = useState<Interval>("1H");
  const lastDataTimeRef = useRef<number>(0);
  const dataLoadedRef = useRef(false);
  const activeMarketRef = useRef(`${marketId}`);
  const fitRafRef = useRef(0);
  const crosshairEnabled = useRef(true);
  // Track current OHLCV data for indicator computation
  const currentDataRef = useRef<OHLCVPoint[]>([]);
  // Indicator overlay series
  const indicatorSeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const interval = controlledInterval ?? internalInterval;
  const setInterval = useCallback((i: Interval) => {
    if (onIntervalChange) onIntervalChange(i);
    else setInternalInterval(i);
  }, [onIntervalChange]);

  // ─── Expose chart actions via ref ──────────────────────────────
  useImperativeHandle(ref, () => ({
    screenshot: () => {
      try {
        return chartRef.current?.takeScreenshot().toDataURL();
      } catch { return undefined; }
    },
    fitContent: () => {
      chartRef.current?.timeScale().fitContent();
    },
    toggleCrosshair: () => {
      if (!chartRef.current) return true;
      crosshairEnabled.current = !crosshairEnabled.current;
      chartRef.current.applyOptions({
        crosshair: crosshairEnabled.current ? {
          mode: CrosshairMode.Normal,
          vertLine: { color: COLORS.crosshair, width: 1, style: 3, labelVisible: true, visible: true },
          horzLine: { color: COLORS.crosshair, width: 1, style: 3, labelVisible: true, visible: true },
        } : {
          mode: CrosshairMode.Normal,
          vertLine: { visible: false, labelVisible: false },
          horzLine: { visible: false, labelVisible: false },
        },
      });
      return crosshairEnabled.current;
    },
  }), []);

  // ─── Create chart once on mount ────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: COLORS.bg },
        textColor: COLORS.text,
        fontFamily: "'Inter', system-ui, sans-serif",
        fontSize: compact ? 10 : 11,
      },
      grid: {
        vertLines: { color: compact ? "transparent" : COLORS.grid },
        horzLines: { color: compact ? "#0f0f0f" : COLORS.grid },
      },
      crosshair: compact ? {
        mode: CrosshairMode.Normal,
        vertLine: { visible: false },
        horzLine: { visible: false },
      } : {
        mode: CrosshairMode.Normal,
        vertLine: { color: COLORS.crosshair, width: 1, style: 3, labelVisible: true },
        horzLine: { color: COLORS.crosshair, width: 1, style: 3, labelVisible: true },
      },
      rightPriceScale: {
        borderColor: COLORS.border,
        scaleMargins: { top: 0.1, bottom: showVolume ? 0.25 : 0.1 },
        visible: !compact,
      },
      timeScale: {
        borderColor: COLORS.border,
        timeVisible: !compact,
        secondsVisible: false,
        rightOffset: compact ? 1 : 3,
        visible: !compact,
      },
      handleScroll: !compact,
      handleScale: !compact,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      priceLineVisible: true,
      priceLineWidth: 1,
      priceLineStyle: 2,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    let ro: ResizeObserver | null = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        chart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    ro.observe(container);

    return () => {
      ro?.disconnect(); ro = null;
      cancelAnimationFrame(fitRafRef.current);
      indicatorSeriesRef.current.clear();
      volumeSeriesRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Load OHLCV data ──────────────────────────────────────────
  useEffect(() => {
    if (!seriesRef.current) return;
    let cancelled = false;
    const marketKey = `${marketId}`;

    dataLoadedRef.current = false;
    lastDataTimeRef.current = 0;
    activeMarketRef.current = marketKey;
    cancelAnimationFrame(fitRafRef.current);

    const cacheKey = `${marketId}:${interval}`;

    function applyPoints(points: OHLCVPoint[]) {
      if (cancelled || activeMarketRef.current !== marketKey) return;
      currentDataRef.current = points;
      const candleData: CandlestickData<Time>[] = points.map((p) => ({
        time: p.time as Time, open: p.open, high: p.high, low: p.low, close: p.close,
      }));
      try { seriesRef.current?.setData(candleData); } catch { return; }
      setPointCount(candleData.length);
      if (points.length > 0) lastDataTimeRef.current = points[points.length - 1].time;
      dataLoadedRef.current = true;
      cancelAnimationFrame(fitRafRef.current);
      fitRafRef.current = requestAnimationFrame(() => { chartRef.current?.timeScale().fitContent(); });
    }

    try { seriesRef.current?.setData([]); } catch { /* disposing */ }

    const cached = chartCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) { applyPoints(cached.points); setLoading(false); return; }
    if (cached) chartCache.delete(cacheKey);

    setLoading(true); setPointCount(0);

    async function load() {
      try {
        const res = await fetch(`/api/markets/${marketId}/candles?interval=${interval}`);
        if (!res.ok || cancelled) return;
        const data = await res.json() as { points: OHLCVPoint[] };
        if (cancelled || !data.points?.length) return;
        chartCache.set(cacheKey, { points: data.points, ts: Date.now() });
        if (chartCache.size > MAX_CACHE_ENTRIES) {
          let oldestKey: string | null = null, oldestTs = Infinity;
          for (const [k, v] of chartCache) { if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; } }
          if (oldestKey) chartCache.delete(oldestKey);
        }
        applyPoints(data.points);
      } catch { /* silent */ } finally { if (!cancelled) setLoading(false); }
    }

    load();
    return () => { cancelled = true; };
  }, [marketId, interval]);

  // ─── Indicator overlays (MA, EMA) ─────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !dataLoadedRef.current) return;
    const data = currentDataRef.current;
    const active = indicators ?? new Set<IndicatorId>();

    // Remove series that are no longer active
    for (const [id, series] of indicatorSeriesRef.current) {
      if (!active.has(id as IndicatorId)) {
        try { chart.removeSeries(series); } catch { /* already removed */ }
        indicatorSeriesRef.current.delete(id);
      }
    }

    // Add/update active indicators
    for (const id of active) {
      let lineData: LineData<Time>[];
      switch (id) {
        case "MA7": lineData = computeMA(data, 7); break;
        case "MA25": lineData = computeMA(data, 25); break;
        case "MA99": lineData = computeMA(data, 99); break;
        case "EMA20": lineData = computeEMA(data, 20); break;
        default: continue;
      }

      let series = indicatorSeriesRef.current.get(id);
      if (!series) {
        series = chart.addSeries(LineSeries, {
          color: INDICATOR_COLORS[id],
          lineWidth: 1,
          crosshairMarkerVisible: false,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        indicatorSeriesRef.current.set(id, series);
      }
      try { series.setData(lineData); } catch { /* ignore */ }
    }
  }, [indicators, pointCount]); // pointCount changes when data loads

  // ─── Volume histogram ──────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (showVolume && dataLoadedRef.current) {
      if (!volumeSeriesRef.current) {
        volumeSeriesRef.current = chart.addSeries(HistogramSeries, {
          priceFormat: { type: "volume" },
          priceScaleId: "volume",
          priceLineVisible: false,
          lastValueVisible: false,
        });
        chart.priceScale("volume").applyOptions({
          scaleMargins: { top: 0.8, bottom: 0 },
          visible: false,
        });
        // Adjust main scale to leave room for volume
        chart.priceScale("right").applyOptions({
          scaleMargins: { top: 0.1, bottom: 0.25 },
        });
      }
      const volData = computeVolume(currentDataRef.current);
      try { volumeSeriesRef.current.setData(volData); } catch { /* ignore */ }
    } else if (!showVolume && volumeSeriesRef.current) {
      try { chart.removeSeries(volumeSeriesRef.current); } catch { /* ignore */ }
      volumeSeriesRef.current = null;
      // Restore main scale margins
      chart.priceScale("right").applyOptions({
        scaleMargins: { top: 0.1, bottom: 0.1 },
      });
    }
  }, [showVolume, pointCount]);

  // ─── Live candle updates ───────────────────────────────────────
  useEffect(() => {
    if (!seriesRef.current || !dataLoadedRef.current) return;
    if (activeMarketRef.current !== `${marketId}`) return;

    if (candleUpdate && typeof candleUpdate.c === "number") {
      const safeTime = Math.max(candleUpdate.t, lastDataTimeRef.current);
      lastDataTimeRef.current = safeTime;
      try {
        seriesRef.current.update({
          time: safeTime as Time, open: candleUpdate.o, high: candleUpdate.h, low: candleUpdate.l, close: candleUpdate.c,
        });
      } catch { /* ignore */ }
      return;
    }

    if (!currentPrice) return;
    const now = Math.floor(Date.now() / 1000);
    const bucketSec = INTERVAL_BUCKET_SEC[interval] ?? 3600;
    const snapped = Math.floor(now / bucketSec) * bucketSec;
    const safeTime = Math.max(snapped, lastDataTimeRef.current);
    lastDataTimeRef.current = safeTime;
    try {
      seriesRef.current.update({
        time: safeTime as Time, open: currentPrice, high: currentPrice, low: currentPrice, close: currentPrice,
      });
    } catch { /* ignore */ }
  }, [currentPrice, candleUpdate, interval, marketId]);

  // ─── Position overlay lines ────────────────────────────────────
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    try { const existing = series.priceLines(); for (const line of existing) series.removePriceLine(line); } catch { /* disposing */ }

    if (entryPrice && entryPrice > 0) {
      series.createPriceLine({ price: entryPrice, color: "#ffffff", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "Entry" });
    }
    if (liqPrice && liqPrice > 0) {
      series.createPriceLine({ price: liqPrice, color: "#ef4444", lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: "Liq" });
    }
    if (triggerOrders) {
      for (const order of triggerOrders) {
        if (!order.price || order.price <= 0) continue;
        const isTp = order.kind.toLowerCase().includes("take") || order.kind.toLowerCase().includes("tp");
        series.createPriceLine({ price: order.price, color: isTp ? "#22c55e" : "#f59e0b", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: isTp ? "TP" : "SL" });
      }
    }
  }, [entryPrice, liqPrice, triggerOrders]);

  return (
    <div className={compact ? "bg-transparent overflow-hidden" : "flex flex-col h-full rounded-2xl border border-border bg-card/50 backdrop-blur-sm overflow-hidden"}>
      {!compact && (
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <div className="flex items-center gap-1">
            {INTERVALS.map((i) => (
              <button
                key={i}
                onClick={() => setInterval(i)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  i === interval ? "bg-[#1f1f1f] text-white" : "text-[#666] hover:text-[#999] hover:bg-[#141414]"
                }`}
              >
                {i}
              </button>
            ))}
          </div>
          <span className="text-[10px] text-[#444]">
            {pointCount > 0 ? `${pointCount} pts` : ""}
          </span>
        </div>
      )}
      <div className="relative flex-1 min-h-0">
        <div ref={containerRef} className={compact ? "h-[120px] w-full" : "h-full min-h-[200px] w-full"} />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0a]/80">
            <div className="flex items-center gap-2 text-sm text-[#666]">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-[#333] border-t-[#888]" />
              Loading...
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
