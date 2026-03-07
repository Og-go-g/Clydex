// Base Mainnet (Chain ID: 8453)
export const BASE_CHAIN_ID = 8453;

// RPC endpoints — all from env, tried in order with auto-fallback.
// BASE_RPC_URLS (comma-separated) or single BASE_RPC_URL.
function parseUrls(env: string | undefined): string[] {
  return (env || "").split(",").map((u) => u.trim()).filter(Boolean);
}

export const BASE_RPCS: string[] = parseUrls(
  process.env.BASE_RPC_URLS || process.env.BASE_RPC_URL
);

export const BASE_RPC = BASE_RPCS[0];

// Core token addresses on Base
export const TOKENS = {
  ETH: {
    symbol: "ETH",
    name: "Ethereum",
    address: "" as const, // native
    decimals: 18,
  },
  WETH: {
    symbol: "WETH",
    name: "Wrapped Ether",
    address: "0x4200000000000000000000000000000000000006" as const,
    decimals: 18,
  },
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
    decimals: 6,
  },
  AERO: {
    symbol: "AERO",
    name: "Aerodrome",
    address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" as const,
    decimals: 18,
  },
  CBETH: {
    symbol: "cbETH",
    name: "Coinbase Wrapped Staked ETH",
    address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" as const,
    decimals: 18,
  },
} as const;

// Protocol addresses on Base
export const PROTOCOLS = {
  UNISWAP_SWAP_ROUTER: "0x2626664c2603336E57B271c5C0b26F421741e481",
  UNISWAP_QUOTER_V2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  MORPHO_CORE: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  AAVE_POOL: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
} as const;

// DexScreener — token prices, URLs from DEXSCREENER_URLS env var
export const DEXSCREENER_URLS: string[] = parseUrls(process.env.DEXSCREENER_URLS);

// DeFi Llama — yields/APY, URLs from DEFILLAMA_URLS env var
export const DEFILLAMA_URLS: string[] = parseUrls(process.env.DEFILLAMA_URLS);

// GeckoTerminal — OHLCV chart data, URLs from GECKOTERMINAL_URLS env var
export const GECKOTERMINAL_URLS: string[] = parseUrls(
  process.env.GECKOTERMINAL_URLS || "https://api.geckoterminal.com"
);

// OpenOcean DEX aggregator — URLs from OPENOCEAN_URLS env var
export const OPENOCEAN = {
  BASE_URLS: parseUrls(process.env.OPENOCEAN_URLS),
  CHAIN_ID: 8453,
  NATIVE_ETH_ADDRESS: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  EXCHANGE_PROXY: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
  DEFAULT_SLIPPAGE: 1,
} as const;

// Paraswap (Velora) DEX aggregator — URLs from PARASWAP_URLS env var
// Augustus V6.2 — same address on all chains
export const PARASWAP = {
  BASE_URLS: parseUrls(process.env.PARASWAP_URLS),
  CHAIN_ID: 8453,
  NATIVE_ETH_ADDRESS: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  AUGUSTUS_V6: "0x6a000f20005980200259b80c5102003040001068",
} as const;
