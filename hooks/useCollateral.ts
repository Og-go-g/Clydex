"use client";

import { useState, useCallback, useRef } from "react";
import * as Sentry from "@sentry/nextjs";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";

type Action = "deposit" | "withdraw";

// Hard cap — no single operation should exceed this. Exchange enforces its own limits too.
const MAX_AMOUNT = 1_000_000;

interface CollateralState {
  executing: boolean;
  error: string | null;
  success: boolean;
}

interface ExecuteResult {
  ok: boolean;
  balanceBefore: number | null;
}

/**
 * Hook for depositing/withdrawing USDC via the Nord SDK.
 * Sends the transaction and returns immediately.
 * Returns balanceBefore so the caller can poll for verification in background.
 *
 * Security notes:
 * - Session keypair is generated fresh each time (ephemeral, in-memory only)
 * - Wallet is prompted to sign the session creation and the deposit/withdraw tx
 * - No private keys are stored or transmitted
 */
export function useCollateral() {
  const { publicKey, signMessage, signTransaction } = useSolanaWallet();
  const [state, setState] = useState<CollateralState>({
    executing: false,
    error: null,
    success: false,
  });
  const abortRef = useRef(false);

  const execute = useCallback(
    async (action: Action, amount: number): Promise<ExecuteResult> => {
      if (!publicKey || !signMessage || !signTransaction) {
        setState({ executing: false, error: "Wallet not connected or does not support signing", success: false });
        return { ok: false, balanceBefore: null };
      }

      if (amount <= 0 || !isFinite(amount) || amount > MAX_AMOUNT) {
        setState({ executing: false, error: "Invalid amount", success: false });
        return { ok: false, balanceBefore: null };
      }

      abortRef.current = false;
      setState({ executing: true, error: null, success: false });

      try {
        const { depositUsdc, withdrawUsdc } = await import("@/lib/n1/user-client");
        const { getOrCreateUser } = await import("@/hooks/useOrderExecution");

        // Reuse cached NordUser session (same as trading) to avoid extra wallet popup
        const safePubkey = new PublicKey(publicKey.toBase58());
        const user = await getOrCreateUser({
          walletPubkey: safePubkey,
          signMessageFn: signMessage,
          signTransactionFn: signTransaction as (tx: import("@solana/web3.js").Transaction) => Promise<import("@solana/web3.js").Transaction>,
        });

        if (abortRef.current) {
          setState({ executing: false, error: "Cancelled", success: false });
          return { ok: false, balanceBefore: null };
        }

        // Snapshot collateral balance before tx for background verification
        let balanceBefore: number | null = null;
        try {
          const preRes = await fetch("/api/collateral");
          if (preRes.ok) {
            const preData = await preRes.json();
            balanceBefore = preData.collateral ?? null;
          }
        } catch {
          // Non-critical
        }

        // Execute the deposit or withdrawal (wallet signs here)
        if (action === "deposit") {
          await depositUsdc(user, amount);
        } else {
          await withdrawUsdc(user, amount);
        }

        if (abortRef.current) {
          setState({ executing: false, error: "Cancelled", success: false });
          return { ok: false, balanceBefore: null };
        }

        setState({ executing: false, error: null, success: true });
        return { ok: true, balanceBefore };
      } catch (err: unknown) {
        const rawMsg = err instanceof Error ? err.message : "";

        const isUserReject =
          rawMsg.includes("User rejected") ||
          rawMsg.includes("user rejected") ||
          rawMsg.includes("Transaction cancelled") ||
          rawMsg.includes("User denied");

        // Sanitize: never expose raw SDK errors to UI (may contain addresses, keys, stack info)
        let safeMsg: string;
        if (isUserReject) {
          safeMsg = "Transaction cancelled by user";
        } else if (rawMsg.includes("insufficient") || rawMsg.includes("Insufficient")) {
          safeMsg = "Insufficient funds for this transaction";
        } else if (rawMsg.toLowerCase().includes("invalid session") || rawMsg.toLowerCase().includes("session expired")) {
          // Session became invalid — clear cached NordUser so next attempt creates a fresh one
          const { invalidateSession } = await import("@/hooks/useOrderExecution");
          invalidateSession();
          safeMsg = "Session expired. Please try again.";
        } else if (rawMsg.includes("timeout") || rawMsg.includes("Timeout")) {
          safeMsg = "Transaction timed out. Please try again.";
        } else {
          safeMsg = "Transaction failed. Please try again.";
          Sentry.captureException(err, {
            tags: { component: "useCollateral", action },
            extra: { amount, walletPrefix: publicKey?.toBase58().slice(0, 8) },
          });
        }

        setState({
          executing: false,
          error: safeMsg,
          success: false,
        });
        return { ok: false, balanceBefore: null };
      }
    },
    [publicKey, signMessage, signTransaction]
  );

  const reset = useCallback(() => {
    abortRef.current = true;
    setState({ executing: false, error: null, success: false });
  }, []);

  return {
    execute,
    reset,
    executing: state.executing,
    error: state.error,
    success: state.success,
  };
}
