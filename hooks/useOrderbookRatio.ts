"use client";

import { useEffect, useRef, useState, useCallback } from "react";

const WS_URL = "wss://zo-mainnet.n1.xyz/ws";

interface OrderbookRatio {
  bidPct: number;
  askPct: number;
}

/**
 * Real-time bid-ask ratio via WS delta subscription.
 * 1. Loads full orderbook snapshot via REST
 * 2. Applies incremental deltas from WS (same source as 01 Exchange)
 * 3. Recalculates quote-volume ratio on each delta
 */
export function useOrderbookRatio(marketId: number, symbol: string, enabled: boolean): OrderbookRatio {
  const [ratio, setRatio] = useState<OrderbookRatio>({ bidPct: 50, askPct: 50 });
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const activeRef = useRef(true);
  // Full orderbook state: price → size
  const bidsMap = useRef<Map<number, number>>(new Map());
  const asksMap = useRef<Map<number, number>>(new Map());

  const calcRatio = useCallback(() => {
    let bidVol = 0, askVol = 0;
    for (const [price, size] of bidsMap.current) bidVol += price * size;
    for (const [price, size] of asksMap.current) askVol += price * size;
    const total = bidVol + askVol;
    if (total > 0) {
      setRatio({
        bidPct: (bidVol / total) * 100,
        askPct: (askVol / total) * 100,
      });
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

          calcRatio();
        } catch { /* ignore */ }
      };

      ws.onerror = () => { /* triggers onclose */ };

      ws.onclose = () => {
        if (!activeRef.current) return;
        reconnectTimer.current = setTimeout(() => {
          // Re-init: fresh snapshot + reconnect
          bidsMap.current.clear();
          asksMap.current.clear();
          init();
        }, 3000);
      };
    }

    init();

    return () => {
      activeRef.current = false;
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [marketId, symbol, enabled, calcRatio]);

  return ratio;
}
