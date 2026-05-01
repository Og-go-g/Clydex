/**
 * Nord WebSocket singleton manager.
 *
 * Why a manager and not direct SDK use:
 *
 * The SDK's `NordWebSocketClient` is **immutable**: subscriptions are
 * encoded into the URL at construction (`wss://.../ws/trades@BTC&account@123`)
 * and cannot be added/removed at runtime. If five components in the same
 * page each `new`'d a client they would open five sockets — one of the
 * known footguns this manager solves.
 *
 * The contract is the standard "singleton with refcounted subscriptions
 * and debounced rebuild" pattern used by, e.g., the React Query devtools
 * websocket integration:
 *
 *   - One manager instance per tab (module-level `instance`).
 *   - Each `subscribeXxx()` adds a typed listener; the returned function
 *     removes it. A 150 ms debounce coalesces mount/unmount cascades into
 *     one rebuild — opening React Query refetch + chart panel + portfolio
 *     in the same tick should still produce a single connection.
 *   - When the subscription set actually changes, `rebuild()` closes the
 *     current client and opens a new one with the union of all live
 *     listener targets. If the set becomes empty, the manager goes idle.
 *
 * Failure modes considered:
 *
 *   1. Listener throws → caught and logged; other listeners still receive
 *      the event. One bad component does not break the whole stream.
 *   2. Two rebuilds racing → guarded by `currentSubKey`. The losing one
 *      sees the key has moved and tears its half-built client back down.
 *   3. SDK reconnect loop → SDK retries 5× with exponential backoff. Each
 *      `disconnected` bumps `reconnectAttempts`; on a successful reconnect
 *      it resets to 0. Manager state goes connecting → connected, and
 *      `useNordWsHealth` exposes `state` + `lastEventAgo` so callers can
 *      decide when to fall back to REST.
 *   4. Empty payload symbol mismatch → trade/delta/candle dispatch is
 *      filtered against the listener's symbol/marketId, so subscribing to
 *      "trades@BTCUSD" does NOT fire on "trades@ETHUSD" if both are
 *      multiplexed on one socket.
 *   5. Multiple account subscriptions → filtered by `account_id` in the
 *      payload (it IS present, despite some older docs claiming otherwise).
 *      In practice we only ever subscribe to the signed-in user's account,
 *      but the filter keeps things sound if that ever changes.
 *
 * Not handled here (intentional): visibility-change refetch, REST seed
 * for initial state — those live in the per-stream hooks.
 */

import { getNord } from "./client";
import type {
  NordWebSocketClient,
  WebSocketAccountUpdate,
  WebSocketTradeUpdate,
  WebSocketDeltaUpdate,
  WebSocketCandleUpdate,
  CandleResolution,
} from "@n1xyz/nord-ts";

// ─── Public types ────────────────────────────────────────────────

export type WsState =
  | "idle" // no listeners → no connection
  | "connecting" // building/opening socket
  | "connected" // socket open, events flowing
  | "disconnected" // socket closed, reconnect may be pending (driven by SDK)
  | "error"; // last rebuild() threw — caller should retry or fall back

export type WsHealthSnapshot = {
  state: WsState;
  lastEventAt: number | null;
  reconnectAttempts: number;
};

// ─── Internal listener storage ───────────────────────────────────

type TradeListener = {
  type: "trade";
  symbol: string;
  fn: (data: WebSocketTradeUpdate) => void;
};
type DeltaListener = {
  type: "delta";
  symbol: string;
  fn: (data: WebSocketDeltaUpdate) => void;
};
type AccountListener = {
  type: "account";
  accountId: number;
  fn: (data: WebSocketAccountUpdate) => void;
};
type CandleListener = {
  type: "candle";
  symbol: string;
  resolution: CandleResolution;
  fn: (data: WebSocketCandleUpdate) => void;
};
type Listener = TradeListener | DeltaListener | AccountListener | CandleListener;

// Tunables. Exported for tests; do not edit at runtime.
export const REBUILD_DEBOUNCE_MS = 150;

