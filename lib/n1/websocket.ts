import { getNord } from "./client";
import type {
  WebSocketAccountUpdate,
  WebSocketTradeUpdate,
  WebSocketDeltaUpdate,
  WebSocketCandleUpdate,
  CandleResolution,
} from "@n1xyz/nord-ts";
import type { NordWebSocketClient } from "@n1xyz/nord-ts";

// Re-export types for convenience
export type {
  WebSocketAccountUpdate,
  WebSocketTradeUpdate,
  WebSocketDeltaUpdate,
  WebSocketCandleUpdate,
};

// ─── Typed Event Handlers ────────────────────────────────────────

export interface WsEventHandlers {
  onTrade?: (data: WebSocketTradeUpdate) => void;
  onDelta?: (data: WebSocketDeltaUpdate) => void;
  onAccount?: (data: WebSocketAccountUpdate) => void;
  onCandle?: (data: WebSocketCandleUpdate) => void;
  onError?: (error: Error) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

// ─── Subscription Manager ────────────────────────────────────────

export interface SubscriptionConfig {
  trades?: string[];       // market symbols e.g. ["BTCUSDC", "ETHUSDC"]
  deltas?: string[];       // market symbols for orderbook deltas
  accounts?: number[];     // account IDs
  candles?: Array<{ symbol: string; resolution: CandleResolution }>;
}

/**
 * Managed WebSocket connection wrapper around Nord's WS client.
 * Provides typed event handlers and automatic lifecycle management.
 */
export class N1WebSocketManager {
  private client: NordWebSocketClient | null = null;
  private handlers: WsEventHandlers;
  private config: SubscriptionConfig;
  private destroyed = false;

  constructor(config: SubscriptionConfig, handlers: WsEventHandlers) {
    this.config = config;
    this.handlers = handlers;
  }

  /** Connect to the WebSocket. Safe to call multiple times. */
  async connect(): Promise<void> {
    if (this.destroyed || this.client) return;

    const nord = await getNord();
    this.client = nord.createWebSocketClient({
      trades: this.config.trades,
      deltas: this.config.deltas,
      accounts: this.config.accounts,
      candles: this.config.candles,
    });

    // Bind event listeners
    if (this.handlers.onTrade) {
      this.client.on("trades", this.handlers.onTrade);
    }
    if (this.handlers.onDelta) {
      this.client.on("delta", this.handlers.onDelta);
    }
    if (this.handlers.onAccount) {
      this.client.on("account", this.handlers.onAccount);
    }
    if (this.handlers.onCandle) {
      this.client.on("candle", this.handlers.onCandle);
    }
    if (this.handlers.onError) {
      this.client.on("error", this.handlers.onError);
    }
    // NordWebSocketClient emits "connected" / "disconnected" (not "open" /
    // "close" — the WebSocket-native names). Older code here bound to the
    // wrong event names and the callbacks never fired. See
    // node_modules/@n1xyz/nord-ts/dist/index.browser.js → `this.emit("connected")`.
    if (this.handlers.onConnect) {
      this.client.on("connected", this.handlers.onConnect);
    }
    if (this.handlers.onDisconnect) {
      this.client.on("disconnected", this.handlers.onDisconnect);
    }

    this.client.connect();
  }

  /** Close the WebSocket connection permanently. */
  close(): void {
    this.destroyed = true;
    if (this.client) {
      this.client.removeAllListeners();
      this.client.close();
      this.client = null;
    }
  }

  /** Check if the connection is active. */
  get isConnected(): boolean {
    return this.client !== null && !this.destroyed;
  }
}

// ─── Convenience Factories ───────────────────────────────────────

/**
 * Create a trade subscription for one or more markets.
 * Returns a cleanup function.
 */
export function subscribeTrades(
  symbols: string[],
  onTrade: (data: WebSocketTradeUpdate) => void,
  onError?: (error: Error) => void
): () => void {
  const manager = new N1WebSocketManager(
    { trades: symbols },
    { onTrade, onError }
  );
  manager.connect().catch(onError ?? console.error);
  return () => manager.close();
}

/**
 * Create an orderbook delta subscription for one or more markets.
 * Returns a cleanup function.
 */
export function subscribeDeltas(
  symbols: string[],
  onDelta: (data: WebSocketDeltaUpdate) => void,
  onError?: (error: Error) => void
): () => void {
  const manager = new N1WebSocketManager(
    { deltas: symbols },
    { onDelta, onError }
  );
  manager.connect().catch(onError ?? console.error);
  return () => manager.close();
}

/**
 * Create an account subscription for real-time fills, orders, balances.
 * Returns a cleanup function.
 */
export function subscribeAccount(
  accountId: number,
  onAccount: (data: WebSocketAccountUpdate) => void,
  onError?: (error: Error) => void
): () => void {
  const manager = new N1WebSocketManager(
    { accounts: [accountId] },
    { onAccount, onError }
  );
  manager.connect().catch(onError ?? console.error);
  return () => manager.close();
}
