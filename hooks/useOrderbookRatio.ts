"use client";

import { useEffect, useRef, useState, useCallback } from "react";

const WS_URL = "wss://zo-mainnet.n1.xyz/ws";
const MAX_LEVELS = 200;

interface OrderbookLevel {
  price: number;
  size: number;
}

interface OrderbookRatio {
  bidPct: number;
  askPct: number;
  topBids: OrderbookLevel[];
  topAsks: OrderbookLevel[];
  spread: number;
}

/** Cap a price-level map to MAX_LEVELS by removing the furthest entries */
function capMap(map: Map<number, number>, side: "bids" | "asks"): void {
  if (map.size <= MAX_LEVELS) return;
  const sorted = [...map.keys()].sort((a, b) => side === "bids" ? b - a : a - b);
  const toRemove = sorted.slice(MAX_LEVELS);
  for (const key of toRemove) map.delete(key);
}

/**
 * Real-time bid-ask ratio via WS delta subscription.
 * 1. Loads full orderbook snapshot via REST
 * 2. Applies incremental deltas from WS (same source as 01 Exchange)
 * 3. Recalculates quote-volume ratio on each delta (throttled to 1s)
 */
const TOP_LEVELS = 10;

export function useOrderbookRatio(marketId: number, symbol: string, enabled: boolean): OrderbookRatio {
  const [ratio, setRatio] = useState<OrderbookRatio>({ bidPct: 50, askPct: 50, topBids: [], topAsks: [], spread: 0 });
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reconnectCount = useRef(0);
  const activeRef = useRef(true);
  // Full orderbook state: price → size
  const bidsMap = useRef<Map<number, number>>(new Map());
  const asksMap = useRef<Map<number, number>>(new Map());
  // Throttle: only call setRatio once per second max
  const lastCalcRef = useRef(0);
  const throttleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const calcRatio = useCallback(() => {
    const now = Date.now();
    const elapsed = now - lastCalcRef.current;

    const doCalc = () => {
      lastCalcRef.current = Date.now();
      let bidVol = 0, askVol = 0;
      for (const [price, size] of bidsMap.current) bidVol += price * size;
      for (const [price, size] of asksMap.current) askVol += price * size;
      const total = bidVol + askVol;

      // Extract top N levels sorted by price
      const sortedBids = [...bidsMap.current.entries()]
        .sort((a, b) => b[0] - a[0])
        .slice(0, TOP_LEVELS)
        .map(([price, size]) => ({ price, size }));
      const sortedAsks = [...asksMap.current.entries()]
        .sort((a, b) => a[0] - b[0])
        .slice(0, TOP_LEVELS)
        .map(([price, size]) => ({ price, size }));

      const bestBid = sortedBids[0]?.price ?? 0;
      const bestAsk = sortedAsks[0]?.price ?? 0;
      const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;

      setRatio({
        bidPct: total > 0 ? (bidVol / total) * 100 : 50,
        askPct: total > 0 ? (askVol / total) * 100 : 50,
        topBids: sortedBids,
        topAsks: sortedAsks,
        spread,
      });
    };

    if (elapsed >= 1000) {
      clearTimeout(throttleTimer.current);
      doCalc();
    } else if (!throttleTimer.current) {
      throttleTimer.current = setTimeout(() => {
        throttleTimer.current = undefined;
        doCalc();
      }, 1000 - elapsed);
    }
  }, []);

  useEffect(() => {
    if (!enabled || !symbol) return;
    activeRef.current = true;
    bidsMap.current.clear();
    asksMap.current.clear();

    async function init() {
      // Step 1: Load full snapshot via REST
      try {
        const res = await fetch(`/api/markets/${marketId}/orderbook`);
        if (!res.ok || !activeRef.current) return;
        const ob = await res.json();
        if (!activeRef.current) return;

        bidsMap.current.clear();
        asksMap.current.clear();
        for (const b of (ob.bids ?? [])) {
          const price = Number(b[0]);
          const size = Number(b[1]);
          if (size > 0) bidsMap.current.set(price, size);
        }
        for (const a of (ob.asks ?? [])) {
          const price = Number(a[0]);
          const size = Number(a[1]);
          if (size > 0) asksMap.current.set(price, size);
        }
        capMap(bidsMap.current, "bids");
        capMap(asksMap.current, "asks");
        calcRatio();
      } catch { /* silent */ }

      // Step 2: Connect WS for incremental deltas
      connect();
    }

    function connect() {
      if (!activeRef.current) return;
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        wsRef.current.close();
      }

      // N1 WS uses symbol without slash, e.g. BTCUSD
      const wsSymbol = symbol.replace("/", "");
      const ws = new WebSocket(`${WS_URL}/deltas@${wsSymbol}`);
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        if (!activeRef.current) return;
        reconnectCount.current = 0; // Reset backoff on successful message
        try {
          const msg = JSON.parse(ev.data);
          const delta = msg.delta;
          if (!delta) return;

          const deltaBids: [number, number][] = delta.bids ?? [];
          const deltaAsks: [number, number][] = delta.asks ?? [];

          // Apply deltas: size=0 means remove level
          for (const [price, size] of deltaBids) {
            if (size === 0) bidsMap.current.delete(price);
            else bidsMap.current.set(price, size);
          }
          for (const [price, size] of deltaAsks) {
            if (size === 0) asksMap.current.delete(price);
            else asksMap.current.set(price, size);
          }
          capMap(bidsMap.current, "bids");
          capMap(asksMap.current, "asks");

          calcRatio();
        } catch { /* ignore */ }
      };

      ws.onerror = () => { /* triggers onclose */ };

      ws.onclose = () => {
        if (!activeRef.current) return;
        // Exponential backoff: 3s, 6s, 12s, max 30s
        const delay = Math.min(3000 * Math.pow(2, reconnectCount.current), 30000);
        reconnectCount.current++;
        reconnectTimer.current = setTimeout(() => {
          bidsMap.current.clear();
          asksMap.current.clear();
          init();
        }, delay);
      };
    }

    init();

    return () => {
      activeRef.current = false;
      clearTimeout(reconnectTimer.current);
      clearTimeout(throttleTimer.current);
      if (wsRef.current) {
        wsRef.current.onmessage = null;
        wsRef.current.onerror = null;
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [marketId, symbol, enabled, calcRatio]);

  return ratio;
}
