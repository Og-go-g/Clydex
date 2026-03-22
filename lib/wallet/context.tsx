"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
  useWallet as useSolanaWallet,
} from "@solana/wallet-adapter-react";
import {
  WalletModalProvider,
  useWalletModal,
} from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { clusterApiUrl } from "@solana/web3.js";

// Import default wallet adapter styles
import "@solana/wallet-adapter-react-ui/styles.css";

/* ------------------------------------------------------------------ */
/*  Clydex Wallet Context — wraps Solana wallet adapter               */
/* ------------------------------------------------------------------ */

interface WalletState {
  /** Base58 public key of connected wallet */
  address: string | null;
  /** Whether wallet is currently connected */
  connected: boolean;
  /** Whether a connection attempt is in progress */
  isConnecting: boolean;
  /** Last error message */
  error: string | null;
  /** Connect wallet (opens wallet modal) */
  connect: () => void;
  /** Disconnect wallet */
  disconnect: () => Promise<void>;
  /** Sign an arbitrary message (for auth) */
  signMessage: (message: string) => Promise<Uint8Array>;
  /** True when connection was user-initiated (not auto-reconnect) */
  isManualConnect: boolean;
}

const WalletContext = createContext<WalletState>({
  address: null,
  connected: false,
  isConnecting: false,
  error: null,
  connect: () => {},
  disconnect: async () => {},
  signMessage: async () => new Uint8Array(),
  isManualConnect: false,
});

export function useWallet() {
  return useContext(WalletContext);
}

/* ------------------------------------------------------------------ */
/*  Inner provider — has access to Solana wallet adapter hooks        */
/* ------------------------------------------------------------------ */

function WalletContextInner({ children }: { children: ReactNode }) {
  const {
    publicKey,
    connected,
    connecting,
    disconnect: solanaDisconnect,
    signMessage: solanaSignMessage,
    select,
    wallets,
    wallet,
  } = useSolanaWallet();
  const { setVisible } = useWalletModal();

  const [error, setError] = useState<string | null>(null);
  const [isManualConnect, setIsManualConnect] = useState(false);

  const address = publicKey?.toBase58() ?? null;

  // Track manual connect via sessionStorage
  // On auto-reconnect (page reload), isManualConnect stays false
  // Only set to true when user explicitly clicks Connect Wallet
  useEffect(() => {
    if (connected && address) {
      sessionStorage.setItem("clydex-wallet-connected", "1");
    }
    if (!connected) {
      setIsManualConnect(false);
    }
  }, [connected, address]);

  const connect = useCallback(() => {
    setError(null);
    setIsManualConnect(true);
    // If a wallet is already selected, just connect
    if (wallet) {
      // The wallet adapter auto-connects when selected
      return;
    }
    // If only one wallet available, select it directly
    if (wallets.length === 1 && wallets[0].readyState === "Installed") {
      select(wallets[0].adapter.name);
      return;
    }
    // Open the wallet selection modal
    setVisible(true);
  }, [wallet, wallets, select, setVisible]);

  const disconnect = useCallback(async () => {
    try {
      await solanaDisconnect();
      sessionStorage.removeItem("clydex-wallet-connected");
      setIsManualConnect(false);
      setError(null);
    } catch (err: unknown) {
      const walletErr = err as { message?: string };
      setError(walletErr.message || "Failed to disconnect");
    }
  }, [solanaDisconnect]);

  const signMessage = useCallback(
    async (message: string): Promise<Uint8Array> => {
      if (!solanaSignMessage) {
        throw new Error("Wallet does not support message signing");
      }
      try {
        const messageBytes = new TextEncoder().encode(message);
        const signature = await solanaSignMessage(messageBytes);
        return signature;
      } catch (err: unknown) {
        const walletErr = err as { message?: string };
        setError(walletErr.message || "Failed to sign message");
        throw err;
      }
    },
    [solanaSignMessage]
  );

  return (
    <WalletContext.Provider
      value={{
        address,
        connected,
        isConnecting: connecting,
        error,
        connect,
        disconnect,
        signMessage,
        isManualConnect,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/*  Outer provider — sets up Solana connection + wallet adapters      */
/* ------------------------------------------------------------------ */

export function WalletProvider({ children }: { children: ReactNode }) {
  // Use public Solana RPC for wallet adapter (connect/sign only).
  // All data reads go through our server proxy (/api/solana-rpc).
  // NEVER use a keyed RPC URL here — it would leak to the browser.
  const endpoint = useMemo(() => clusterApiUrl("mainnet-beta"), []);

  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <WalletContextInner>{children}</WalletContextInner>
        </WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
