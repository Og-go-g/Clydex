import { SUPPORTED_CHAINS, type Chain } from "./chains";

const MORALIS_API_KEY = process.env.MORALIS_API_KEY || "";
const MORALIS_BASE = "https://deep-index.moralis.io/api/v2.2";

if (!MORALIS_API_KEY && typeof window === "undefined") {
  console.warn("[moralis] MORALIS_API_KEY not set — portfolio will not work");
}

// --- Types ---

interface MoralisToken {
  token_address: string;
  symbol: string;
  name: string;
  logo: string | null;
  thumbnail: string | null;
  decimals: number;
  balance: string;
  possible_spam: boolean;
  verified_contract: boolean;
  usd_price: number | null;
  usd_price_24hr_percent_change: number | null;
  usd_value: number | null;
  native_token: boolean;
  portfolio_percentage: number;
}

export interface TokenHolding {
  chain: string;
  chainId: number;
  address: string;
  symbol: string;
  name: string;
  logo: string | null;
  decimals: number;
  balance: string;
  usdPrice: number | null;
  usdValue: number | null;
  priceChange24h: number | null;
  isNative: boolean;
}

export interface PortfolioResponse {
  address: string;
  tokens: TokenHolding[];
  totalUsdValue: number;
  chainBreakdown: Record<string, { usdValue: number; tokenCount: number }>;
  fetchedAt: number;
  errors: string[];
}

// --- Helpers ---

function formatBalance(raw: string, decimals: number): string {
  if (decimals === 0) return raw;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals) || "0";
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

// --- Fetching ---

async function fetchChainTokens(
  address: string,
  chain: Chain
): Promise<TokenHolding[]> {
  if (!MORALIS_API_KEY) throw new Error("MORALIS_API_KEY not configured");
  const url = `${MORALIS_BASE}/wallets/${address}/tokens?chain=${chain.slug}`;

  const res = await fetch(url, {
    headers: {
      "X-API-Key": MORALIS_API_KEY,
      accept: "application/json",
    },
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    throw new Error(`Moralis ${chain.name}: ${res.status}`);
  }

  const data = await res.json();
  const results: MoralisToken[] = data.result || [];

  return results
    .filter((t) => {
      // 1. Moralis spam flag
      if (t.possible_spam) return false;
      // 2. Native tokens always pass
      if (t.native_token) return true;
      // 3. Zero balance
      if (t.balance === "0") return false;
      // 4. No legit token has a unit price > $1M
      if (t.usd_price && t.usd_price > 1_000_000) return false;
      // 5. Unverified contracts — almost always scam airdrops
      if (!t.verified_contract) return false;
      // 6. No price data from Moralis = likely scam or dead token
      if (t.usd_price === null || t.usd_price === 0) return false;
      // 7. Suspicious names: URLs, emojis, "claim", "visit", special chars
      const nameLower = (t.name + " " + t.symbol).toLowerCase();
      if (/https?:|\.com|\.io|\.xyz|\.org|claim|visit|airdrop|reward/.test(nameLower)) return false;
      if (/[^\x20-\x7E]/.test(t.symbol)) return false; // non-ASCII symbols
      // 8. Absurdly high balance with tiny value = fake liquidity scam
      const balanceNum = parseFloat(t.balance) / 10 ** t.decimals;
      if (balanceNum > 1_000_000 && (t.usd_value || 0) < 10) return false;
      return true;
    })
    .map((t) => ({
      chain: chain.slug,
      chainId: chain.id,
      address: t.token_address,
      symbol: t.symbol,
      name: t.name,
      logo: t.logo || t.thumbnail,
      decimals: t.decimals,
      balance: formatBalance(t.balance, t.decimals),
      usdPrice: t.usd_price,
      usdValue: t.usd_value,
      priceChange24h: t.usd_price_24hr_percent_change,
      isNative: t.native_token,
    }));
}

export async function getMultiChainPortfolio(
  address: string
): Promise<PortfolioResponse> {
  const errors: string[] = [];

  const results = await Promise.allSettled(
    SUPPORTED_CHAINS.map((chain) => fetchChainTokens(address, chain))
  );

  const allTokens: TokenHolding[] = [];
  const chainBreakdown: Record<string, { usdValue: number; tokenCount: number }> = {};

  results.forEach((result, i) => {
    const chain = SUPPORTED_CHAINS[i];
    if (result.status === "fulfilled") {
      allTokens.push(...result.value);
      chainBreakdown[chain.slug] = {
        usdValue: result.value.reduce((s, t) => s + (t.usdValue || 0), 0),
        tokenCount: result.value.length,
      };
    } else {
      errors.push(chain.name);
      chainBreakdown[chain.slug] = { usdValue: 0, tokenCount: 0 };
    }
  });

  // Sort by USD value desc, tokens without price go to bottom
  allTokens.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));

  return {
    address,
    tokens: allTokens,
    totalUsdValue: allTokens.reduce((s, t) => s + (t.usdValue || 0), 0),
    chainBreakdown,
    fetchedAt: Date.now(),
    errors,
  };
}
