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
  /** Trigger SIWS sign-in. Resolves when a session is established or aborted. */
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  isSigningIn: boolean;
  /** True until the initial /api/auth/session probe finishes. */
  sessionChecked: boolean;
  /** Last sign-in error message (user-rejected, network, server). null when idle/successful. */
  signInError: string | null;
  clearSignInError: () => void;
}

const AuthContext = createContext<AuthState>({
  isAuthenticated: false,
  sessionAddress: null,
  signIn: async () => {},
  signOut: async () => {},
  isSigningIn: false,
  sessionChecked: false,
  signInError: null,
  clearSignInError: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { address, signMessage } = useWallet();
  const [sessionAddress, setSessionAddress] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const isSigningInRef = useRef(false);
  const addressRef = useRef(address);
  addressRef.current = address;
  const [sessionChecked, setSessionChecked] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  // Per-address guard so a single failure (esp. user rejection) doesn't
  // re-trigger the popup forever. Resets when address changes or user
  // explicitly clicks Sign In again.
  const rejectedRef = useRef(false);

  const clearSignInError = useCallback(() => setSignInError(null), []);

  // Probe existing session on mount (restores session if cookie is valid).
  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => (r.ok ? r.json() : { address: null }))
      .then((d: { address?: string | null }) =>
        setSessionAddress(d.address ?? null)
      )
      .catch(() => setSessionAddress(null))
      .finally(() => setSessionChecked(true));
  }, []);

  const signIn = useCallback(async () => {
    if (!address || isSigningInRef.current) return;
    rejectedRef.current = false;
    setSignInError(null);
    isSigningInRef.current = true;
    setIsSigningIn(true);
    const startedForAddress = address;

    try {
      const nonceRes = await fetch("/api/auth/nonce");
      if (!nonceRes.ok) throw new Error(`Failed to get nonce (${nonceRes.status})`);
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

      // Address changed mid-flight (user swapped wallets) — abort.
      if (addressRef.current !== startedForAddress) return;

      const loginRes = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });

      if (!loginRes.ok) {
        throw new Error(`Login failed (${loginRes.status})`);
      }
      const data = await loginRes.json();
      if (addressRef.current !== startedForAddress) return;
      setSessionAddress(data.address);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const isUserReject =
        /user rejected|user denied|cancelled|canceled|rejected the request|declined/i.test(
          raw
        );
      rejectedRef.current = true;
      if (isUserReject) {
        setSignInError("Sign-in cancelled in wallet. Click Sign In to retry.");
      } else {
        console.error("SIWS sign-in failed:", raw);
        setSignInError(`Sign-in failed: ${raw}`);
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
    rejectedRef.current = false;
    setSignInError(null);
    setSessionAddress(null);
  }, []);

  // Wallet swap / disconnect → reset SIWS guard + clear stale error so the
  // next address gets a fresh shot at signing in.
  useEffect(() => {
    rejectedRef.current = false;
    setSignInError(null);
  }, [address]);

  // Auto sign-in: any time we have a connected wallet but no server session
  // (and the cookie probe finished) — kick off SIWS. The rejectedRef guard
  // prevents a popup loop after the user dismissed Phantom; a manual
  // signIn() call (or a fresh address) clears it.
  useEffect(() => {
    if (
      address &&
      !sessionAddress &&
      !isSigningIn &&
      sessionChecked &&
      !rejectedRef.current
    ) {
      signIn();
    }
  }, [address, sessionAddress, isSigningIn, sessionChecked, signIn]);

  // Server-side logout when wallet detaches or swaps to a different pubkey.
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
        sessionChecked,
        signInError,
        clearSignInError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
