// Order types supported by 01 Exchange
export type OrderType = "Limit" | "PostOnly" | "ImmediateOrCancel" | "FillOrKill";
export type OrderSide = "Long" | "Short";
export type ConditionalOrderType = "StopLoss" | "TakeProfit";

// Market definition
export interface N1Market {
  id: number;
  symbol: string;        // e.g. "BTC-PERP"
  baseAsset: string;     // e.g. "BTC"
  tier: number;          // 1-5
  initialMarginFraction: number; // e.g. 0.02 for Tier 1
  maxLeverage: number;   // e.g. 50 for Tier 1
}

// Market statistics from GET /market/{id}/stats
export interface MarketStats {
  marketId: number;
  symbol: string;
  markPrice: number;
  indexPrice: number;
  lastPrice: number;
  change24h: number;     // percentage
  volume24h: number;     // in USD
  openInterest: number;  // in USD
  fundingRate: number;   // current funding rate (hourly)
  nextFundingTime: number; // unix timestamp
}

// Orderbook level
export interface OrderbookLevel {
  price: number;
  size: number;          // in base asset units
  total: number;         // cumulative size
}

export interface Orderbook {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  spread: number;
  midPrice: number;
  timestamp: number;
}

// Trade from recent trades
export interface RecentTrade {
  id: string;
  marketId: number;
  price: number;
  size: number;
  side: OrderSide;
  timestamp: number;
}

// User position
export interface Position {
  marketId: number;
  symbol: string;
  side: OrderSide;
  size: number;          // in base asset
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number; // in USDC
  realizedPnl: number;
  leverage: number;
  marginUsed: number;    // in USDC
  liquidationPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

// Account info
export interface AccountInfo {
  accountId: number;
  publicKey: string;     // base58 Solana pubkey
  collateral: number;    // USDC deposited
  totalMarginUsed: number;
  availableMargin: number;
  marginRatio: number;   // 0-1, lower = more danger
  unrealizedPnl: number;
  realizedPnl: number;
  positions: Position[];
}

// Open order
export interface OpenOrder {
  orderId: string;
  marketId: number;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  price: number;
  size: number;
  filledSize: number;
  status: "open" | "partial" | "filled" | "cancelled";
  createdAt: number;
}

// Action payload for POST /action
export interface PlaceOrderAction {
  type: "place_order";
  marketId: number;
  side: OrderSide;
  size: number;
  price?: number;        // required for limit orders
  orderType: OrderType;
  leverage: number;
  reduceOnly?: boolean;
}

export interface CancelOrderAction {
  type: "cancel_order";
  orderId: string;
}

export interface ConditionalOrderAction {
  type: "conditional_order";
  marketId: number;
  conditionType: ConditionalOrderType;
  triggerPrice: number;
  size?: number;         // if not specified, closes full position
}

export interface WithdrawAction {
  type: "withdraw";
  amount: number;        // USDC amount
}

export type N1Action = PlaceOrderAction | CancelOrderAction | ConditionalOrderAction | WithdrawAction;

// Exchange info from GET /info
export interface ExchangeInfo {
  markets: Array<{
    id: number;
    symbol: string;
    baseAsset: string;
    tier: number;
    initialMarginFraction: number;
    maintenanceMarginFraction: number;
    tickSize: number;
    minOrderSize: number;
    maxOrderSize: number;
  }>;
  collateralToken: {
    symbol: string;
    mint: string;
    decimals: number;
  };
  fees: {
    makerFee: number;
    takerFee: number;
  };
}

// Order preview (before execution)
export interface OrderPreview {
  previewId: string;
  market: string;
  side: OrderSide;
  size: number;
  leverage: number;
  estimatedEntryPrice: number;
  estimatedLiquidationPrice: number;
  marginRequired: number;
  estimatedFee: number;
  priceImpact: number;   // percentage
  warnings: string[];    // risk warnings
}
