// Shared types for all DEX aggregator providers

export interface QuoteParams {
  fromToken: { address: string; decimals: number; symbol: string };
  toToken: { address: string; decimals: number; symbol: string };
  amount: string; // human-readable (e.g. "1.5")
  userAddress: string;
}

export interface SwapParams extends QuoteParams {
  slippage: number;
}

export interface ProviderQuote {
  toAmountRaw: string; // raw output — used for best-price comparison
  toAmount: string; // human-readable output
  fromAmountRaw: string;
  priceImpact: number;
  estimatedGas: number;
  exchangeProxy: string; // router/proxy address (differs per provider)
}

export interface SwapTransaction {
  to: string;
  data: string;
  value: string;
  gasLimit: string;
}

export interface DexProvider {
  name: string;
  getQuote(params: QuoteParams): Promise<ProviderQuote>;
  getSwapCalldata(params: SwapParams): Promise<SwapTransaction>;
}
