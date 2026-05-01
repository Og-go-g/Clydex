"use client";

/**
 * Real-time bid-ask ratio for a market — live volume distribution between
 * the two sides of the book + the top-N levels for a compact ladder.
 *
 * Phase 6 rewrite: this hook used to open its own dedicated WebSocket to
 * `wss://.../deltas@<sym>` for every consuming component. With the singleton
 * `ws-manager` in place we now route the delta stream through it, so multiple
 * consumers (or the same component remounting) all share one socket with
 * the rest of the app's subscriptions.
 *
 * Algorithm (unchanged from before):
 *   1. REST snapshot of `/api/markets/<id>/orderbook` to seed full book.
 *   2. Apply incremental deltas as they arrive (`size === 0` removes a level).
 *   3. Recompute the bid/ask quote-volume ratio + top levels, throttled to
 *      1 Hz so React renders stay reasonable on busy markets.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { getNordWsManager } from "@/lib/n1/ws-manager";

const MAX_LEVELS = 200;
const TOP_LEVELS = 10;

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

/** Cap a price-level map to MAX_LEVELS by removing the furthest entries. */
function capMap(map: Map<number, number>, side: "bids" | "asks"): void {
  if (map.size <= MAX_LEVELS) return;
  const sorted = [...map.keys()].sort((a, b) =>
    side === "bids" ? b - a : a - b,
  );
  for (const key of sorted.slice(MAX_LEVELS)) map.delete(key);
}

// Tolerant entry parser — accepts both wire-tuple [price, size] and the
// SDK-typed object {price, size} encodings. Same trick as useNordOrderbook.
function readEntry(raw: unknown): { price: number; size: number } | null {
  if (Array.isArray(raw)) {
    const price = Number(raw[0]);
    const size = Number(raw[1]);
    if (!Number.isFinite(price) || !Number.isFinite(size)) return null;
    return { price, size };
  }
  if (raw && typeof raw === "object") {
    const o = raw as { price?: unknown; size?: unknown };
    const price = Number(o.price);
    const size = Number(o.size);
    if (!Number.isFinite(price) || !Number.isFinite(size)) return null;
    return { price, size };
  }
  return null;
}

export function useOrderbookRatio(
  marketId: number,
  symbol: string,
  enabled: boolean,
): OrderbookRatio {
  const [ratio, setRatio] = useState<OrderbookRatio>({
    bidPct: 50,
    askPct: 50,
    topBids: [],
    topAsks: [],
    spread: 0,
  });

  const bidsMap = useRef<Map<number, number>>(new Map());
  const asksMap = useRef<Map<number, number>>(new Map());
  const lastCalcRef = useRef(0);
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeRef = useRef(true);

  const calcRatio = useCallback(() => {
    const now = Date.now();
    const elapsed = now - lastCalcRef.current;

    const doCalc = () => {
      lastCalcRef.current = Date.now();
      let bidVol = 0;
      let askVol = 0;
      for (const [price, size] of bidsMap.current) bidVol += price * size;
      for (const [price, size] of asksMap.current) askVol += price * size;
      const total = bidVol + askVol;

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
      if (throttleTimer.current) {
        clearTimeout(throttleTimer.current);
        throttleTimer.current = undefined;
      }
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

    let cancelled = false;

    // Step 1: REST snapshot.
    fetch(`/api/markets/${marketId}/orderbook`)
      .then((r) => (r.ok ? r.json() : null))
      .then((ob: { bids?: unknown[]; asks?: unknown[] } | null) => {
        if (cancelled || !ob) return;
        for (const raw of ob.bids ?? []) {
          const e = readEntry(raw);
          if (e && e.size > 0) bidsMap.current.set(e.price, e.size);
        }
        for (const raw of ob.asks ?? []) {
          const e = readEntry(raw);
          if (e && e.size > 0) asksMap.current.set(e.price, e.size);
        }
        capMap(bidsMap.current, "bids");
        capMap(asksMap.current, "asks");
        calcRatio();
      })
      .catch(() => {
        // REST failed — leave maps empty, deltas will eventually fill in.
        if (!cancelled) calcRatio();
      });

    // Step 2: subscribe through the manager. The N1 WS uses the symbol
    // without slash (e.g. "BTCUSD"); subscribeDeltas does the same URL
    // path under the hood.
    const wsSymbol = symbol.replace("/", "");
    const off = getNordWsManager().subscribeDeltas(wsSymbol, (data) => {
      if (cancelled || data.market_symbol !== wsSymbol) return;
      for (const raw of (data.bids as unknown[]) ?? []) {
        const e = readEntry(raw);
        if (!e) continue;
        if (e.size === 0) bidsMap.current.delete(e.price);
        else bidsMap.current.set(e.price, e.size);
      }
      for (const raw of (data.asks as unknown[]) ?? []) {
        const e = readEntry(raw);
        if (!e) continue;
        if (e.size === 0) asksMap.current.delete(e.price);
        else asksMap.current.set(e.price, e.size);
      }
      capMap(bidsMap.current, "bids");
      capMap(asksMap.current, "asks");
      calcRatio();
    });

    return () => {
      cancelled = true;
      activeRef.current = false;
      off();
      if (throttleTimer.current) {
        clearTimeout(throttleTimer.current);
        throttleTimer.current = undefined;
      }
    };
  }, [marketId, symbol, enabled, calcRatio]);

  return ratio;
}
