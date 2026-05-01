"use client";

/**
 * Live orderbook for one market built from a REST seed plus the WebSocket
 * delta stream.
 *
 * Algorithm:
 *
 *   1. On mount, fetch `/api/markets/<marketId>/orderbook` for a full
 *      snapshot. Initialise two maps (price → size) for bids and asks.
 *   2. Subscribe to `deltas@<symbol>` via the WS manager. Each delta event
 *      contains incremental updates: `size === 0` removes a level, any
 *      other size sets/replaces it.
 *   3. Cap each side to `depth * 4` levels in storage (extra buffer in
 *      case the visible top levels evict and we'd otherwise show holes).
 *   4. Throttle `setState` to ~4 Hz — the underlying maps stay accurate,
 *      we just don't re-render React more than that.
 *
 * Known imperfections (acceptable for Phase 1, may be tightened later):
 *
 *   - Race between REST snapshot and first deltas: deltas arriving in the
 *     window between fetch start and subscribe are dropped. Real exchanges
 *     paper over this with `last_update_id` sequencing on the snapshot;
 *     `/api/markets/[id]/orderbook` does not currently expose that, so
 *     we accept the stale window. For most retail flows it is sub-second.
 *   - Wire format ambiguity: the SDK type declares
 *     `asks: { price; size }[]`, but legacy `useOrderbookRatio` pulls them
 *     as `[number, number][]`. We accept both shapes at runtime.
 *   - No gap detection (`delta.last_update_id !== prev.update_id` re-snap).
 *     If 01.xyz starts dropping deltas under load this hook will silently
 *     drift; add a resnapshot step in Phase 4 if observed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { WebSocketDeltaUpdate } from "@n1xyz/nord-ts";
import { getNordWsManager } from "@/lib/n1/ws-manager";

export type Level = { price: number; size: number };

export type UseNordOrderbookResult = {
  bids: Level[];
  asks: Level[];
  spread: number;
  updateId: number | null;
  lastUpdateId: number | null;
  /** True after the REST seed has applied — UI can show "loading…" while false. */
  ready: boolean;
};

export type UseNordOrderbookOptions = {
  enabled?: boolean;
  /** How many top levels per side to return. Storage holds up to 4× this. */
  depth?: number;
  /** UI re-render throttle in ms. Underlying maps stay accurate regardless. */
  throttleMs?: number;
};

const DEFAULT_DEPTH = 10;
const DEFAULT_THROTTLE_MS = 250;

// Tolerant entry parser — accepts both the wire-tuple shape and the
// object shape declared in the SDK types.
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

function topLevels(
  map: Map<number, number>,
  side: "bids" | "asks",
  count: number,
): Level[] {
  // Bids: best price = highest. Asks: best price = lowest.
  const cmp =
    side === "bids" ? (a: number, b: number) => b - a : (a: number, b: number) => a - b;
  return [...map.keys()]
    .sort(cmp)
    .slice(0, count)
    .map((price) => ({ price, size: map.get(price)! }));
}

function capMap(map: Map<number, number>, side: "bids" | "asks", limit: number): void {
  if (map.size <= limit) return;
  const cmp =
    side === "bids" ? (a: number, b: number) => b - a : (a: number, b: number) => a - b;
  const sorted = [...map.keys()].sort(cmp);
  for (const price of sorted.slice(limit)) map.delete(price);
}

export function useNordOrderbook(
  symbol: string | null | undefined,
  marketId: number | null | undefined,
  opts: UseNordOrderbookOptions = {},
): UseNordOrderbookResult {
  const enabled = opts.enabled !== false;
  const depth = opts.depth ?? DEFAULT_DEPTH;
  const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
  const storageLimit = depth * 4;

  const bidsMap = useRef<Map<number, number>>(new Map());
  const asksMap = useRef<Map<number, number>>(new Map());
  const [snapshot, setSnapshot] = useState<{
    bids: Level[];
    asks: Level[];
    spread: number;
    updateId: number | null;
    lastUpdateId: number | null;
    ready: boolean;
  }>({ bids: [], asks: [], spread: 0, updateId: null, lastUpdateId: null, ready: false });

  // updateId/lastUpdateId tracked in refs to avoid touching state on every event.
  const updateIdRef = useRef<number | null>(null);
  const lastUpdateIdRef = useRef<number | null>(null);
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushAt = useRef(0);

  const flush = useCallback(() => {
    const bids = topLevels(bidsMap.current, "bids", depth);
    const asks = topLevels(asksMap.current, "asks", depth);
    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 0;
    const spread = bestBid > 0 && bestAsk > 0 ? bestAsk - bestBid : 0;
    setSnapshot({
      bids,
      asks,
      spread,
      updateId: updateIdRef.current,
      lastUpdateId: lastUpdateIdRef.current,
      ready: true,
    });
    lastFlushAt.current = Date.now();
  }, [depth]);

  const scheduleFlush = useCallback(() => {
    const now = Date.now();
    const since = now - lastFlushAt.current;
    if (since >= throttleMs) {
      if (throttleTimer.current) {
        clearTimeout(throttleTimer.current);
        throttleTimer.current = null;
      }
      flush();
      return;
    }
    if (throttleTimer.current) return;
    throttleTimer.current = setTimeout(() => {
      throttleTimer.current = null;
      flush();
    }, throttleMs - since);
  }, [flush, throttleMs]);

  // ─── Effect: subscribe + REST seed ────────────────────────────
  useEffect(() => {
    if (!enabled) return;
    if (!symbol || typeof symbol !== "string") return;
    if (typeof marketId !== "number" || !Number.isFinite(marketId) || marketId < 0) return;

    let cancelled = false;
    bidsMap.current.clear();
    asksMap.current.clear();
    updateIdRef.current = null;
    lastUpdateIdRef.current = null;
    setSnapshot((s) => ({ ...s, ready: false }));

    // 1. REST seed.
    fetch(`/api/markets/${marketId}/orderbook`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { bids?: unknown[]; asks?: unknown[] } | null) => {
        if (cancelled || !body) return;
        for (const raw of body.bids ?? []) {
          const e = readEntry(raw);
          if (e && e.size > 0) bidsMap.current.set(e.price, e.size);
        }
        for (const raw of body.asks ?? []) {
          const e = readEntry(raw);
          if (e && e.size > 0) asksMap.current.set(e.price, e.size);
        }
        capMap(bidsMap.current, "bids", storageLimit);
        capMap(asksMap.current, "asks", storageLimit);
        flush();
      })
      .catch(() => {
        // REST failed — leave maps empty, deltas will eventually fill in.
        if (!cancelled) flush();
      });

    // 2. WS subscribe.
    const off = getNordWsManager().subscribeDeltas(symbol, (data: WebSocketDeltaUpdate) => {
      // Drop stale events for a different (still buffered?) symbol.
      if (data.market_symbol !== symbol) return;

      lastUpdateIdRef.current = data.last_update_id;
      updateIdRef.current = data.update_id;

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
      capMap(bidsMap.current, "bids", storageLimit);
      capMap(asksMap.current, "asks", storageLimit);
      scheduleFlush();
    });

    return () => {
      cancelled = true;
      off();
      if (throttleTimer.current) {
        clearTimeout(throttleTimer.current);
        throttleTimer.current = null;
      }
    };
  }, [enabled, symbol, marketId, storageLimit, flush, scheduleFlush]);

  return snapshot;
}
