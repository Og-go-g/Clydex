"use client";

/**
 * Live trade ticker for one market symbol. Emits the most recent trade's
 * price/size/side from the WebSocket trade stream.
 *
 * Scope is intentionally narrow: this hook only knows about *trades*. Slow-
 * moving stats (24h change, OI, funding rate) are NOT in the trade payload
 * and should be fetched separately via REST — typically a 60-second poll
 * is fine since those fields update on the order of minutes, not seconds.
 *
 * Per the migration plan, callers compose the two:
 *
 *   const { lastPrice } = useNordMarketTicker("BTCUSD");
 *   const { data: stats } = useSWR(`/api/markets/${id}`, { refreshInterval: 60_000 });
 *
 * That way Upstash budget burn stays in the trade-stream-free 1 req/min,
 * and the displayed price still ticks within ~100 ms of an actual fill.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { WebSocketTradeUpdate } from "@n1xyz/nord-ts";
import { getNordWsManager } from "@/lib/n1/ws-manager";

export type TradeTick = {
  price: number;
  size: number;
  side: "bid" | "ask";
  /** Server-assigned monotonic update_id for the trade batch. Useful for
   *  detecting gaps if a downstream consumer accumulates ticks. */
  updateId: number;
  /** Local wall-clock time the tick was received (ms epoch). */
  receivedAt: number;
};

export type UseNordMarketTickerResult = {
  lastTick: TradeTick | null;
  /** Convenience accessor — same as `lastTick?.price ?? null`. */
  lastPrice: number | null;
  /** Total trade-event batches received during this hook's lifetime. */
  eventCount: number;
};

export type UseNordMarketTickerOptions = {
  enabled?: boolean;
};

export function useNordMarketTicker(
  symbol: string | null | undefined,
  opts: UseNordMarketTickerOptions = {},
): UseNordMarketTickerResult {
  const enabled = opts.enabled !== false;
  const [lastTick, setLastTick] = useState<TradeTick | null>(null);
  const [eventCount, setEventCount] = useState(0);

  // Drop event refs into refs so the WS subscription effect re-runs only
  // when the subscription target itself changes — not on every render.
  const handler = useCallback((data: WebSocketTradeUpdate) => {
    if (!data.trades || data.trades.length === 0) return;
    // The batch may contain multiple individual trades for the same
    // update_id. Take the last one as "current price"; price discovery
    // typically prints in chronological order within the array.
    const last = data.trades[data.trades.length - 1];
    setLastTick({
      price: last.price,
      size: last.size,
      side: last.side,
      updateId: data.update_id,
      receivedAt: Date.now(),
    });
    setEventCount((n) => n + 1);
  }, []);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    if (!symbol || typeof symbol !== "string") return;
    const off = getNordWsManager().subscribeTrades(symbol, (data) =>
      handlerRef.current(data),
    );
    return off;
  }, [symbol, enabled]);

  return {
    lastTick,
    lastPrice: lastTick?.price ?? null,
    eventCount,
  };
}
