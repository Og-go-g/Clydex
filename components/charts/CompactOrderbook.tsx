"use client";

/**
 * CompactOrderbook — narrow orderbook used inside ChartPanel.
 *
 * Rendering strategy for the bid/ask bars:
 *
 *   Each row has TWO overlapping bars:
 *     1. A static base bar at low opacity (e.g. bg-green-500/8) that
 *        represents the size proportion at this level.
 *     2. A "flash" overlay at higher opacity, mounted with
 *        key={`${price}-${size}`}. React unmounts + remounts this
 *        element whenever size at a given price changes — and the
 *        CSS animation `ob-flash` restarts from `opacity: 1` and
 *        fades to `opacity: 0` over 600 ms. Net effect: the row
 *        briefly pulses brighter on every update, then settles back
 *        to the static base. Same UX as 01.xyz.
 *
 * Why the static bar exists at all: between flashes, the row should
 * still show a visible size indicator. Without the static bar,
 * unchanged levels would look completely black.
 *
 * The animation is `forwards` so the overlay stays at opacity 0
 * after the keyframe finishes — no flickering between renders.
 */

interface OrderbookLevel {
  price: number;
  size: number;
}

interface CompactOrderbookProps {
  topBids: OrderbookLevel[];
  topAsks: OrderbookLevel[];
  spread: number;
  baseAsset: string;
}

function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

function formatSize(size: number): string {
  if (size >= 1000) return size.toFixed(1);
  if (size >= 1) return size.toFixed(3);
  return size.toFixed(4);
}

export function CompactOrderbook({ topBids, topAsks, spread, baseAsset }: CompactOrderbookProps) {
  // Find max size for bar width normalization across both sides — keeps
  // a 5-ETH bid visually proportional to a 5-ETH ask.
  const allSizes = [...topBids.map((l) => l.size), ...topAsks.map((l) => l.size)];
  const maxSize = Math.max(...allSizes, 0.0001);

  // Asks: lowest at bottom (reversed order)
  const asksReversed = [...topAsks].reverse();

  return (
    <div className="border-t border-[#262626] flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 text-[10px] text-[#555] border-b border-[#262626]">
        <span>Price (USD)</span>
        <span>Size ({baseAsset})</span>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {/* Asks (red) — lowest ask at bottom */}
        <div className="flex-1 flex flex-col justify-end overflow-hidden">
          {asksReversed.map((level) => {
            const pct = (level.size / maxSize) * 100;
            const w = `${Math.min(100, pct)}%`;
            return (
              <div
                key={`a-${level.price}`}
                className="relative flex items-center justify-between px-3 py-[2px] text-[10px] font-mono"
              >
                {/* Static base bar — visible at all times. */}
                <div className="absolute inset-y-0 right-0 bg-red-500/10" style={{ width: w }} />
                {/* Flash overlay — re-keyed by size so React remounts it
                    on each change; the keyframe restarts and fades out. */}
                <div
                  key={`a-flash-${level.size}`}
                  className="absolute inset-y-0 right-0 bg-red-500/40 pointer-events-none"
                  style={{ width: w, animation: "ob-flash 600ms ease-out forwards" }}
                />
                <span className="relative z-10 text-red-400">{formatPrice(level.price)}</span>
                <span className="relative z-10 text-[#888]">{formatSize(level.size)}</span>
              </div>
            );
          })}
        </div>

        {/* Spread */}
        <div className="flex items-center justify-center px-3 py-1 border-y border-[#1a1a1a] bg-[#0a0a0a]">
          <span className="text-[10px] font-mono text-[#555]">
            Spread: {spread > 0 ? formatPrice(spread) : "—"}
          </span>
        </div>

        {/* Bids (green) — highest bid at top */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {topBids.map((level) => {
            const pct = (level.size / maxSize) * 100;
            const w = `${Math.min(100, pct)}%`;
            return (
              <div
                key={`b-${level.price}`}
                className="relative flex items-center justify-between px-3 py-[2px] text-[10px] font-mono"
              >
                <div className="absolute inset-y-0 left-0 bg-green-500/10" style={{ width: w }} />
                <div
                  key={`b-flash-${level.size}`}
                  className="absolute inset-y-0 left-0 bg-green-500/40 pointer-events-none"
                  style={{ width: w, animation: "ob-flash 600ms ease-out forwards" }}
                />
                <span className="relative z-10 text-green-400">{formatPrice(level.price)}</span>
                <span className="relative z-10 text-[#888]">{formatSize(level.size)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
