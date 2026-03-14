export interface Chain {
  id: number;
  name: string;
  slug: string; // Moralis chain parameter
  color: string;
  nativeSymbol: string;
  explorerUrl: string;
  rpcUrl: string;
}

export const SUPPORTED_CHAINS: Chain[] = [
  { id: 1, name: "Ethereum", slug: "eth", color: "#627EEA", nativeSymbol: "ETH", explorerUrl: "https://etherscan.io", rpcUrl: "https://eth.drpc.org" },
  { id: 8453, name: "Base", slug: "base", color: "#0052FF", nativeSymbol: "ETH", explorerUrl: "https://basescan.org", rpcUrl: "https://mainnet.base.org" },
  { id: 42161, name: "Arbitrum", slug: "arbitrum", color: "#28A0F0", nativeSymbol: "ETH", explorerUrl: "https://arbiscan.io", rpcUrl: "https://arb1.arbitrum.io/rpc" },
  { id: 10, name: "Optimism", slug: "optimism", color: "#FF0420", nativeSymbol: "ETH", explorerUrl: "https://optimistic.etherscan.io", rpcUrl: "https://mainnet.optimism.io" },
  { id: 137, name: "Polygon", slug: "polygon", color: "#8247E5", nativeSymbol: "POL", explorerUrl: "https://polygonscan.com", rpcUrl: "https://polygon-rpc.com" },
  { id: 56, name: "BSC", slug: "bsc", color: "#F0B90B", nativeSymbol: "BNB", explorerUrl: "https://bscscan.com", rpcUrl: "https://bsc-dataseed1.binance.org" },
  { id: 43114, name: "Avalanche", slug: "avalanche", color: "#E84142", nativeSymbol: "AVAX", explorerUrl: "https://snowtrace.io", rpcUrl: "https://api.avax.network/ext/bc/C/rpc" },
];

export const CHAIN_BY_SLUG: Partial<Record<string, Chain>> = Object.fromEntries(
  SUPPORTED_CHAINS.map((c) => [c.slug, c])
);
