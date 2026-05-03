"use client";

/**
 * Live tape of the last N trades on a market. Subscribes to the
 * shared Nord WS through ws-manager (so this opens no new socket;
 * it just adds one trade listener to the multiplex).
 *
 * Each WS payload may contain multiple individual fills with the
 * same `update_id`. We push them all into a FIFO so the UI can
 * render one row per actual fill, not one row per batch.
 *
 * Buffer caps at `max` (default 30) — older trades fall off as
 * new ones arrive. Oldest-first storage; consumers reverse for
 * "newest at top" display.
 */

import { useEffect, useRef, useState } from "react";
import type { WebSocketTradeUpdate } from "@n1xyz/nord-ts";
import { getNordWsManager } from "@/lib/n1/ws-manager";

export type RecentTrade = {
  /** Server-assigned trade batch id; same value for all fills in one batch. */
  updateId: number;
  /** Local wall-clock time the tick was received (ms epoch). The server
   *  doesn't send a per-fill timestamp on the WS payload, so this is the
   *  closest stand-in. Sub-second accuracy is fine for tape reading. */
  receivedAt: number;
  price: number;
  size: number;
  /** "bid" = the taker hit a bid (someone sold to a resting buy) — shown red.
   *  "ask" = the taker lifted an ask (someone bought from a resting sell) — green. */
  side: "bid" | "ask";
};

export type UseRecentTradesOptions = {
  enabled?: boolean;
  /** Max history kept in the buffer. Default 30 — enough to read momentum
   *  without burning memory on a fast market like SOL during volatility. */
  max?: number;
};

export function useRecentTrades(
  symbol: string | null | undefined,
  opts: UseRecentTradesOptions = {},
): RecentTrade[] {
  const enabled = opts.enabled !== false;
  const max = opts.max ?? 30;
  const [trades, setTrades] = useState<RecentTrade[]>([]);
  // Keep the latest seen update_id so we don't accept a duplicate batch
  // that the manager might re-deliver after a reconnect (the WS reconnect
  // path replays the last few events on some 01 deployments).
  const lastUpdateIdRef = useRef(0);

  useEffect(() => {
    if (!enabled || !symbol || typeof symbol !== "string") {
      setTrades([]);
      lastUpdateIdRef.current = 0;
      return;
    }

    const off = getNordWsManager().subscribeTrades(symbol, (data: WebSocketTradeUpdate) => {
      if (!data.trades || data.trades.length === 0) return;
      // Skip a batch we've already absorbed — handles the post-reconnect
      // replay case mentioned above.
      if (data.update_id <= lastUpdateIdRef.current) return;
      lastUpdateIdRef.current = data.update_id;

      const receivedAt = Date.now();
      const newRows: RecentTrade[] = data.trades.map((t) => ({
        updateId: data.update_id,
        receivedAt,
        price: t.price,
        size: t.size,
        side: t.side,
      }));

      setTrades((prev) => {
        // Newest at end, oldest at start — easier reasoning + Array.slice
        // semantics; consumers can reverse() at render time if they want
        // newest-on-top display.
        const next = [...prev, ...newRows];
        // FIFO trim — drop excess from the start.
        if (next.length > max) next.splice(0, next.length - max);
        return next;
      });
    });

    return () => {
      off();
    };
  }, [symbol, enabled, max]);

  return trades;
}