// SDK 0.4.3 split the candle resolution into two encodings: the URL/
// subscription parameter still takes "1" / "5" / ... / "1M", but the
// `res` field on the streamed CandleUpdate now arrives as the enum-cased
// "OneMinute" / "FiveMinutes" / .... This map lets the dispatcher
// compare a listener's subscription-form resolution with the payload's
// enum-form `res`. Keep it in sync if the SDK adds new buckets.
const RESOLUTION_PAYLOAD_FORM: Record<CandleResolution, string> = {
  "1": "OneMinute",
  "5": "FiveMinutes",
  "15": "FifteenMinutes",
  "30": "ThirtyMinutes",
  "60": "SixtyMinutes",
  "4H": "FourHours",
  "1D": "OneDay",
  "1W": "OneWeek",
  "1M": "OneMonth",
};

// ─── Manager class ───────────────────────────────────────────────

class NordWsManager {
  private listeners = new Set<Listener>();
  private client: NordWebSocketClient | null = null;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private state: WsState = "idle";
  private stateListeners = new Set<(snap: WsHealthSnapshot) => void>();
  private lastEventAt: number | null = null;
  private reconnectAttempts = 0;
  // Stable serialization of the current subscription set, used to detect
  // genuine changes (and to detect that a started rebuild has been
  // superseded by a newer one — race protection).
  private currentSubKey = "";
  // Symbol → marketId cache for candle dispatch. Lazy-populated from the
  // first events; we don't synchronously fetch /info just to wire dispatch.
  private symbolToMarketId = new Map<string, number>();

  // ─── Public: state observation ─────────────────────────────────

