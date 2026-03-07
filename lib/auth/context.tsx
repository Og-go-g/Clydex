"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { useWallet } from "@/lib/wallet/context";
import { createSiweMessage } from "@/lib/auth/siwe";

/* ------------------------------------------------------------------ */
/*  Auth context — SIWE sign-in state                                 */
/* ------------------------------------------------------------------ */

interface AuthState {
  /** Whether the user has a valid SIWE session */
  isAuthenticated: boolean;
  /** Lowercase address from the verified session */
  sessionAddress: string | null;
  /** Trigger the SIWE sign-in flow (nonce → sign → verify) */
  signIn: () => Promise<void>;
  /** Destroy the session */
  signOut: () => Promise<void>;
  /** True while the MetaMask signature popup is open */
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
  // Track if user rejected the signature — don't auto-retry until address changes
  const [rejected, setRejected] = useState(false);
  // Wait for session check to complete before allowing auto-sign-in
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
    if (!address) return;
    setIsSigningIn(true);
    try {
      // 1. Get a fresh nonce from the server
      const nonceRes = await fetch("/api/auth/nonce");
      if (!nonceRes.ok) throw new Error("Failed to get nonce");
      const { nonce } = await nonceRes.json();

      // 2. Build the EIP-4361 message
      const message = createSiweMessage({
        domain: window.location.host,
        address,
        statement: "Sign in to Clydex",
        uri: window.location.origin,
        version: "1",
        chainId: 8453,
        nonce,
        issuedAt: new Date().toISOString(),
      });

      // 3. Request personal_sign from the active wallet provider
      const signature = await signMessage(message);

      // 4. Send to server for verification
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
      // User rejected the signature — stop auto-retrying
      setRejected(true);
      console.error("SIWE sign-in failed:", err);
    } finally {
      setIsSigningIn(false);
    }
  }, [address, signMessage]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setSessionAddress(null);
  }, []);

  // Auto sign-in when wallet connects, invalidate when it disconnects or changes
  useEffect(() => {
    if (!address && sessionAddress) {
      // Wallet disconnected — destroy session
      fetch("/api/auth/logout", { method: "POST" }).then(() =>
        setSessionAddress(null)
      );
      setRejected(false);
      return;
    }
    if (
      address &&
      sessionAddress &&
      address.toLowerCase() !== sessionAddress.toLowerCase()
    ) {
      // Address changed — destroy old session, reset rejection flag
      fetch("/api/auth/logout", { method: "POST" }).then(() =>
        setSessionAddress(null)
      );
      setRejected(false);
      return;
    }
    // Wallet connected but no session yet — only auto-trigger SIWE on explicit
    // user connect (not on auto-reconnect from sessionStorage / page refresh).
    // This prevents the wallet popup appearing every time the user refreshes.
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
