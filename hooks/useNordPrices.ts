"use client";

/**
 * Multi-symbol live price ticker, routed through the Nord WebSocket
 * singleton manager so the whole app shares one socket regardless of how
 * many components mount.
 *
 * Behavior contract that callers depend on:
 *
 *   - Returns `Record<symbol, price>` of the most recent **trade** print
 *     per symbol — same source as `useNordMarketTicker`. Trade prints
 *     fire only on actual fills (not every quote update), so the stream
 *     is lighter than the orderbook delta stream and matches what users
 *     read as "current price".
 *
 *   - State updates are coalesced through a single `setTimeout` flush
 *     bounded by `throttleMs` (default 250 ms). With 30+ symbols
 *     subscribed, an unthrottled storm of trades during volatility
 *     would otherwise re-render the entire list 30× per tick.
 *
 *   - When `enabled` flips false or `symbols` becomes empty, the effect
 *     tears down all subscriptions and the manager goes idle if no other
 *     listeners remain. Stale entries in the returned map are kept — the
 *     caller's render path filters by the current symbol set anyway.
 *
 *   - Symbol identity is the bare market symbol like "BTCUSD" (NOT
 *     "BTC/USD"), matching the manager's subscribe API.
 */

import { useEffect, useRef, useState } from "react";
import type { WebSocketTradeUpdate } from "@n1xyz/nord-ts";
import { getNordWsManager } from "@/lib/n1/ws-manager";

export type UseNordPricesOptions = {
  enabled?: boolean;
  /** Min ms between React state flushes. 250 ms = 4 updates/sec — fast
   *  enough that prices visibly tick but slow enough that a 30-symbol
   *  list doesn't melt on a moving market. */
  throttleMs?: number;
};

export function useNordPrices(
  symbols: string[],
  opts: UseNordPricesOptions = {},
): Record<string, number> {
  const { enabled = true, throttleMs = 250 } = opts;
  const [prices, setPrices] = useState<Record<string, number>>({});

  // Stable key so the effect re-runs only when the actual symbol set
  // changes — not on every parent render that recreates the array.
  const symbolsKey = [...symbols].sort().join(",");

  const pendingRef = useRef<Record<string, number>>({});
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushRef = useRef(0);

  useEffect(() => {
    if (!enabled || symbols.length === 0) return;

    let cancelled = false;

    const flush = () => {
      flushTimerRef.current = null;
      if (cancelled) return;
      const updates = pendingRef.current;
      pendingRef.current = {};
      const keys = Object.keys(updates);
      if (keys.length === 0) return;
      lastFlushRef.current = Date.now();
      setPrices((prev) => {
        let changed = false;
        const next: Record<string, number> = { ...prev };
        for (const k of keys) {
          if (next[k] !== updates[k]) {
            next[k] = updates[k];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };

    const schedule = () => {
      if (flushTimerRef.current) return;
      const elapsed = Date.now() - lastFlushRef.current;
      const wait = elapsed >= throttleMs ? 0 : throttleMs - elapsed;
      flushTimerRef.current = setTimeout(flush, wait);
    };

    const manager = getNordWsManager();
    const unsubs = symbols.map((sym) =>
      manager.subscribeTrades(sym, (data: WebSocketTradeUpdate) => {
        if (!data.trades || data.trades.length === 0) return;
        // The batch may carry multiple individual prints for the same
        // update_id. The last entry is "current price" — same convention
        // as useNordMarketTicker.
        const last = data.trades[data.trades.length - 1];
        pendingRef.current[sym] = last.price;
        schedule();
      }),
    );

    return () => {
      cancelled = true;
      for (const off of unsubs) off();
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      pendingRef.current = {};
    };
    // symbolsKey covers symbols-array changes; symbols itself is excluded
    // to avoid a fresh effect every render when the parent rebuilds the
    // array but the contents are identical.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolsKey, enabled, throttleMs]);

  return prices;
}
