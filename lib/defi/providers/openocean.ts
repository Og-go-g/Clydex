import { OPENOCEAN } from "../constants";
import { parseUnits, formatUnits } from "../utils";
import type {
  DexProvider,
  QuoteParams,
  SwapParams,
  ProviderQuote,
  SwapTransaction,
} from "./types";

const REQUEST_TIMEOUT = 8_000; // 8 seconds

/** Fetch with timeout + automatic fallback across all configured base URLs.
 *  Retries on 429 (rate limit) and network errors. */
async function fetchOpenOcean(
  path: string,
  options?: RequestInit
): Promise<Response> {
  let lastError: Error | null = null;

  for (const baseUrl of OPENOCEAN.BASE_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const res = await fetch(`${baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
      });

      // Rate limited — try next URL
      if (res.status === 429) {
        lastError = new Error(`OpenOcean rate limited (429) at ${baseUrl}`);
        continue;
      }

      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("All OpenOcean endpoints failed");
}

export const openocean: DexProvider = {
  name: "OpenOcean",

  async getQuote(params: QuoteParams): Promise<ProviderQuote> {
    const { fromToken, toToken, amount, userAddress } = params;

    // OpenOcean expects amount in human-readable format (e.g. "1" for 1 ETH)
    const query = new URLSearchParams({
      inTokenAddress: fromToken.address,
      outTokenAddress: toToken.address,
      amount,
      gasPrice: "1000000",
      slippage: String(OPENOCEAN.DEFAULT_SLIPPAGE),
      account: userAddress,
    });

    const res = await fetchOpenOcean(
      `/v4/${OPENOCEAN.CHAIN_ID}/quote?${query}`
    );

    if (!res.ok) {
      throw new Error(`OpenOcean quote failed: ${res.status}`);
    }

    const data = await res.json();
    if (data.code !== 200) {
      throw new Error(data.error || "OpenOcean quote failed");
    }

    const result = data.data;
    if (!result?.outAmount) {
      throw new Error("OpenOcean returned empty outAmount");
    }

    // price_impact is a string like "-0.12%" — parse to number
    const priceImpactStr = String(result.price_impact ?? "0").replace("%", "");
    const priceImpact = parseFloat(priceImpactStr) || 0;

    return {
      fromAmountRaw: result.inAmount || parseUnits(amount, fromToken.decimals),
      toAmountRaw: String(result.outAmount),
      toAmount: formatUnits(String(result.outAmount), toToken.decimals),
      priceImpact,
      estimatedGas: result.estimatedGas ?? 200000,
      exchangeProxy: OPENOCEAN.EXCHANGE_PROXY,
    };
  },

  async getSwapCalldata(params: SwapParams): Promise<SwapTransaction> {
    const { fromToken, toToken, amount, userAddress, slippage } = params;

    const query = new URLSearchParams({
      inTokenAddress: fromToken.address,
      outTokenAddress: toToken.address,
      amount,
      gasPrice: "1000000",
      slippage: String(slippage),
      account: userAddress,
    });

    const res = await fetchOpenOcean(
      `/v4/${OPENOCEAN.CHAIN_ID}/swap?${query}`
    );

    if (!res.ok) {
      throw new Error(`OpenOcean swap failed: ${res.status}`);
    }

    const data = await res.json();
    if (data.code !== 200) {
      throw new Error(data.error || "OpenOcean swap failed");
    }

    const tx = data.data;
    if (!tx?.to || !tx?.data) {
      throw new Error("OpenOcean returned invalid swap transaction");
    }

    const gasWithBuffer = Math.ceil((tx.estimatedGas ?? 300000) * 1.3);

    return {
      to: tx.to,
      data: tx.data,
      value: tx.value ? `0x${BigInt(tx.value).toString(16)}` : "0x0",
      gasLimit: `0x${gasWithBuffer.toString(16)}`,
    };
  },
};
