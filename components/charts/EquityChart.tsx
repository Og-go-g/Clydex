"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  createChart,
  AreaSeries,
  type IChartApi,
  type ISeriesApi,
  type AreaData,
  type Time,
  ColorType,
  CrosshairMode,
} from "lightweight-charts";

// ─── Types ──────────────────────────────────────────────────────

interface EquityPoint {
  time: number;
  balance: number;
}

type Period = "7d" | "30d" | "90d" | "all";

const PERIODS: { key: Period; label: string }[] = [
  { key: "7d", label: "7D" },
  { key: "30d", label: "30D" },
  { key: "90d", label: "90D" },
  { key: "all", label: "All" },
];

// ─── Component ──────────────────────────────────────────────────

export function EquityChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const [period, setPeriod] = useState<Period>("30d");
  const [points, setPoints] = useState<EquityPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoverValue, setHoverValue] = useState<{ time: string; balance: string } | null>(null);

  // ─── Fetch data ─────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/account/equity?period=${period}`);
      if (res.ok) {
        const data = await res.json();
        setPoints(data.points ?? []);
      }
    } catch {
      setPoints([]);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ─── Create chart ───────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#666",
        fontFamily: "'Inter', system-ui, sans-serif",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.03)" },
        horzLines: { color: "rgba(255,255,255,0.03)" },
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: "rgba(16,185,129,0.3)", width: 1, style: 3, labelVisible: false },
        horzLine: { color: "rgba(16,185,129,0.3)", width: 1, style: 3, labelVisible: true },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.05)",
        textColor: "#555",
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.05)",
        timeVisible: true,
        secondsVisible: false,
      },
      handleScale: false,
      handleScroll: false,
    });

    const series = chart.addSeries(AreaSeries, {
      lineColor: "#10b981",
      lineWidth: 2,
      topColor: "rgba(16, 185, 129, 0.25)",
      bottomColor: "rgba(16, 185, 129, 0.02)",
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBackgroundColor: "#10b981",
      priceFormat: {
        type: "custom",
        formatter: (price: number) => "$" + price.toFixed(2),
      },
    });

    // Crosshair hover
    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData) {
        setHoverValue(null);
        return;
      }
      const data = param.seriesData.get(series) as AreaData | undefined;
      if (data && "value" in data) {
        const t = param.time as number;
        const date = new Date(t * 1000);
        setHoverValue({
          time: date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
          balance: "$" + (data.value as number).toFixed(2),
        });
      }
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const onResize = () => {
      chart.applyOptions({ width: container.clientWidth });
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // ─── Update data ────────────────────────────────────────────
  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;

    const chartData: AreaData[] = points.map((p) => ({
      time: p.time as Time,
      value: p.balance,
    }));

    seriesRef.current.setData(chartData);
    chartRef.current.timeScale().fitContent();
  }, [points]);

  // ─── Empty state ────────────────────────────────────────────
  if (!loading && points.length === 0) {
    return null; // Don't render chart if no data
  }

  return (
    <div className="rounded-2xl border border-border bg-card/50 backdrop-blur-sm p-4">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div>
          <span className="text-sm font-semibold text-foreground">Balance</span>
          {hoverValue ? (
            <span className="ml-3 text-xs text-muted">
              {hoverValue.time} — <span className="text-foreground">{hoverValue.balance}</span>
            </span>
          ) : points.length > 0 ? (
            <span className="ml-3 text-xs text-emerald-400">
              ${points[points.length - 1].balance.toFixed(2)}
            </span>
          ) : null}
        </div>
        {/* Period selector */}
        <div className="flex items-center gap-0.5 rounded-md border border-border bg-card p-px">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                period === p.key
                  ? "bg-accent/15 text-accent"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="relative">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
          </div>
        )}
        <div ref={containerRef} style={{ height: 180 }} />
      </div>
    </div>
  );
}
