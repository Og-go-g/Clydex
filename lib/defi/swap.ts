import { TOKENS, OPENOCEAN } from "./constants";
import { openocean } from "./providers/openocean";
import { paraswap } from "./providers/paraswap";
import type {
  DexProvider,
  QuoteParams,
  SwapTransaction,
} from "./providers/types";

// Re-export for backwards compatibility
export type { SwapTransaction } from "./providers/types";

// --- Types ---

export interface SwapQuote {
  fromToken: { symbol: string; address: string; decimals: number };
  toToken: { symbol: string; address: string; decimals: number };
  fromAmount: string;
  fromAmountRaw: string;
  toAmount: string;
  toAmountRaw: string;
  priceImpact: number;
  estimatedGas: number;
  exchangeProxy: string;
  provider: string; // which aggregator gave the best price
}

// --- Providers ---
// Both are free, no API keys — always active

const ALL_PROVIDERS: DexProvider[] = [openocean, paraswap];

function getActiveProviders(): DexProvider[] {
  return ALL_PROVIDERS;
}

// --- Token Resolution ---

function resolveToken(symbolOrAddress: string): {
  address: string;
  decimals: number;
  symbol: string;
} {
  const upper = symbolOrAddress.toUpperCase();

  const known = TOKENS[upper as keyof typeof TOKENS];
  if (known) {
    return {
      address: known.address || OPENOCEAN.NATIVE_ETH_ADDRESS,
      decimals: known.decimals,
      symbol: known.symbol,
    };
  }

  // Only allow known tokens — reject raw addresses to prevent
  // swaps with unverified tokens that could have wrong decimals
  throw new Error(
    `Unknown token: "${symbolOrAddress}". Supported: ${Object.keys(TOKENS).join(", ")}`
  );
}

// --- Quote Cache ---
// Key: "fromAddr|toAddr|amount|userAddr" → { data, timestamp }

const QUOTE_CACHE_TTL = 10_000; // 10 seconds
const QUOTE_CACHE_MAX_SIZE = 500;
const quoteCache = new Map<string, { data: SwapQuote; timestamp: number }>();

// Lazy cleanup — runs on cache access instead of setInterval
// (setInterval is unreliable in serverless environments)
function cleanupQuoteCache() {
  if (quoteCache.size < QUOTE_CACHE_MAX_SIZE) return;
  const now = Date.now();
  for (const [key, entry] of quoteCache) {
    if (now - entry.timestamp > QUOTE_CACHE_TTL * 3) {
      quoteCache.delete(key);
    }
  }
}

// --- Quote (meta-routing) ---

export async function getSwapQuote(
  fromTokenSymbol: string,
  toTokenSymbol: string,
  amount: string,
  userAddress: string
): Promise<SwapQuote> {
  // Validate amount
  const numAmount = Number(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    throw new Error(`Invalid swap amount: "${amount}". Must be a positive number.`);
  }

  // Prevent swapping a token for itself
  if (fromTokenSymbol.toUpperCase() === toTokenSymbol.toUpperCase()) {
    throw new Error("Cannot swap a token for itself.");
  }

  const fromToken = resolveToken(fromTokenSymbol);
  const toToken = resolveToken(toTokenSymbol);

  // Lazy cleanup on access
  cleanupQuoteCache();

  // Cache key includes userAddress to prevent cross-user quote leakage
  const cacheKey = `${fromToken.address}|${toToken.address}|${amount}|${userAddress.toLowerCase()}`;
  const cached = quoteCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < QUOTE_CACHE_TTL) {
    return cached.data;
  }

  // Query all providers in parallel
  const providers = getActiveProviders();
  const params: QuoteParams = { fromToken, toToken, amount, userAddress };

  const results = await Promise.allSettled(
    providers.map((p) => p.getQuote(params).then((q) => ({ provider: p, quote: q })))
  );

  // Collect successful quotes
  const successful = results
    .filter((r): r is PromiseFulfilledResult<{ provider: DexProvider; quote: Awaited<ReturnType<DexProvider["getQuote"]>> }> =>
      r.status === "fulfilled"
    )
    .map((r) => r.value);

  if (successful.length === 0) {
    // All providers failed — throw the first error
    const firstError = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    );
    throw firstError?.reason ?? new Error("All DEX providers failed");
  }

  // Pick best by highest output amount
  const best = successful.reduce((a, b) =>
    BigInt(a.quote.toAmountRaw) >= BigInt(b.quote.toAmountRaw) ? a : b
  );

  // Log provider comparison in dev only
  if (successful.length > 1 && process.env.NODE_ENV === "development") {
    console.log(
      `[meta-router] ${successful.map((s) => `${s.provider.name}: ${s.quote.toAmount}`).join(" | ")} → winner: ${best.provider.name}`
    );
  }

  const quote: SwapQuote = {
    fromToken,
    toToken,
    fromAmount: amount,
    fromAmountRaw: best.quote.fromAmountRaw,
    toAmount: best.quote.toAmount,
    toAmountRaw: best.quote.toAmountRaw,
    priceImpact: best.quote.priceImpact,
    estimatedGas: best.quote.estimatedGas,
    exchangeProxy: best.quote.exchangeProxy,
    provider: best.provider.name,
  };

  // Cache the winning quote
  quoteCache.set(cacheKey, { data: quote, timestamp: Date.now() });

  return quote;
}

// --- Swap Calldata ---

export async function getSwapCalldata(
  fromTokenSymbol: string,
  toTokenSymbol: string,
  amount: string,
  userAddress: string,
  slippage: number = 1,
  providerName?: string
): Promise<SwapTransaction> {
  // Validate slippage range
  if (!isFinite(slippage) || slippage < 0.1 || slippage > 50) {
    throw new Error(`Slippage out of safe range (0.1%-50%): ${slippage}`);
  }

  const fromToken = resolveToken(fromTokenSymbol);
  const toToken = resolveToken(toTokenSymbol);

  // IMPORTANT: Use the same provider that generated the quote.
  // The user already approved token spend for that provider's router.
  // Re-doing meta-routing here would risk a different provider winning,
  // causing the swap to revert (approval mismatch).
  const providers = getActiveProviders();
  const target = providerName
    ? providers.find((p) => p.name === providerName)
    : providers[0]; // fallback to first (OpenOcean)

  if (!target) {
    throw new Error(`Provider "${providerName}" not available`);
  }

  return target.getSwapCalldata({
    fromToken,
    toToken,
    amount,
    userAddress,
    slippage,
  });
}
