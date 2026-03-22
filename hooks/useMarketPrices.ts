"use client";

import { useState, useEffect, useRef, useCallback } from "react";

/**
 * Real-time market prices via polling with exponential backoff on errors.
 *
 * Why polling instead of raw WebSocket here:
 * The N1 WebSocket SDK (`getNord()`) requires server-side initialization
 * (Solana Connection, etc.) which cannot run in the browser. So we poll
 * the /api/markets/:id endpoint instead, with a fast interval (5s) that
 * backs off on repeated failures.
 *
 * For orderbook deltas and trade feeds on the detail page, we'll use
 * the WebSocket directly via a server-sent-events bridge in a future phase.
 */

export interface MarketPrice {
  marketId: number;
  markPrice: number | null;
  indexPrice: number | null;
  change24h: number | null;
  volume24h: number | null;
  fundingRate: number | null;
  updatedAt: number;
}

interface UseMarketPricesOptions {
  /** Market IDs to track */
  marketIds: number[];
  /** Polling interval in ms (default 5000) */
  interval?: number;
  /** Whether to enable polling (default true) */
  enabled?: boolean;
}

export function useMarketPrices({
  marketIds,
  interval = 5000,
  enabled = true,
}: UseMarketPricesOptions) {
  const [prices, setPrices] = useState<Map<number, MarketPrice>>(new Map());
  const [isConnected, setIsConnected] = useState(false);
  const failCountRef = useRef(0);
  const inFlightRef = useRef(false);
  const maxBackoff = 30_000;

  const fetchPrices = useCallback(async () => {
    if (marketIds.length === 0) return;
    // Prevent cascading fetches — skip if a request is already in-flight
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    try {
      const results = await Promise.allSettled(
        marketIds.map(async (id) => {
          const res = await fetch(`/api/markets/${id}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const stats = await res.json();
          const perp = stats.perpStats;
          return {
            marketId: id,
            markPrice: perp?.mark_price ?? stats.indexPrice ?? null,
            indexPrice: stats.indexPrice ?? null,
            change24h:
              stats.close24h && stats.prevClose24h
                ? ((stats.close24h - stats.prevClose24h) / stats.prevClose24h) * 100
                : null,
            volume24h: stats.volumeQuote24h ?? null,
            fundingRate: perp?.funding_rate ?? null,
            updatedAt: Date.now(),
          } satisfies MarketPrice;
        })
      );

      setPrices((prev) => {
        const next = new Map(prev);
        for (const result of results) {
          if (result.status === "fulfilled") {
            next.set(result.value.marketId, result.value);
          }
        }
        return next;
      });

      failCountRef.current = 0;
      setIsConnected(true);
    } catch {
      failCountRef.current += 1;
      if (failCountRef.current > 3) setIsConnected(false);
    } finally {
      inFlightRef.current = false;
    }
  }, [marketIds]);

  useEffect(() => {
    if (!enabled || marketIds.length === 0) return;

    // Initial fetch
    fetchPrices();

    // Polling with backoff
    const getInterval = () => {
      if (failCountRef.current === 0) return interval;
      return Math.min(interval * Math.pow(2, failCountRef.current), maxBackoff);
    };

    let timeoutId: ReturnType<typeof setTimeout>;
    function schedule() {
      timeoutId = setTimeout(async () => {
        await fetchPrices();
        schedule();
      }, getInterval());
    }
    schedule();

    return () => clearTimeout(timeoutId);
  }, [enabled, marketIds, interval, fetchPrices]);

  const getPrice = useCallback(
    (marketId: number): MarketPrice | undefined => prices.get(marketId),
    [prices]
  );

  return { prices, getPrice, isConnected };
}

/**
 * Hook for a single market's price — convenience wrapper.
 */
export function useMarketPrice(marketId: number, enabled = true) {
  const ids = [marketId];
  const { getPrice, isConnected } = useMarketPrices({
    marketIds: ids,
    enabled,
  });
  return { price: getPrice(marketId) ?? null, isConnected };
}
