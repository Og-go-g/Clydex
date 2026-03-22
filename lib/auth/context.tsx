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
  /** Sign-in (SIWS) — for manual "Sign In" button when session expired */
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
  const addressRef = useRef(address);
  addressRef.current = address;
  const [sessionChecked, setSessionChecked] = useState(false);
  const rejectedRef = useRef(false);

  // Check existing session on mount (restores session if cookie is valid)
  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((d) => setSessionAddress(d.address ?? null))
      .catch(() => {})
      .finally(() => setSessionChecked(true));
  }, []);

  // Core sign-in logic
  const signIn = useCallback(async () => {
    if (!address || isSigningInRef.current) return;
    // Reset rejected flag on manual signIn call (button click)
    rejectedRef.current = false;
    isSigningInRef.current = true;
    setIsSigningIn(true);
    try {
      const nonceRes = await fetch("/api/auth/nonce");
      if (!nonceRes.ok) throw new Error("Failed to get nonce");
      const { nonce } = await nonceRes.json();

      const message = createSiwsMessage({
        domain: window.location.host,
        address,
        statement: "Sign in to Clydex",
        uri: window.location.origin,
        nonce,
        issuedAt: new Date().toISOString(),
      });

      const signatureBytes = await signMessage(message);
      const { default: bs58 } = await import("bs58");
      const signature = bs58.encode(signatureBytes);

      const loginRes = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });

      if (loginRes.ok) {
        const data = await loginRes.json();
        setSessionAddress(data.address);
      } else {
        throw new Error(`Login failed: ${loginRes.status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isUserReject =
        /user rejected|user denied|cancelled|canceled|rejected the request|declined/i.test(msg);
      // Mark as rejected so auto sign-in doesn't retry
      rejectedRef.current = true;
      if (!isUserReject) {
        console.error("SIWS sign-in failed:", msg);
      }
    } finally {
      isSigningInRef.current = false;
      setIsSigningIn(false);
    }
  }, [address, signMessage]);

  const signOut = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        console.error("Logout request failed:", res.status);
      }
    } catch {
      // Network error — still clear local session
    }
    setSessionAddress(null);
  }, []);

  // Auto sign-in ONLY when user clicked "Connect Wallet" (manual connect)
  // Does NOT trigger on page reload auto-reconnect
  // Does NOT retry after user rejected or sign-in failed
  useEffect(() => {
    if (
      isManualConnect &&
      address &&
      !sessionAddress &&
      !isSigningIn &&
      sessionChecked &&
      !rejectedRef.current
    ) {
      signIn();
    }
  }, [isManualConnect, address, sessionAddress, isSigningIn, sessionChecked, signIn]);

  // Clear session when wallet disconnects or address changes
  // Consolidated into single check to prevent duplicate logout requests
  const logoutInFlightRef = useRef(false);
  useEffect(() => {
    const shouldLogout =
      (!address && sessionAddress) ||
      (address && sessionAddress && address !== sessionAddress);
    if (!shouldLogout || logoutInFlightRef.current) return;
    logoutInFlightRef.current = true;
    const currentAddr = address;
    fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
      .finally(() => {
        logoutInFlightRef.current = false;
        // Address changed during fetch — a new effect cycle will handle it
        if (addressRef.current !== currentAddr) return;
        setSessionAddress(null);
      });
  }, [address, sessionAddress]);

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
