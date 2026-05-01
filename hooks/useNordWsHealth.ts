"use client";

/**
 * Observe the singleton WebSocket manager's connection state and expose it
 * to React. Pure observer — calling this hook does NOT open a connection
 * (that requires a `subscribeXxx` call somewhere). Use it from any
 * component that wants to render a "WS connected / falling back to REST"
 * affordance, or to gate fallback polling on `state !== 'connected'`.
 *
 * Returns a snapshot that updates on every state transition. `lastEventAt`
 * is intentionally read fresh on every render via a 1-Hz ticker so callers
 * can show "X seconds ago" without subscribing per-event.
 */

import { useEffect, useState } from "react";
import {
  getNordWsManager,
  type WsHealthSnapshot,
  type WsState,
} from "@/lib/n1/ws-manager";

export type UseNordWsHealth = {
  state: WsState;
  /** Milliseconds since the last event; null if no event has arrived yet. */
  lastEventAgo: number | null;
  /** Cumulative auto-reconnect attempts since last successful connect. */
  reconnectAttempts: number;
  /** True iff state === "connected" — convenience for gating fallbacks. */
  connected: boolean;
};

export function useNordWsHealth(): UseNordWsHealth {
  const [snap, setSnap] = useState<WsHealthSnapshot>(() =>
    getNordWsManager().getSnapshot(),
  );
  // Render-tick used to keep `lastEventAgo` fresh without re-subscribing
  // per WS event. 1 Hz is enough for human-readable "X s ago" labels.
  const [, setTick] = useState(0);

  useEffect(() => {
    const off = getNordWsManager().onState((s) => setSnap(s));
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      off();
      clearInterval(id);
    };
  }, []);

  const lastEventAgo =
    snap.lastEventAt === null ? null : Date.now() - snap.lastEventAt;

  return {
    state: snap.state,
    lastEventAgo,
    reconnectAttempts: snap.reconnectAttempts,
    connected: snap.state === "connected",
  };
}
