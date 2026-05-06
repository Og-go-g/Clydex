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

// Spread is shown next to its label, not as a price level — it's
// always small relative to price scale, so 6 decimals reads as noise.
// 2 decimals matches how spread is conventionally quoted (e.g. "$0.10").
function formatSpread(spread: number): string {
  if (spread >= 1) return spread.toFixed(2);
  if (spread >= 0.01) return spread.toFixed(3);
  return spread.toFixed(4);
}

function formatSize(size: number): string {
  if (size >= 1000) return size.toFixed(1);
  if (size >= 1) return size.toFixed(3);
  return size.toFixed(4);
}

export function CompactOrderbook({ topBids, topAsks, spread, baseAsset }: CompactOrderbookProps) {
  // Per-side normalization: one whale level on the bid side shouldn't
  // squash all the asks into invisible 2 % bars (and vice versa). Each
  // side scales against its own max — same convention 01.xyz uses.
  const maxBidSize = Math.max(...topBids.map((l) => l.size), 0.0001);
  const maxAskSize = Math.max(...topAsks.map((l) => l.size), 0.0001);

  // Asks: lowest at bottom (reversed order)
  const asksReversed = [...topAsks].reverse();

  return (
    <div className="border-t border-[#262626] flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1 text-[10px] text-[#555] border-b border-[#262626]">
        <span>Price (USD)</span>
        <span>Size ({baseAsset})</span>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {/* Asks (red) — lowest ask at bottom */}
        <div className="flex-1 flex flex-col justify-end overflow-hidden">
          {asksReversed.map((level) => {
            const pct = (level.size / maxAskSize) * 100;
            const w = `${Math.min(100, pct)}%`;
            return (
              <div
                key={`a-${level.price}`}
                className="relative flex items-center justify-between px-3 py-[2px] text-[10px] font-mono"
              >
                {/* Static base bar — kept very subtle so the resting
                    state doesn't shout colour at the user. */}
                <div className="absolute inset-y-0 right-0 bg-red-500/[0.06]" style={{ width: w }} />
                {/* Flash overlay — re-keyed by size so React remounts it
                    on each change; the keyframe restarts and fades out
                    quickly enough to feel responsive (~300 ms). */}
                <div
                  key={`a-flash-${level.size}`}
                  className="absolute inset-y-0 right-0 bg-red-500/[0.18] pointer-events-none"
                  style={{ width: w, animation: "ob-flash 320ms ease-out forwards" }}
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
            Spread: {spread > 0 ? formatSpread(spread) : "—"}
          </span>
        </div>

        {/* Bids (green) — highest bid at top */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {topBids.map((level) => {
            const pct = (level.size / maxBidSize) * 100;
            const w = `${Math.min(100, pct)}%`;
            return (
              <div
                key={`b-${level.price}`}
                className="relative flex items-center justify-between px-3 py-[2px] text-[10px] font-mono"
              >
                <div className="absolute inset-y-0 left-0 bg-green-500/[0.06]" style={{ width: w }} />
                <div
                  key={`b-flash-${level.size}`}
                  className="absolute inset-y-0 left-0 bg-green-500/[0.18] pointer-events-none"
                  style={{ width: w, animation: "ob-flash 320ms ease-out forwards" }}
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
