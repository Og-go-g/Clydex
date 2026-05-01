"use client";

/**
 * Live last-candle updates routed through the WS manager.
 *
 * Scope: this hook ONLY handles the streaming portion. Historical candles
 * (everything before "now") must be loaded once at mount via REST by the
 * caller and passed in as `initialCandles`. The hook merges live updates
 * into a copy of that array and returns the merged version.
 *
 * Merge rule:
 *   - If incoming candle's `t` matches the last candle in state → replace
 *     it (in-progress candle for the current bucket).
 *   - If incoming `t > lastCandle.t` → push as a new candle.
 *   - If incoming `t < lastCandle.t` → ignore (out-of-order / stale).
 *
 * Note: `WebSocketCandleUpdate.mid` is the numeric market_id, not the
 * symbol. The manager dispatches candle events to listeners using the
 * `symbol → marketId` map; the first `setSymbolMarketId()` call (typically
 * after the market cache is loaded) eliminates the brief window where
 * candle events would fan out to all candle listeners regardless of
 * market.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { WebSocketCandleUpdate, CandleResolution } from "@n1xyz/nord-ts";
import { getNordWsManager } from "@/lib/n1/ws-manager";

export type Candle = {
  /** Bucket start, unix seconds. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export type UseNordCandlesOptions = {
  enabled?: boolean;
  /** Optional cap on total stored candles. Older candles are dropped. */
  maxLength?: number;
};

export type UseNordCandlesResult = {
  candles: Candle[];
  /** Local timestamp (ms) of the most recent merge — for "live" indicator. */
  lastUpdateAt: number | null;
};

const DEFAULT_MAX = 1000;

function mergeCandle(existing: Candle[], next: Candle, max: number): Candle[] {
  if (existing.length === 0) return [next];
  const last = existing[existing.length - 1];
  if (next.t === last.t) {
    // Update in-progress candle.
    const copy = existing.slice();
    copy[copy.length - 1] = next;
    return copy;
  }
  if (next.t < last.t) {
    // Out-of-order — drop.
    return existing;
  }
  const appended = [...existing, next];
  return appended.length > max ? appended.slice(appended.length - max) : appended;
}

export function useNordCandles(
  symbol: string | null | undefined,
  resolution: CandleResolution,
  initialCandles: Candle[],
  opts: UseNordCandlesOptions = {},
): UseNordCandlesResult {
  const enabled = opts.enabled !== false;
  const maxLength = opts.maxLength ?? DEFAULT_MAX;

  const [candles, setCandles] = useState<Candle[]>(initialCandles);
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);

  // Re-seed when caller swaps in a new history (symbol change, resolution
  // change, manual refresh). Use length+first/last as a cheap fingerprint;
  // a full deep-equal would be wasted on Phase-1 cardinality.
  const seedKey =
    initialCandles.length +
    ":" +
    (initialCandles[0]?.t ?? 0) +
    ":" +
    (initialCandles[initialCandles.length - 1]?.t ?? 0);
  const lastSeedKey = useRef(seedKey);
  if (lastSeedKey.current !== seedKey) {
    lastSeedKey.current = seedKey;
    // Schedule a state update — synchronous setState in render is allowed
    // by React when guarded by a ref check exactly like this.
    setCandles(initialCandles);
  }

  const handler = useCallback(
    (data: WebSocketCandleUpdate) => {
      // Resolution filter — manager already filters by resolution, but
      // double-check in case a future SDK change broadens dispatch.
      if (data.res !== resolution) return;
      const candle: Candle = {
        t: data.t,
        o: data.o,
        h: data.h,
        l: data.l,
        c: data.c,
        v: data.v,
      };
      setCandles((prev) => mergeCandle(prev, candle, maxLength));
      setLastUpdateAt(Date.now());
    },
    [resolution, maxLength],
  );
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    if (!symbol || typeof symbol !== "string") return;
    const off = getNordWsManager().subscribeCandles(symbol, resolution, (data) =>
      handlerRef.current(data),
    );
    return off;
  }, [enabled, symbol, resolution]);

  return { candles, lastUpdateAt };
}
