"use client";

import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";
import { getMessages } from "@/lib/chat/store";

interface ChartPanelState {
  isOpen: boolean;
  marketId: number;
  baseAsset: string;
  toggle: () => void;
  open: (marketId?: number, baseAsset?: string) => void;
  close: () => void;
  setMarket: (marketId: number, baseAsset: string) => void;
  setChatId: (chatId: string | null) => void;
}

const ChartPanelContext = createContext<ChartPanelState | null>(null);

const STORAGE_PREFIX = "chart-panel:";
const PENDING_KEY = "chart-pending-open";
const DEFAULT_MARKET_ID = 0;
const DEFAULT_BASE_ASSET = "BTC";

interface PersistedState { isOpen: boolean; marketId: number; baseAsset: string }

function loadForChat(chatId: string): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + chatId);
    if (raw) {
      const s = JSON.parse(raw);
      return {
        isOpen: s.isOpen ?? false,
        marketId: typeof s.marketId === "number" ? s.marketId : DEFAULT_MARKET_ID,
        baseAsset: typeof s.baseAsset === "string" ? s.baseAsset : DEFAULT_BASE_ASSET,
      };
    }
  } catch { /* ignore */ }
  return { isOpen: false, marketId: DEFAULT_MARKET_ID, baseAsset: DEFAULT_BASE_ASSET };
}

function persistForChat(chatId: string, state: PersistedState) {
  try { localStorage.setItem(STORAGE_PREFIX + chatId, JSON.stringify(state)); } catch { /* ignore */ }
}

/**
 * Called from markets "Trade X" button before navigation.
 * Stores pending chart open in sessionStorage.
 */
export function setPendingChartOpen(marketId: number, baseAsset: string, prefill?: string) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ marketId, baseAsset, prefill: prefill ?? "" }));
  } catch { /* ignore */ }
}

export function ChartPanelProvider({ children }: { children: ReactNode }) {
  const chatIdRef = useRef<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [marketId, setMarketId] = useState(DEFAULT_MARKET_ID);
  const [baseAsset, setBaseAsset] = useState(DEFAULT_BASE_ASSET);
  const skipPersistRef = useRef(false);
  // Ref for fresh state values (avoids stale closures)
  const stateRef = useRef({ isOpen, marketId, baseAsset });
  stateRef.current = { isOpen, marketId, baseAsset };

  // Core: called when active chat changes
  const setChatId = useCallback((id: string | null) => {
    if (!id || id === chatIdRef.current) return;

    // Save old chat state
    if (chatIdRef.current) {
      persistForChat(chatIdRef.current, stateRef.current);
    }
    chatIdRef.current = id;

    // Check for pending "Trade X" open
    let pending: { marketId: number; baseAsset: string; prefill: string } | null = null;
    try {
      const raw = sessionStorage.getItem(PENDING_KEY);
      if (raw) pending = JSON.parse(raw);
    } catch { /* ignore */ }

    if (pending) {
      // Check if current chat is empty (no messages)
      const hasMessages = getMessages(id).length > 0;

      if (hasMessages) {
        // Chat has messages — don't apply here, leave pending for a new/empty chat
        // Just load this chat's saved state normally
        const saved = loadForChat(id);
        skipPersistRef.current = true;
        setIsOpen(saved.isOpen);
        setMarketId(saved.marketId);
        setBaseAsset(saved.baseAsset);
        requestAnimationFrame(() => { skipPersistRef.current = false; });
        return;
      }

      // Empty chat — consume pending and apply
      sessionStorage.removeItem(PENDING_KEY);
      skipPersistRef.current = true;
      setMarketId(pending.marketId);
      setBaseAsset(pending.baseAsset);
      setIsOpen(true);
      persistForChat(id, { isOpen: true, marketId: pending.marketId, baseAsset: pending.baseAsset });
      if (pending.prefill) {
        try { sessionStorage.setItem("chart-prefill", pending.prefill); } catch { /* ignore */ }
      }
      requestAnimationFrame(() => { skipPersistRef.current = false; });
      return;
    }

    // No pending — normal load from saved state
    const saved = loadForChat(id);
    skipPersistRef.current = true;
    setIsOpen(saved.isOpen);
    setMarketId(saved.marketId);
    setBaseAsset(saved.baseAsset);
    requestAnimationFrame(() => { skipPersistRef.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-persist on state changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const persistTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const doPersist = useCallback(() => {
    if (skipPersistRef.current || !chatIdRef.current) return;
    persistForChat(chatIdRef.current, stateRef.current);
  }, []);

  // Debounced persist
  const schedPersist = useCallback(() => {
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(doPersist, 100);
  }, [doPersist]);

  // Persist whenever state changes
  const prevState = useRef({ isOpen, marketId, baseAsset });
  if (prevState.current.isOpen !== isOpen || prevState.current.marketId !== marketId || prevState.current.baseAsset !== baseAsset) {
    prevState.current = { isOpen, marketId, baseAsset };
    schedPersist();
  }

  const toggle = useCallback(() => setIsOpen((v) => !v), []);
  const close = useCallback(() => setIsOpen(false), []);
  const open = useCallback((mId?: number, bAsset?: string) => {
    if (mId !== undefined) setMarketId(mId);
    if (bAsset) setBaseAsset(bAsset);
    setIsOpen(true);
  }, []);
  const setMarket = useCallback((mId: number, bAsset: string) => {
    setMarketId(mId);
    setBaseAsset(bAsset);
  }, []);

  return (
    <ChartPanelContext.Provider value={{ isOpen, marketId, baseAsset, toggle, open, close, setMarket, setChatId }}>
      {children}
    </ChartPanelContext.Provider>
  );
}

export function useChartPanel(): ChartPanelState {
  const ctx = useContext(ChartPanelContext);
  if (!ctx) throw new Error("useChartPanel must be used within ChartPanelProvider");
  return ctx;
}

export function useChartPanelSafe(): ChartPanelState | null {
  return useContext(ChartPanelContext);
}
