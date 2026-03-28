"use client";

import { useEffect, useRef, useState, useCallback } from "react";

const WS_BASE = "wss://zo-mainnet.n1.xyz/ws";
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000];
const MAX_RECONNECT_ATTEMPTS = 20;

/** Real-time candle update from N1 WebSocket. */
export interface CandleUpdate {
  t: number;  // timestamp (unix seconds)
  o: number;  // open
  h: number;  // high
  l: number;  // low
  c: number;  // close
  v: number;  // volume
}

/**
 * Real-time candle updates via N1 WebSocket `candle@SYMBOL:RESOLUTION`.
 *
 * Subscribes to a single candle stream for the given symbol + resolution.
 * Returns the latest candle update or null if not yet received.
 * Throttled to max ~2 updates/sec to prevent React re-render storms.
 *
 * @param symbol   - Market symbol, e.g. "BTCUSD"
 * @param resolution - N1 resolution string, e.g. "60" for 1H
 * @param enabled  - Pass false to disconnect (e.g. when panel is closed)
 */
export function useCandleStream(
  symbol: string,
  resolution: string,
  enabled: boolean
): CandleUpdate | null {
  const [candle, setCandle] = useState<CandleUpdate | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const destroyedRef = useRef(false);
  // Throttle: max 2 updates/sec
  const lastUpdateRef = useRef(0);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef<CandleUpdate | null>(null);

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

  // Stable key for effect dependency
  const streamKey = `${symbol}:${resolution}:${enabled}`;

  useEffect(() => {
    if (!enabled || !symbol || !resolution) {
      setCandle(null);
      return;
    }

    // Clear stale candle from previous symbol immediately
    setCandle(null);
    destroyedRef.current = false;
    reconnectAttempt.current = 0;
    lastUpdateRef.current = 0;
    latestRef.current = null;
    if (pendingRef.current) {
      clearTimeout(pendingRef.current);
      pendingRef.current = null;
    }

    function connect() {
      if (destroyedRef.current) return;

      const url = `${WS_BASE}/candle@${symbol}:${resolution}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempt.current = 0;
      };

      ws.onmessage = (event) => {
        if (destroyedRef.current) return;
        try {
          const msg = JSON.parse(event.data);

          // N1 candle WS format: { res, mid, t, o, h, l, c, v }
          // Also accept nested: { candle: { ... } }
          const data = msg.candle ?? msg;
          if (typeof data.t !== "number" || typeof data.c !== "number") return;

          const update: CandleUpdate = {
            t: data.t,
            o: data.o,
            h: data.h,
            l: data.l,
            c: data.c,
            v: data.v,
          };

          latestRef.current = update;

          // Throttle state updates to ~2/sec
          const now = Date.now();
          const elapsed = now - lastUpdateRef.current;

          if (elapsed < 500) {
            if (!pendingRef.current) {
              pendingRef.current = setTimeout(() => {
                if (destroyedRef.current) return;
                pendingRef.current = null;
                lastUpdateRef.current = Date.now();
                if (latestRef.current) setCandle({ ...latestRef.current });
              }, 500 - elapsed);
            }
            return;
          }

          lastUpdateRef.current = now;
          setCandle(update);
        } catch {
          // Malformed message — ignore
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (destroyedRef.current) return;
        if (reconnectAttempt.current >= MAX_RECONNECT_ATTEMPTS) return;

        const delay =
          RECONNECT_DELAYS[
            Math.min(reconnectAttempt.current, RECONNECT_DELAYS.length - 1)
          ];
        reconnectAttempt.current++;
        reconnectTimer.current = setTimeout(() => {
          if (!destroyedRef.current) connect();
        }, delay);
      };

      ws.onerror = () => {
        // onclose fires after onerror — reconnection handled there
      };
    }

    connect();
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamKey]);

  return candle;
}
