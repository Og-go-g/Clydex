/**
 * Worst-acceptable-price computation for market orders.
 *
 * The previous implementation derived the IOC price ceiling/floor from
 * mark price: `markPrice * (1 ± slippagePct)`. On illiquid markets
 * (Tier 3–5 on 01 Exchange) the spread can be 50–200 bps and the mark
 * sits inside the spread, so the user's slippage budget gets consumed
 * by the spread before any fill happens — the order partially fills
 * (or doesn't fill at all) and the user sees worse-than-promised
 * execution.
 *
 * Industry standard (Drift's "Best Bid/Ask" auction reference, Bybit /
 * BingX max-slippage limits, generally any L1-quote-based slippage
 * protection) is to anchor on the best opposite quote:
 *   buy  → bestAsk * (1 + slippage)
 *   sell → bestBid * (1 - slippage)
 *
 * That way the user's slippage budget is "true slippage past the
 * touch" — they can fill at any level up to that many bps deeper into
 * the book.
 *
 * Safety clamp ±5% from mark: if the orderbook is empty / stale /
 * manipulated, the best opposite quote can be wildly off-mark. We
 * clamp the resulting worst-price into a ±5% window around mark so a
 * pathological book doesn't translate a "0.5% slippage" request into
 * a 50% slippage fill. Empty-side is failed-closed (throw) — falling
 * back to mark would silently re-introduce the original bug.
 */

import { Side } from "@n1xyz/nord-ts";

/**
 * Maximum allowed deviation between the computed worst-price and the
 * mark price. Acts as a safety clamp for stale / empty / manipulated
 * books — without it a phantom best-opposite quote could push the
 * worst-acceptable price arbitrarily far from mark.
 *
 * 5% covers normal market dislocations (a typical halt or volatile
 * minute on liquid pairs sits inside this band) and still constrains
 * pathological cases.
 */
export const SLIPPAGE_MAX_DEVIATION = 0.05;

export interface SlippageInputs {
  /** Order side. SDK's Side.Bid = buy/long, Side.Ask = sell/short. */
  side: Side;
  /** Best ask price (first level on the asks side). null when empty. */
  bestAsk: number | null | undefined;
  /** Best bid price (first level on the bids side). null when empty. */
  bestBid: number | null | undefined;
  /** Current mark price (for the safety clamp). */
  markPrice: number;
  /** Slippage as a fraction, e.g. 0.005 for 0.5%. Must be ≥ 0. */
  slippage: number;
}

/**
 * Compute the worst acceptable fill price for an IOC market order.
 *
 * Pure function — separated from the orderbook fetch so it can be
 * unit-tested without I/O. Returns the price to pass as `price` to
 * `NordUser.placeOrder` (IOC will fill up to this and cancel the rest).
 *
 * Throws on:
 *   - non-positive markPrice (can't anchor the safety clamp)
 *   - empty opposite side (no quote to anchor against)
 *   - negative slippage (caller bug)
 */
export function computeWorstPrice(inputs: SlippageInputs): number {
  const { side, bestAsk, bestBid, markPrice, slippage } = inputs;

  if (slippage < 0) {
    throw new Error("slippage must be ≥ 0");
  }
  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    throw new Error("markPrice must be > 0");
  }

  const isBuy = side === Side.Bid;
  const oppositeQuote = isBuy ? bestAsk : bestBid;

  if (oppositeQuote == null || !Number.isFinite(oppositeQuote) || oppositeQuote <= 0) {
    // Fail-closed: no opposite quote → no order. Falling back to mark
    // would silently re-introduce the bug we're fixing.
    throw new Error(
      `Cannot compute worst price: best ${isBuy ? "ask" : "bid"} is empty`,
    );
  }

  const worstFromBook = isBuy
    ? oppositeQuote * (1 + slippage)
    : oppositeQuote * (1 - slippage);

  // Safety clamp ±SLIPPAGE_MAX_DEVIATION from mark.
  const upper = markPrice * (1 + SLIPPAGE_MAX_DEVIATION);
  const lower = markPrice * (1 - SLIPPAGE_MAX_DEVIATION);
  return Math.max(lower, Math.min(upper, worstFromBook));
}

/* ------------------------------------------------------------------ */
/*  Cached orderbook fetch                                            */
/* ------------------------------------------------------------------ */

const OB_TTL_MS = 3_000;
const OB_STALE_MS = 60_000;

interface CachedBook {
  bestBid: number | null;
  bestAsk: number | null;
  time: number;
}

const obCache = new Map<number, CachedBook>();

/**
 * Fetch the best bid/ask for a market with a small per-process cache.
 * 3s TTL matches `/api/markets/[id]/orderbook` to keep the spread view
 * latency-consistent across consumers. On fetch failure within
 * OB_STALE_MS we return the stale entry — the worst-price function
 * still has the ±5% clamp so a stale book can't escape.
 *
 * Returns nulls in either slot when the side is empty.
 */
export async function fetchBestQuotes(
  marketId: number,
): Promise<{ bestBid: number | null; bestAsk: number | null; fresh: boolean }> {
  const now = Date.now();
  const cached = obCache.get(marketId);
  if (cached && now - cached.time < OB_TTL_MS) {
    return { bestBid: cached.bestBid, bestAsk: cached.bestAsk, fresh: true };
  }

  try {
    const { getOrderbook } = await import("./client");
    const ob = await getOrderbook({ marketId });
    const bestBid = ob.bids?.[0]?.[0] ?? null;
    const bestAsk = ob.asks?.[0]?.[0] ?? null;
    obCache.set(marketId, { bestBid, bestAsk, time: now });

    // Cap cache size — evict anything outside the stale window.
    if (obCache.size > 50) {
      for (const [k, v] of obCache) {
        if (now - v.time > OB_STALE_MS) obCache.delete(k);
      }
    }
    return { bestBid, bestAsk, fresh: true };
  } catch (err) {
    if (cached && now - cached.time < OB_STALE_MS) {
      return { bestBid: cached.bestBid, bestAsk: cached.bestAsk, fresh: false };
    }
    throw err;
  }
}

/** Exposed for tests — never call in production. */
export function __resetOrderbookCacheForTests(): void {
  obCache.clear();
}
