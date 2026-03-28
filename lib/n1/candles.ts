// ─── OHLCV Candle Types & N1 Resolution Mapping ─────────────────
// Used by candle API route, PriceChart, and useCandleStream hook.

/** A single OHLCV bar from the N1 /tv/history endpoint. */
export interface OHLCVPoint {
  time: number;   // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // quote volume
}

/** UI interval labels shown in the chart toolbar. */
export type Interval = "1m" | "5m" | "15m" | "30m" | "1H" | "4H" | "1D" | "1W" | "1M";

/** Ordered list for toolbar rendering. */
export const INTERVALS: Interval[] = [
  "1m", "5m", "15m", "30m", "1H", "4H", "1D", "1W", "1M",
];

/**
 * Map UI interval → N1 /tv/history `resolution` param.
 * N1 uses minutes for sub-day ("1","5","15","30","60") and
 * period codes for longer ("4H","1D","1W","1M").
 */
export const INTERVAL_TO_N1: Record<Interval, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1H": "60",
  "4H": "4H",
  "1D": "1D",
  "1W": "1W",
  "1M": "1M",
};

/** Bucket size in seconds for each interval — used for WS live candle time-snapping. */
export const INTERVAL_BUCKET_SEC: Record<Interval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1H": 3600,
  "4H": 14400,
  "1D": 86400,
  "1W": 604800,
  "1M": 2592000,
};

/** Set of valid interval strings for fast validation. */
export const VALID_INTERVALS = new Set<string>(INTERVALS);
