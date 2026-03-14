import { PARASWAP } from "../constants";
import { parseUnits, formatUnits } from "../utils";
import type {
  DexProvider,
  QuoteParams,
  SwapParams,
  ProviderQuote,
  SwapTransaction,
} from "./types";

// Paraswap (Velora) — free, no API key, no KYC
// Docs: https://developers.velora.xyz/api/velora-api

const CHAIN_ID = PARASWAP.CHAIN_ID;
const REQUEST_TIMEOUT = 8_000;

// Augustus V6.2 — same on all chains
// Users approve ERC20 spend to this address
const AUGUSTUS_V6 = PARASWAP.AUGUSTUS_V6;

interface PriceRoute {
  destAmount: string;
  gasCost: string;
  tokenTransferProxy: string;
  contractAddress: string;
  srcAmount: string;
  srcUSD: string;
  destUSD: string;
  [key: string]: unknown; // pass entire object to /transactions
}

/** Fetch with timeout + automatic fallback across all configured base URLs.
 *  Retries on 429 (rate limit) and network errors. */
async function fetchParaswap(
  path: string,
  options?: RequestInit
): Promise<Response> {
  let lastError: Error | null = null;

  for (const baseUrl of PARASWAP.BASE_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const res = await fetch(`${baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
      });

      // Rate limited — try next URL
      if (res.status === 429) {
        lastError = new Error(`Paraswap rate limited (429) at ${baseUrl}`);
        continue;
      }

      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("All Paraswap endpoints failed");
}

async function getPriceRoute(params: QuoteParams): Promise<PriceRoute> {
  const { fromToken, toToken, amount } = params;

  // Paraswap expects amount in raw units (wei)
  const amountRaw = parseUnits(amount, fromToken.decimals);

  const query = new URLSearchParams({
    srcToken: fromToken.address,
    destToken: toToken.address,
    amount: amountRaw,
    srcDecimals: String(fromToken.decimals),
    destDecimals: String(toToken.decimals),
    side: "SELL",
    network: String(CHAIN_ID),
    version: "6.2",
  });

  const res = await fetchParaswap(`/prices?${query}`);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Paraswap /prices failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  const priceRoute = data.priceRoute;

  if (!priceRoute?.destAmount) {
    throw new Error("Paraswap returned empty destAmount");
  }

  return priceRoute;
}

export const paraswap: DexProvider = {
  name: "Paraswap",

  async getQuote(params: QuoteParams): Promise<ProviderQuote> {
    const { fromToken, toToken, amount } = params;

    const priceRoute = await getPriceRoute(params);
    const amountRaw = parseUnits(amount, fromToken.decimals);

    const toAmountRaw = String(priceRoute.destAmount);
    const toAmount = formatUnits(toAmountRaw, toToken.decimals);
    const estimatedGas = parseInt(priceRoute.gasCost) || 200000;

    // Use tokenTransferProxy from response (for v6.2 = Augustus itself)
    const spender = priceRoute.tokenTransferProxy || AUGUSTUS_V6;

    // Calculate price impact from USD values returned by Paraswap
    const srcUSD = parseFloat(priceRoute.srcUSD) || 0;
    const destUSD = parseFloat(priceRoute.destUSD) || 0;
    const priceImpact =
      srcUSD > 0
        ? Number(((srcUSD - destUSD) / srcUSD * 100).toFixed(4))
        : 0;

    return {
      fromAmountRaw: amountRaw,
      toAmountRaw,
      toAmount,
      priceImpact,
      estimatedGas,
      exchangeProxy: spender,
    };
  },

  async getSwapCalldata(params: SwapParams): Promise<SwapTransaction> {
    const { fromToken, toToken, amount, userAddress, slippage } = params;

    // Security: validate slippage bounds to prevent sandwich attacks
    if (typeof slippage !== "number" || !isFinite(slippage) || slippage < 0.1 || slippage > 50) {
      throw new Error(`Slippage out of safe range (0.1%-50%): ${slippage}`);
    }

    // Security: validate amount is positive
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      throw new Error("Invalid swap amount: must be a positive number");
    }

    // Step 1: Get fresh priceRoute (required by /transactions)
    const priceRoute = await getPriceRoute(params);
    const amountRaw = parseUnits(amount, fromToken.decimals);

    // Step 2: Build transaction
    // Slippage: Paraswap uses basis points (100 = 1%)
    const slippageBps = Math.round(slippage * 100);

    const res = await fetchParaswap(`/transactions/${CHAIN_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        srcToken: fromToken.address,
        destToken: toToken.address,
        srcAmount: amountRaw,
        slippage: slippageBps,
        priceRoute,
        userAddress,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Paraswap /transactions failed: ${res.status} ${text}`);
    }

    const tx = await res.json();
    if (!tx?.to || !tx?.data) {
      throw new Error("Paraswap returned invalid swap transaction");
    }

    // Security: verify tx.to matches hardcoded Augustus V6 contract ONLY.
    // Do NOT trust priceRoute.contractAddress — it comes from the same API
    // and could be spoofed in a supply-chain attack to bypass this check.
    if (tx.to.toLowerCase() !== AUGUSTUS_V6.toLowerCase()) {
      throw new Error(
        `Paraswap returned unexpected target address: ${tx.to}. ` +
        `Expected: ${AUGUSTUS_V6}. Swap blocked for safety.`
      );
    }

    const gasWithBuffer = Math.ceil((parseInt(tx.gas) || 300000) * 1.3);

    return {
      to: tx.to,
      data: tx.data,
      value: tx.value ? `0x${BigInt(tx.value).toString(16)}` : "0x0",
      gasLimit: `0x${gasWithBuffer.toString(16)}`,
    };
  },
};
