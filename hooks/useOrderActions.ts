"use client";

import { useState, useCallback, useRef } from "react";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getOrCreateUser, invalidateSession } from "./useOrderExecution";

type ActionStatus = "idle" | "signing" | "submitting" | "confirmed" | "error";

interface OrderActionState {
  cancellingIds: Set<number>;
  closingSymbols: Set<string>;
  editingId: number | null;
  cancelAllProgress: { current: number; total: number } | null;
  lastError: string | null;
}

/**
 * Hook for direct order cancel/edit actions from Portfolio and Chat cards.
 * Independent per-order state — multiple cancels can be in-flight.
 */
export function useOrderActions() {
  const { publicKey, signMessage, signTransaction } = useSolanaWallet();
  const [state, setState] = useState<OrderActionState>({
    cancellingIds: new Set(),
    closingSymbols: new Set(),
    editingId: null,
    cancelAllProgress: null,
    lastError: null,
  });
  const executingRef = useRef(false);

  const withUser = useCallback(
    async <T>(fn: (user: import("@n1xyz/nord-ts").NordUser) => Promise<T>): Promise<T> => {
      if (!publicKey || !signMessage || !signTransaction) {
        throw new Error("Wallet not connected");
      }
      const safePubkey = new PublicKey(publicKey.toBase58());
      let user = await getOrCreateUser({
        walletPubkey: safePubkey,
        signMessageFn: signMessage,
        signTransactionFn: signTransaction as (tx: import("@solana/web3.js").Transaction) => Promise<import("@solana/web3.js").Transaction>,
      });
      try {
        return await fn(user);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("session") || msg.includes("Session") || msg.includes("expired")) {
          invalidateSession();
          user = await getOrCreateUser({
            walletPubkey: safePubkey,
            signMessageFn: signMessage,
            signTransactionFn: signTransaction as (tx: import("@solana/web3.js").Transaction) => Promise<import("@solana/web3.js").Transaction>,
          });
          return await fn(user);
        }
        throw err;
      }
    },
    [publicKey, signMessage, signTransaction]
  );

  const cancelOrder = useCallback(
    async (orderId: number): Promise<boolean> => {
      if (!publicKey) { setState(s => ({ ...s, lastError: "Wallet not connected" })); return false; }

      setState(s => ({ ...s, cancellingIds: new Set([...s.cancellingIds, orderId]), lastError: null }));

      try {
        const { cancelOrder: sdkCancel } = await import("@/lib/n1/user-client");
        await withUser(user => sdkCancel(user, orderId));
        setState(s => {
          const next = new Set(s.cancellingIds);
          next.delete(orderId);
          return { ...s, cancellingIds: next };
        });
        return true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Cancel failed";
        const isUserReject = /user rejected|user denied|cancelled|canceled/i.test(msg);
        setState(s => {
          const next = new Set(s.cancellingIds);
          next.delete(orderId);
          return { ...s, cancellingIds: next, lastError: isUserReject ? "Cancelled by user" : msg };
        });
        return false;
      }
    },
    [publicKey, withUser]
  );

  const cancelAllOrders = useCallback(
    async (orderIds: number[]): Promise<number> => {
      if (!publicKey || orderIds.length === 0) return 0;

      let cancelled = 0;
      setState(s => ({ ...s, cancelAllProgress: { current: 0, total: orderIds.length }, lastError: null }));

      for (let i = 0; i < orderIds.length; i++) {
        setState(s => ({ ...s, cancelAllProgress: { current: i + 1, total: orderIds.length } }));
        const ok = await cancelOrder(orderIds[i]);
        if (ok) cancelled++;
      }

      setState(s => ({ ...s, cancelAllProgress: null }));
      return cancelled;
    },
    [publicKey, cancelOrder]
  );

  const editOrder = useCallback(
    async (params: {
      oldOrderId: number;
      symbol: string;
      side: "Long" | "Short";
      size: number;
      price: number;
      leverage: number;
    }): Promise<boolean> => {
      if (!publicKey) { setState(s => ({ ...s, lastError: "Wallet not connected" })); return false; }

      setState(s => ({ ...s, editingId: params.oldOrderId, lastError: null }));

      try {
        const { editOrder: sdkEdit } = await import("@/lib/n1/user-client");
        await withUser(user => sdkEdit(user, {
          oldOrderId: params.oldOrderId,
          symbol: params.symbol,
          side: params.side,
          size: params.size,
          price: params.price,
          leverage: params.leverage,
        }));
        setState(s => ({ ...s, editingId: null }));
        return true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Edit failed";
        const isUserReject = /user rejected|user denied|cancelled|canceled/i.test(msg);
        setState(s => ({ ...s, editingId: null, lastError: isUserReject ? "Cancelled by user" : msg }));
        return false;
      }
    },
    [publicKey, withUser]
  );

  const closePosition = useCallback(
    async (params: { symbol: string; side: "Long" | "Short"; size: number; slippage?: number }): Promise<boolean> => {
      if (!publicKey) { setState(s => ({ ...s, lastError: "Wallet not connected" })); return false; }

      const key = `${params.symbol}:${params.side}`;
      setState(s => ({ ...s, closingSymbols: new Set([...s.closingSymbols, key]), lastError: null }));

      try {
        const { closePosition: sdkClose } = await import("@/lib/n1/user-client");
        await withUser(user => sdkClose(user, {
          symbol: params.symbol,
          side: params.side,
          size: params.size,
          slippage: params.slippage ?? 0.001,
        }));
        setState(s => {
          const next = new Set(s.closingSymbols);
          next.delete(key);
          return { ...s, closingSymbols: next };
        });
        return true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Close failed";
        const isUserReject = /user rejected|user denied|cancelled|canceled/i.test(msg);
        setState(s => {
          const next = new Set(s.closingSymbols);
          next.delete(key);
          return { ...s, closingSymbols: next, lastError: isUserReject ? "Cancelled by user" : msg };
        });
        return false;
      }
    },
    [publicKey, withUser]
  );

  const clearError = useCallback(() => {
    setState(s => ({ ...s, lastError: null }));
  }, []);

  return {
    cancelOrder,
    cancelAllOrders,
    editOrder,
    closePosition,
    clearError,
    cancellingIds: state.cancellingIds,
    closingSymbols: state.closingSymbols,
    editingId: state.editingId,
    cancelAllProgress: state.cancelAllProgress,
    lastError: state.lastError,
    walletConnected: !!publicKey,
  };
}
