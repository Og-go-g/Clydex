"use client";

import {
  createContext,
  useContext,
  useState,
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
}

const WalletContext = createContext<WalletState>({
  address: null,
  connected: false,
  isConnecting: false,
  error: null,
  connect: () => {},
  disconnect: async () => {},
  signMessage: async () => new Uint8Array(),
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

  const address = publicKey?.toBase58() ?? null;

  const connect = useCallback(() => {
    setError(null);
    // A wallet is already selected (e.g. from a prior session) but not
    // connected — drive the adapter directly so the user doesn't have to
    // pick from the modal again.
    if (wallet) {
      void wallet.adapter.connect().catch((err: unknown) => {
        const walletErr = err as { message?: string };
        setError(walletErr.message || "Failed to connect");
      });
      return;
    }
    // Only one installed wallet — skip the modal and select it directly.
    if (wallets.length === 1 && wallets[0].readyState === "Installed") {
      select(wallets[0].adapter.name);
      return;
    }
    // Otherwise show the wallet picker.
    setVisible(true);
  }, [wallet, wallets, select, setVisible]);

  const disconnect = useCallback(async () => {
    try {
      await solanaDisconnect();
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
