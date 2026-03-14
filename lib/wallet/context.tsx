"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
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
  /** Sign a message with the active wallet provider (EIP-191 personal_sign) */
  signMessage: (message: string) => Promise<string>;
  /** True when connection was user-initiated (not auto-reconnect from sessionStorage) */
  isManualConnect: boolean;
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
  signMessage: async () => "",
  isManualConnect: false,
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

// Shared listener handlers for cleanup tracking
type ListenerCleanup = () => void;

function attachProviderListeners(
  provider: EIP1193Provider,
  setAddress: (a: string | null) => void,
  setChainId: (c: number) => void
): ListenerCleanup {
  const handleAccounts = (accounts: string[]) => {
    setAddress(accounts[0] ?? null);
  };
  const handleChain = (id: string) => {
    setChainId(parseInt(id, 16));
  };

  provider.on("accountsChanged", handleAccounts);
  provider.on("chainChanged", handleChain);

  return () => {
    provider.removeListener("accountsChanged", handleAccounts);
    provider.removeListener("chainChanged", handleChain);
  };
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wallets, setWallets] = useState<EIP6963ProviderDetail[]>([]);
  const [showSelector, setShowSelector] = useState(false);
  const [activeProvider, setActiveProvider] = useState<EIP1193Provider | null>(null);
  const [isManualConnect, setIsManualConnect] = useState(false);

  // Track listener cleanup to prevent leaks on reconnect
  const listenerCleanupRef = useRef<ListenerCleanup | null>(null);

  function cleanupListeners() {
    if (listenerCleanupRef.current) {
      listenerCleanupRef.current();
      listenerCleanupRef.current = null;
    }
  }

  // Discover wallets + restore connection on mount (only if user previously connected)
  useEffect(() => {
    discoverWallets().then(setWallets);

    const wasConnected = sessionStorage.getItem("clydex-wallet-connected");
    const ethereum = getEthereum();
    if (!ethereum || !wasConnected) return;

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

    listenerCleanupRef.current = attachProviderListeners(ethereum, setAddress, setChainId);

    return () => {
      cleanupListeners();
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
    setIsManualConnect(true);

    try {
      const accounts: string[] = await provider.request({
        method: "eth_requestAccounts",
      });

      if (accounts.length > 0) {
        setAddress(accounts[0]);
        setActiveProvider(provider);
        sessionStorage.setItem("clydex-wallet-connected", "1");
      }

      const id: string = await provider.request({ method: "eth_chainId" });
      setChainId(parseInt(id, 16));

      if (id !== BASE_CHAIN_ID) {
        await switchChainToBase(provider);
        setChainId(8453);
      }

      setShowSelector(false);

      // Clean up previous listeners before attaching new ones
      cleanupListeners();
      listenerCleanupRef.current = attachProviderListeners(provider, setAddress, setChainId);
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
    setIsManualConnect(true);

    try {
      const accounts: string[] = await ethereum.request({
        method: "eth_requestAccounts",
      });

      if (accounts.length > 0) {
        setAddress(accounts[0]);
        setActiveProvider(ethereum);
        sessionStorage.setItem("clydex-wallet-connected", "1");
      }

      const id: string = await ethereum.request({ method: "eth_chainId" });
      setChainId(parseInt(id, 16));

      if (id !== BASE_CHAIN_ID) {
        await switchChainToBase(ethereum);
        setChainId(8453);
      }

      // Clean up previous listeners before attaching new ones
      cleanupListeners();
      listenerCleanupRef.current = attachProviderListeners(ethereum, setAddress, setChainId);
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
    cleanupListeners();
    setAddress(null);
    setChainId(null);
    setError(null);
    setActiveProvider(null);
    setIsManualConnect(false);
    sessionStorage.removeItem("clydex-wallet-connected");
  }, []);

  const switchToBase = useCallback(async () => {
    const provider = activeProvider ?? getEthereum();
    if (!provider) return;

    await switchChainToBase(provider);
    setChainId(8453);
  }, [activeProvider]);

  const signMessage = useCallback(
    async (message: string): Promise<string> => {
      const provider = activeProvider ?? getEthereum();
      if (!provider || !address) throw new Error("No wallet connected");

      // Convert message to hex for EIP-191 personal_sign compatibility
      // Some wallets expect hex-encoded data, others accept UTF-8 strings.
      // Hex is the safest format per the spec.
      const hexMessage = `0x${Array.from(new TextEncoder().encode(message))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}`;

      try {
        // Standard EIP-191: params = [data, account]
        const signature = await provider.request({
          method: "personal_sign",
          params: [hexMessage, address],
        });
        return signature as string;
      } catch (err: unknown) {
        const walletErr = err as { code?: number };
        // Some older wallets expect [account, data] — try reversed param order
        if (walletErr.code === -32602) {
          const signature = await provider.request({
            method: "personal_sign",
            params: [address, hexMessage],
          });
          return signature as string;
        }
        throw err;
      }
    },
    [activeProvider, address]
  );

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
        signMessage,
        isManualConnect,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}
