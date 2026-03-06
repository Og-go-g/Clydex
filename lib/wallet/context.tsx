"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { discoverWallets, type EIP6963ProviderDetail } from "./eip6963";

const BASE_CHAIN_ID = "0x2105"; // 8453 in hex

interface WalletState {
  address: string | null;
  chainId: number | null;
  isConnecting: boolean;
  error: string | null;
  /** Discovered EVM wallets (EIP-6963) */
  wallets: EIP6963ProviderDetail[];
  /** Show wallet selector modal */
  showSelector: boolean;
  openSelector: () => void;
  closeSelector: () => void;
  /** Connect a specific wallet from the list */
  connectWallet: (wallet: EIP6963ProviderDetail) => Promise<void>;
  /** Legacy connect — uses window.ethereum directly */
  connect: () => Promise<void>;
  disconnect: () => void;
  switchToBase: () => Promise<void>;
}

const WalletContext = createContext<WalletState>({
  address: null,
  chainId: null,
  isConnecting: false,
  error: null,
  wallets: [],
  showSelector: false,
  openSelector: () => {},
  closeSelector: () => {},
  connectWallet: async () => {},
  connect: async () => {},
  disconnect: () => {},
  switchToBase: async () => {},
});

export function useWallet() {
  return useContext(WalletContext);
}

function getEthereum(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  return window.ethereum ?? null;
}

async function switchChainToBase(provider: EIP1193Provider): Promise<void> {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_CHAIN_ID }],
    });
  } catch (switchError: unknown) {
    const switchErr = switchError as { code?: number };
    if (switchErr.code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: BASE_CHAIN_ID,
            chainName: "Base",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://mainnet.base.org"],
            blockExplorerUrls: ["https://basescan.org"],
          },
        ],
      });
    }
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wallets, setWallets] = useState<EIP6963ProviderDetail[]>([]);
  const [showSelector, setShowSelector] = useState(false);
  const [activeProvider, setActiveProvider] = useState<EIP1193Provider | null>(null);

  // Discover wallets + restore connection on mount
  useEffect(() => {
    discoverWallets().then(setWallets);

    const ethereum = getEthereum();
    if (!ethereum) return;

    ethereum
      .request({ method: "eth_accounts" })
      .then((accounts: string[]) => {
        if (accounts.length > 0) {
          setAddress(accounts[0]);
          setActiveProvider(ethereum);
        }
      })
      .catch(() => {});

    ethereum
      .request({ method: "eth_chainId" })
      .then((id: string) => setChainId(parseInt(id, 16)))
      .catch(() => {});

    const handleAccountsChanged = (accounts: string[]) => {
      setAddress(accounts[0] ?? null);
    };
    const handleChainChanged = (id: string) => {
      setChainId(parseInt(id, 16));
    };

    ethereum.on("accountsChanged", handleAccountsChanged);
    ethereum.on("chainChanged", handleChainChanged);

    return () => {
      ethereum.removeListener("accountsChanged", handleAccountsChanged);
      ethereum.removeListener("chainChanged", handleChainChanged);
    };
  }, []);

  const openSelector = useCallback(() => {
    setError(null);
    setShowSelector(true);
  }, []);

  const closeSelector = useCallback(() => {
    setShowSelector(false);
  }, []);

  /** Connect a specific EIP-6963 wallet */
  const connectWallet = useCallback(async (wallet: EIP6963ProviderDetail) => {
    const provider = wallet.provider;
    setIsConnecting(true);
    setError(null);

    try {
      const accounts: string[] = await provider.request({
        method: "eth_requestAccounts",
      });

      if (accounts.length > 0) {
        setAddress(accounts[0]);
        setActiveProvider(provider);
      }

      const id: string = await provider.request({ method: "eth_chainId" });
      setChainId(parseInt(id, 16));

      if (id !== BASE_CHAIN_ID) {
        await switchChainToBase(provider);
        setChainId(8453);
      }

      setShowSelector(false);

      // Listen for changes on this provider
      provider.on("accountsChanged", (accs: string[]) => {
        setAddress(accs[0] ?? null);
      });
      provider.on("chainChanged", (cid: string) => {
        setChainId(parseInt(cid, 16));
      });
    } catch (err: unknown) {
      const walletErr = err as { code?: number; message?: string };
      if (walletErr.code === 4001) {
        setError("Connection rejected by user");
      } else {
        setError(walletErr.message || "Failed to connect");
      }
    } finally {
      setIsConnecting(false);
    }
  }, []);

  /** Legacy connect — fallback to window.ethereum */
  const connect = useCallback(async () => {
    // If we have discovered wallets, show the selector
    if (wallets.length > 1) {
      setShowSelector(true);
      return;
    }
    // Only 1 wallet — connect directly
    if (wallets.length === 1) {
      await connectWallet(wallets[0]);
      return;
    }

    // No EIP-6963 wallets — try window.ethereum
    const ethereum = getEthereum();
    if (!ethereum) {
      setError("No wallet found. Install MetaMask or Rabby.");
      return;
    }

    setIsConnecting(true);
    setError(null);

    try {
      const accounts: string[] = await ethereum.request({
        method: "eth_requestAccounts",
      });

      if (accounts.length > 0) {
        setAddress(accounts[0]);
        setActiveProvider(ethereum);
      }

      const id: string = await ethereum.request({ method: "eth_chainId" });
      setChainId(parseInt(id, 16));

      if (id !== BASE_CHAIN_ID) {
        await switchChainToBase(ethereum);
        setChainId(8453);
      }
    } catch (err: unknown) {
      const walletErr = err as { code?: number; message?: string };
      if (walletErr.code === 4001) {
        setError("Connection rejected by user");
      } else {
        setError(walletErr.message || "Failed to connect");
      }
    } finally {
      setIsConnecting(false);
    }
  }, [wallets, connectWallet]);

  const disconnect = useCallback(() => {
    setAddress(null);
    setChainId(null);
    setError(null);
    setActiveProvider(null);
  }, []);

  const switchToBase = useCallback(async () => {
    const provider = activeProvider ?? getEthereum();
    if (!provider) return;

    await switchChainToBase(provider);
    setChainId(8453);
  }, [activeProvider]);

  return (
    <WalletContext.Provider
      value={{
        address,
        chainId,
        isConnecting,
        error,
        wallets,
        showSelector,
        openSelector,
        closeSelector,
        connectWallet,
        connect,
        disconnect,
        switchToBase,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}