  getSnapshot(): WsHealthSnapshot {
    return {
      state: this.state,
      lastEventAt: this.lastEventAt,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /** Subscribe to state-machine transitions. Fires once with the current
   *  snapshot on subscribe so callers don't need to read getSnapshot()
   *  separately. Returns an unsubscribe function. */
  onState(fn: (snap: WsHealthSnapshot) => void): () => void {
    this.stateListeners.add(fn);
    // Microtask to avoid running listener before the caller has finished
    // its setup (matches React's useEffect ordering expectations).
    queueMicrotask(() => {
      if (this.stateListeners.has(fn)) fn(this.getSnapshot());
    });
    return () => {
      this.stateListeners.delete(fn);
    };
  }

  /** Force a rebuild with the current subscription set. Useful after a
   *  long disconnect (e.g. iOS Safari kills WS in background tabs) when
   *  the caller knows the SDK's auto-reconnect has given up. */
  reconnectNow(): void {
    this.scheduleRebuild(/* immediate */ true);
  }

  // ─── Public: subscriptions ─────────────────────────────────────

  subscribeTrades(
    symbol: string,
    fn: (data: WebSocketTradeUpdate) => void,
  ): () => void {
    return this.add({ type: "trade", symbol, fn });
  }

  subscribeDeltas(
    symbol: string,
    fn: (data: WebSocketDeltaUpdate) => void,
  ): () => void {
    return this.add({ type: "delta", symbol, fn });
  }

  subscribeAccount(
    accountId: number,
    fn: (data: WebSocketAccountUpdate) => void,
  ): () => void {
    if (!Number.isFinite(accountId) || accountId <= 0) {
      throw new Error(`subscribeAccount: invalid accountId ${accountId}`);
    }
    return this.add({ type: "account", accountId, fn });
  }

  subscribeCandles(
    symbol: string,
    resolution: CandleResolution,
    fn: (data: WebSocketCandleUpdate) => void,
  ): () => void {
    return this.add({ type: "candle", symbol, resolution, fn });
  }

  /** Optional: pre-populate symbol→marketId mapping so candle dispatch
   *  filters correctly from the very first event. Hooks call this once
   *  on mount with whatever they already have from the market cache. */
  setSymbolMarketId(symbol: string, marketId: number): void {
    if (Number.isFinite(marketId)) {
      this.symbolToMarketId.set(symbol, marketId);
    }
  }

  // ─── Internal: subscription registry ───────────────────────────

  private add(listener: Listener): () => void {
    this.listeners.add(listener);
    this.scheduleRebuild();
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.listeners.delete(listener);
      this.scheduleRebuild();
    };
  }

  private scheduleRebuild(immediate = false): void {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    const run = () => {
      this.rebuildTimer = null;
      void this.rebuild();
    };
    if (immediate) run();
    else this.rebuildTimer = setTimeout(run, REBUILD_DEBOUNCE_MS);
  }

  // ─── Internal: rebuild ─────────────────────────────────────────

  /** Compute a stable key for the current subscription set so we can
   *  short-circuit no-op rebuilds and detect superseded rebuilds. */
  private computeSubKey(): string {
    const trades = new Set<string>();
    const deltas = new Set<string>();
    const accounts = new Set<number>();
    const candles = new Set<string>();
    for (const l of this.listeners) {
      switch (l.type) {
        case "trade":
          trades.add(l.symbol);
          break;
        case "delta":
          deltas.add(l.symbol);
          break;
        case "account":
          accounts.add(l.accountId);
          break;
        case "candle":
          candles.add(`${l.symbol}:${l.resolution}`);
          break;
      }
    }
    return [
      [...trades].sort().join(","),
      [...deltas].sort().join(","),
      [...accounts].sort((a, b) => a - b).join(","),
      [...candles].sort().join(","),
    ].join("|");
  }

  private async rebuild(): Promise<void> {
    const newKey = this.computeSubKey();

    // No-op: same set, client still alive
    if (newKey === this.currentSubKey && this.client !== null) return;

    // Tear down whatever we had
    if (this.client) {
      // Removing listeners BEFORE close() suppresses the spurious
      // `disconnected` event the SDK would otherwise emit while we're
      // already moving on.
      try {
        this.client.removeAllListeners();
      } catch {
        // SDK shouldn't throw here, but defensive.
      }
      try {
        this.client.close();
      } catch (err) {
        console.warn("[ws-manager] error closing previous client:", err);
      }
      this.client = null;
    }

    this.currentSubKey = newKey;

    // No subscribers → stay idle, don't open a socket.
    if (this.listeners.size === 0) {
      this.setState("idle");
      this.reconnectAttempts = 0;
      return;
    }

    // Build the SDK config from the listener registry.
    const trades: string[] = [];
    const deltas: string[] = [];
    const accounts: number[] = [];
    const candles: { symbol: string; resolution: CandleResolution }[] = [];
    {
      const seenT = new Set<string>();
      const seenD = new Set<string>();
      const seenA = new Set<number>();
      const seenC = new Set<string>();
      for (const l of this.listeners) {
        switch (l.type) {
          case "trade":
            if (!seenT.has(l.symbol)) {
              seenT.add(l.symbol);
              trades.push(l.symbol);
            }
            break;
          case "delta":
            if (!seenD.has(l.symbol)) {
              seenD.add(l.symbol);
              deltas.push(l.symbol);
            }
            break;
          case "account":
            if (!seenA.has(l.accountId)) {
              seenA.add(l.accountId);
              accounts.push(l.accountId);
            }
            break;
          case "candle": {
            const key = `${l.symbol}:${l.resolution}`;
            if (!seenC.has(key)) {
              seenC.add(key);
              candles.push({ symbol: l.symbol, resolution: l.resolution });
            }
            break;
          }
        }
      }
    }

    this.setState("connecting");

    try {
      const nord = await getNord();
      // If a newer rebuild has been scheduled while we awaited getNord(),
      // bail out — that one will run with the up-to-date set.
      if (this.currentSubKey !== newKey) return;

      const client = nord.createWebSocketClient({
        trades: trades.length ? trades : undefined,
        deltas: deltas.length ? deltas : undefined,
        accounts: accounts.length ? accounts : undefined,
        candles: candles.length ? candles : undefined,
      });

      // Same race check: if we lost, dispose and abort.
      if (this.currentSubKey !== newKey) {
        try {
          client.removeAllListeners();
          client.close();
        } catch {
          /* ignore */
        }
        return;
      }

      this.attachClientListeners(client);
      this.client = client;
    } catch (err) {
      console.error("[ws-manager] rebuild failed:", err);
      this.setState("error");
    }
  }

  private attachClientListeners(client: NordWebSocketClient): void {
    client.on("connected", () => {
      this.reconnectAttempts = 0;
      this.setState("connected");
    });
    client.on("disconnected", () => {
      // SDK auto-reconnects up to 5×; each failed attempt re-emits
      // disconnected. We reflect that as the manager's state, and the
      // health hook decides how long to wait before falling back to REST.
      this.reconnectAttempts += 1;
      this.setState("disconnected");
    });
    client.on("error", (err: Error) => {
      console.error("[ws-manager] socket error:", err.message);
    });

    client.on("trades", (data: WebSocketTradeUpdate) => {
      this.lastEventAt = Date.now();
      const symbol = data.market_symbol;
      for (const l of this.listeners) {
        if (l.type === "trade" && l.symbol === symbol) {
          this.safeFire(l.fn, data);
        }
      }
    });

    client.on("delta", (data: WebSocketDeltaUpdate) => {
      this.lastEventAt = Date.now();
      const symbol = data.market_symbol;
      for (const l of this.listeners) {
        if (l.type === "delta" && l.symbol === symbol) {
          this.safeFire(l.fn, data);
        }
      }
    });

    client.on("account", (data: WebSocketAccountUpdate) => {
      this.lastEventAt = Date.now();
      const accountId = data.account_id;
      for (const l of this.listeners) {
        if (l.type === "account" && l.accountId === accountId) {
          this.safeFire(l.fn, data);
        }
      }
    });

    client.on("candle", (data: WebSocketCandleUpdate) => {
      this.lastEventAt = Date.now();
      // `data.mid` is the numeric market_id. Filter by the symbol→marketId
      // cache; if we don't know the symbol's marketId yet, fall through to
      // dispatching to all candle listeners with matching resolution
      // (single-candle subscription is the typical case).
      // `data.res` arrives in enum-form ("OneMinute", "FiveMinutes", ...)
      // since SDK 0.4.3 — translate the listener's subscription-form
      // resolution before comparing.
      const payloadRes = data.res as unknown as string;
      for (const l of this.listeners) {
        if (l.type !== "candle") continue;
        if (RESOLUTION_PAYLOAD_FORM[l.resolution] !== payloadRes) continue;
        const cachedId = this.symbolToMarketId.get(l.symbol);
        if (cachedId !== undefined && cachedId !== data.mid) continue;
        this.safeFire(l.fn, data);
      }
    });
  }

  private safeFire<T>(fn: (data: T) => void, data: T): void {
    try {
      fn(data);
    } catch (err) {
      console.error("[ws-manager] listener threw:", err);
    }
  }

  private setState(next: WsState): void {
    if (this.state === next) return;
    this.state = next;
    // Tag the active client transport on Sentry so any errors captured
    // afterwards are correlated with whether the user is on WS or
    // (indirectly) on REST polling. We import lazily and via try/catch
    // because this module is imported on both server and client paths,
    // and pulling in @sentry/nextjs at the top would balloon the
    // server bundle for nothing.
    void this.tagSentryTransport(next);
    const snap = this.getSnapshot();
    for (const fn of this.stateListeners) {
      try {
        fn(snap);
      } catch (err) {
        console.error("[ws-manager] state listener threw:", err);
      }
    }
  }

  private async tagSentryTransport(state: WsState): Promise<void> {
    if (typeof window === "undefined") return;
    try {
      const Sentry = await import("@sentry/nextjs");
      // The "transport" tag flips to "ws" only when we have a live
      // socket; everything else (idle, connecting, disconnected, error)
      // means events for this user are coming from REST or nothing.
      Sentry.setTag("transport", state === "connected" ? "ws" : "rest");
    } catch {
      // Sentry not available in this environment — tagging is best-effort.
    }
  }
}

// ─── Module-level singleton ──────────────────────────────────────

let instance: NordWsManager | null = null;

export function getNordWsManager(): NordWsManager {
  if (!instance) instance = new NordWsManager();
  return instance;
}
