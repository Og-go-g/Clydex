export interface Chain {
  id: number;
  name: string;
  slug: string; // Moralis chain parameter
  color: string;
  nativeSymbol: string;
  explorerUrl: string;
}

export const SUPPORTED_CHAINS: Chain[] = [
  { id: 1, name: "Ethereum", slug: "eth", color: "#627EEA", nativeSymbol: "ETH", explorerUrl: "https://etherscan.io" },
  { id: 8453, name: "Base", slug: "base", color: "#0052FF", nativeSymbol: "ETH", explorerUrl: "https://basescan.org" },
  { id: 42161, name: "Arbitrum", slug: "arbitrum", color: "#28A0F0", nativeSymbol: "ETH", explorerUrl: "https://arbiscan.io" },
  { id: 10, name: "Optimism", slug: "optimism", color: "#FF0420", nativeSymbol: "ETH", explorerUrl: "https://optimistic.etherscan.io" },
  { id: 137, name: "Polygon", slug: "polygon", color: "#8247E5", nativeSymbol: "POL", explorerUrl: "https://polygonscan.com" },
  { id: 56, name: "BSC", slug: "bsc", color: "#F0B90B", nativeSymbol: "BNB", explorerUrl: "https://bscscan.com" },
  { id: 43114, name: "Avalanche", slug: "avalanche", color: "#E84142", nativeSymbol: "AVAX", explorerUrl: "https://snowtrace.io" },
];

export const CHAIN_BY_SLUG = Object.fromEntries(
  SUPPORTED_CHAINS.map((c) => [c.slug, c])
) as Record<string, Chain>;
