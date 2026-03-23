"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
  ColorType,
  CrosshairMode,
  LineType,
} from "lightweight-charts";

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
  /** Compact mode: no toolbar, smaller height, minimal UI */
  compact?: boolean;
}

type Interval = "1m" | "5m" | "15m" | "30m" | "1H";

const INTERVALS: Interval[] = ["1m", "5m", "15m", "30m", "1H"];

const COLORS = {
  bg: "#0a0a0a",
  text: "#555",
  grid: "#141414",
  border: "#1a1a1a",
  crosshair: "#444",
  line: "#6366f1",
} as const;

interface PricePoint {
  time: number;
  price: number;
}

// In-memory cache: switching pairs is instant after first load.
// Entries expire after 2 minutes so live data stays fresh.
const chartCache = new Map<string, { points: PricePoint[]; ts: number }>();
const CACHE_TTL = 2 * 60_000;

export function PriceChart({ marketId, baseAsset, currentPrice, change24h, entryPrice, liqPrice, isLong, triggerOrders, compact }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const [loading, setLoading] = useState(true);
  const [pointCount, setPointCount] = useState(0);
  const [interval, setChartInterval] = useState<Interval>("1H");
  const lastDataTimeRef = useRef<number>(0);
  const dataLoadedRef = useRef(false);

  const isNegative = change24h != null && change24h < 0;

  // Create chart once
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
        scaleMargins: { top: 0.1, bottom: 0.1 },
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

    const lineColor = isNegative ? "#ef4444" : "#22c55e";

    const series = chart.addSeries(LineSeries, {
      color: lineColor,
      lineWidth: 2,
      lineType: LineType.Curved,
      crosshairMarkerVisible: false,
      priceLineVisible: true,
      priceLineColor: lineColor,
      priceLineWidth: 1,
      priceLineStyle: 2,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    // Hide TradingView attribution logo (allowed under Apache 2.0 license)
    const logoEl = container.querySelector('a[href*="tradingview"]');
    if (logoEl) (logoEl as HTMLElement).style.display = "none";
    // Also hide via MutationObserver in case it's added after initial render
    let mo: MutationObserver | null = new MutationObserver(() => {
      const el = container.querySelector('a[href*="tradingview"]');
      if (el) (el as HTMLElement).style.display = "none";
    });
    mo.observe(container, { childList: true, subtree: true });

    let ro: ResizeObserver | null = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        chart.applyOptions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    ro.observe(container);

    return () => {
      mo?.disconnect();
      mo = null;
      ro?.disconnect();
      ro = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // Recreate chart when change24h sign flips (color change)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNegative]);

  // Load data when interval or market changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPointCount(0);
    dataLoadedRef.current = false;
    lastDataTimeRef.current = 0;
    seriesRef.current?.setData([]);

    function applyPoints(points: PricePoint[]) {
      const lineData: LineData<Time>[] = points.map((p) => ({
        time: p.time as Time,
        value: p.price,
      }));
      seriesRef.current?.setData(lineData);
      setPointCount(lineData.length);
      if (points.length > 0) {
        lastDataTimeRef.current = points[points.length - 1].time;
      }
      dataLoadedRef.current = true;
      requestAnimationFrame(() => {
        chartRef.current?.timeScale().fitContent();
      });
    }

    async function load() {
      const cacheKey = `${marketId}:${interval}`;
      // Check in-memory cache — instant switch between pairs
      const cached = chartCache.get(cacheKey);
      if (cached) {
        if (Date.now() - cached.ts < CACHE_TTL) {
          if (cancelled) return;
          applyPoints(cached.points);
          setLoading(false);
          return;
        }
        // Expired — remove stale entry before fetching fresh data
        chartCache.delete(cacheKey);
      }

      try {
        const res = await fetch(
          `/api/markets/${marketId}/candles?baseAsset=${baseAsset}&interval=${interval}`
        );
        if (!res.ok || cancelled) return;
        const data = await res.json() as { points: PricePoint[] };
        if (cancelled || !data.points?.length) return;

        // Store in cache
        chartCache.set(cacheKey, { points: data.points, ts: Date.now() });
        applyPoints(data.points);
      } catch {
        // silent
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [marketId, baseAsset, interval]);

  // Update chart with live WS price — updates the latest candle only.
  // lightweight-charts requires update time >= last data point time.
  useEffect(() => {
    if (!currentPrice || !seriesRef.current || !dataLoadedRef.current) return;
    const now = Math.floor(Date.now() / 1000);
    const bucketSec = interval === "1m" ? 60 : interval === "5m" ? 300 : interval === "15m" ? 900 : interval === "30m" ? 1800 : 3600;
    const snapped = Math.floor(now / bucketSec) * bucketSec;
    const safeTime = Math.max(snapped, lastDataTimeRef.current);
    lastDataTimeRef.current = safeTime;
    try {
      seriesRef.current.update({ time: safeTime as Time, value: currentPrice });
    } catch {
      // "Cannot update oldest data" — ignore
    }
  }, [currentPrice, interval]);

  // Position overlay lines (entry, liquidation, TP/SL)
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    // Remove all existing price lines first
    const existing = series.priceLines();
    for (const line of existing) {
      series.removePriceLine(line);
    }

    // Entry price — white dashed line
    if (entryPrice && entryPrice > 0) {
      series.createPriceLine({
        price: entryPrice,
        color: "#ffffff",
        lineWidth: 1,
        lineStyle: 2, // dashed
        axisLabelVisible: true,
        title: "Entry",
      });
    }

    // Liquidation price — red solid line
    if (liqPrice && liqPrice > 0) {
      series.createPriceLine({
        price: liqPrice,
        color: "#ef4444",
        lineWidth: 1,
        lineStyle: 0, // solid
        axisLabelVisible: true,
        title: "Liq",
      });
    }

    // Trigger orders (TP/SL)
    if (triggerOrders) {
      for (const order of triggerOrders) {
        if (!order.price || order.price <= 0) continue;
        const isTakeProfit = order.kind.toLowerCase().includes("take") ||
          order.kind.toLowerCase().includes("tp");
        series.createPriceLine({
          price: order.price,
          color: isTakeProfit ? "#22c55e" : "#f59e0b",
          lineWidth: 1,
          lineStyle: 2, // dashed
          axisLabelVisible: true,
          title: isTakeProfit ? "TP" : "SL",
        });
      }
    }
  }, [entryPrice, liqPrice, triggerOrders]);

  const handleInterval = useCallback((i: Interval) => {
    setChartInterval(i);
  }, []);

  return (
    <div className={compact ? "bg-[#0a0a0a] overflow-hidden" : "rounded-xl border border-[#262626] bg-[#0a0a0a] overflow-hidden"}>
      {/* Toolbar — hidden in compact mode */}
      {!compact && (
        <div className="flex items-center justify-between border-b border-[#1a1a1a] px-4 py-2">
          <div className="flex items-center gap-1">
            {INTERVALS.map((i) => (
              <button
                key={i}
                onClick={() => handleInterval(i)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  i === interval
                    ? "bg-[#1f1f1f] text-white"
                    : "text-[#666] hover:text-[#999] hover:bg-[#141414]"
                }`}
              >
                {i}
              </button>
            ))}
          </div>
          <span className="text-[10px] text-[#444]">
            {pointCount > 0 ? `${pointCount} points` : ""}
          </span>
        </div>
      )}

      {/* Chart */}
      <div className="relative">
        <div ref={containerRef} className={compact ? "h-[120px] w-full" : "h-[300px] w-full"} />
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
}
