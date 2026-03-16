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
import { useWallet } from "@/lib/wallet/context";
import { createSiwsMessage } from "@/lib/auth/siws";

/* ------------------------------------------------------------------ */
/*  Auth context — Sign-In with Solana state                          */
/* ------------------------------------------------------------------ */

interface AuthState {
  isAuthenticated: boolean;
  sessionAddress: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  isSigningIn: boolean;
}

const AuthContext = createContext<AuthState>({
  isAuthenticated: false,
  sessionAddress: null,
  signIn: async () => {},
  signOut: async () => {},
  isSigningIn: false,
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { address, signMessage, isManualConnect } = useWallet();
  const [sessionAddress, setSessionAddress] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const isSigningInRef = useRef(false);
  const [rejected, setRejected] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(false);

  // Check existing session on mount
  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((d) => setSessionAddress(d.address ?? null))
      .catch(() => {})
      .finally(() => setSessionChecked(true));
  }, []);

  const signIn = useCallback(async () => {
    if (!address || isSigningInRef.current) return;
    isSigningInRef.current = true;
    setIsSigningIn(true);
    try {
      // 1. Get a fresh nonce from the server
      const nonceRes = await fetch("/api/auth/nonce");
      if (!nonceRes.ok) throw new Error("Failed to get nonce");
      const { nonce } = await nonceRes.json();

      // 2. Build the SIWS message
      const message = createSiwsMessage({
        domain: window.location.host,
        address,
        statement: "Sign in to Clydex",
        uri: window.location.origin,
        nonce,
        issuedAt: new Date().toISOString(),
      });

      // 3. Sign with Solana wallet (ed25519)
      const signatureBytes = await signMessage(message);

      // 4. Encode signature as base58 for transport
      // Dynamic import to avoid SSR issues with bs58
      const { default: bs58 } = await import("bs58");
      const signature = bs58.encode(signatureBytes);

      // 5. Send to server for verification
      const loginRes = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });

      if (loginRes.ok) {
        const data = await loginRes.json();
        setSessionAddress(data.address);
      }
    } catch (err) {
      setRejected(true);
      console.error("SIWS sign-in failed:", err);
    } finally {
      isSigningInRef.current = false;
      setIsSigningIn(false);
    }
  }, [address, signMessage]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setSessionAddress(null);
  }, []);

  // Auto sign-in when wallet connects
  useEffect(() => {
    if (!address && sessionAddress) {
      fetch("/api/auth/logout", { method: "POST" }).then(() =>
        setSessionAddress(null)
      );
      setRejected(false);
      return;
    }
    if (address && sessionAddress && address !== sessionAddress) {
      fetch("/api/auth/logout", { method: "POST" }).then(() =>
        setSessionAddress(null)
      );
      setRejected(false);
      return;
    }
    if (address && !sessionAddress && !isSigningIn && !rejected && sessionChecked && isManualConnect) {
      signIn();
    }
  }, [address, sessionAddress, isSigningIn, rejected, sessionChecked, isManualConnect, signIn]);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated: !!sessionAddress,
        sessionAddress,
        signIn,
        signOut,
        isSigningIn,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
