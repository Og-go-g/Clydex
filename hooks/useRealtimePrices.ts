"use client";

import { useEffect, useRef, useState, useCallback } from "react";

const WS_BASE = "wss://zo-mainnet.n1.xyz/ws";
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000];
const MAX_RECONNECT_ATTEMPTS = 20; // ~5 min total with backoff

interface OrderLevel {
  price: number;
  size: number;
}

/**
 * Real-time mid-price updates via N1 WebSocket orderbook deltas.
 * Maintains a sorted price-level book per symbol, correctly handling
 * level additions, updates, and removals (size=0).
 * Mid price = (best_bid + best_ask) / 2, throttled to ~1 update/sec.
 *
 * @deprecated Phase 6: opens a dedicated WebSocket per call. Multiple
 *   call sites (portfolio chunks, chat chunks, markets chunks,
 *   ClosePositionModal) currently each get their own socket — at typical
 *   usage that's 4-7 concurrent N1 sockets per signed-in user, undoing
 *   most of the multiplexing win the rest of the migration delivers.
 *
 *   Migration plan (separate "Phase 8" — not yet started):
 *     1. Single-symbol callers (markets/[id] live price fallback,
 *        ClosePositionModal) → swap to `useNordMarketTicker`.
 *     2. Multi-symbol callers using chunked patterns (portfolio,
 *        chat, markets list) → introduce a multi-symbol thin wrapper
 *        (e.g. `useNordTrades(symbols)`) that subscribes through the
 *        manager. Mind plan risk R8 ("60+ subs in one URL hangs
 *        server"): chunks of ~30 symbols should still work, but the
 *        markets-list page should probably stay on REST 60s rather
 *        than bulk-subscribing to all 60+ markets.
 *     3. Once no callers remain, delete this file.
 */
export function useRealtimePrices(symbols: string[]) {
  const [prices, setPrices] = useState<Record<string, number>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable key without mutating input array
  const symbolsKey = [...symbols].sort().join(",");
  const destroyedRef = useRef(false);
  // Full orderbook per symbol: Map<price, size>
  const bookRef = useRef<Record<string, { bids: Map<number, number>; asks: Map<number, number> }>>({});
  // Time-based throttle: ~1 update per second
  const lastUpdateRef = useRef(0);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cleanup = useCallback(() => {
    destroyedRef.current = true;
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (pendingRef.current) {
      clearTimeout(pendingRef.current);
      pendingRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (symbols.length === 0) return;

    destroyedRef.current = false;
    bookRef.current = {};
    lastUpdateRef.current = 0;
    reconnectAttempt.current = 0;
    if (pendingRef.current) {
      clearTimeout(pendingRef.current);
      pendingRef.current = null;
    }

    function connect() {
      if (destroyedRef.current) return;

      // Clear stale book state before reconnecting — fresh WS may send deltas
      // that assume no prior state, and stale levels would corrupt mid-price
      bookRef.current = {};

      const streams = symbols.map((s) => `deltas@${s}`).join("&");
      const url = `${WS_BASE}/${streams}`;

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempt.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.delta) {
            const d = msg.delta;
            const symbol = d.market_symbol as string;
            const rawBids = d.bids as Array<[number, number]> | undefined;
            const rawAsks = d.asks as Array<[number, number]> | undefined;

            // Initialize book for this symbol if needed
            if (!bookRef.current[symbol]) {
              bookRef.current[symbol] = { bids: new Map(), asks: new Map() };
            }
            const book = bookRef.current[symbol];

            // Apply bid deltas: size=0 means remove level
            if (rawBids) {
              for (const [price, size] of rawBids) {
                if (size === 0) {
                  book.bids.delete(price);
                } else {
                  book.bids.set(price, size);
                }
              }
            }

            // Apply ask deltas: size=0 means remove level
            if (rawAsks) {
              for (const [price, size] of rawAsks) {
                if (size === 0) {
                  book.asks.delete(price);
                } else {
                  book.asks.set(price, size);
                }
              }
            }

            // Cap book size to prevent memory leak (keep only 200 closest levels)
            const MAX_LEVELS = 200;
            if (book.bids.size > MAX_LEVELS) {
              const sortedBids = [...book.bids.keys()].sort((a, b) => b - a);
              for (let i = MAX_LEVELS; i < sortedBids.length; i++) book.bids.delete(sortedBids[i]);
            }
            if (book.asks.size > MAX_LEVELS) {
              const sortedAsks = [...book.asks.keys()].sort((a, b) => a - b);
              for (let i = MAX_LEVELS; i < sortedAsks.length; i++) book.asks.delete(sortedAsks[i]);
            }

            // Calculate best bid/ask from full book
            let bestBid = 0;
            for (const p of book.bids.keys()) {
              if (p > bestBid) bestBid = p;
            }
            let bestAsk = Infinity;
            for (const p of book.asks.keys()) {
              if (p < bestAsk) bestAsk = p;
            }

            if (bestBid > 0 && bestAsk < Infinity) {
              const midPrice = (bestBid + bestAsk) / 2;
              const now = Date.now();
              const elapsed = now - lastUpdateRef.current;

              if (elapsed < 1000) {
                if (!pendingRef.current) {
                  pendingRef.current = setTimeout(() => {
                    if (destroyedRef.current) return;
                    pendingRef.current = null;
                    lastUpdateRef.current = Date.now();
                    const snapshot: Record<string, number> = {};
                    for (const [sym, b] of Object.entries(bookRef.current)) {
                      let bb = 0;
                      for (const p of b.bids.keys()) { if (p > bb) bb = p; }
                      let ba = Infinity;
                      for (const p of b.asks.keys()) { if (p < ba) ba = p; }
                      if (bb > 0 && ba < Infinity) {
                        snapshot[sym] = (bb + ba) / 2;
                      }
                    }
                    setPrices((prev) => ({ ...prev, ...snapshot }));
                  }, 1000 - elapsed);
                }
                return;
              }

              lastUpdateRef.current = now;
              setPrices((prev) => {
                const prevPrice = prev[symbol];
                if (!prevPrice || prevPrice <= 0) return { ...prev, [symbol]: midPrice };
                if (Math.abs(midPrice - prevPrice) / prevPrice < 0.0001) {
                  return prev;
                }
                return { ...prev, [symbol]: midPrice };
              });
            }
          }
        } catch {
          // Malformed WS message — ignore silently
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        // Double-check destroyed flag — cleanup may have set it between ws.close() and this callback
        if (destroyedRef.current) return;
        if (reconnectAttempt.current >= MAX_RECONNECT_ATTEMPTS) return;

        const delay =
          RECONNECT_DELAYS[
            Math.min(reconnectAttempt.current, RECONNECT_DELAYS.length - 1)
          ];
        reconnectAttempt.current++;
        reconnectTimer.current = setTimeout(() => {
          // Check again before reconnecting — component may have unmounted during delay
          if (!destroyedRef.current) connect();
        }, delay);
      };

      ws.onerror = () => {
        // onclose fires after onerror
      };
    }

    connect();
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolsKey]);

  return prices;
}
