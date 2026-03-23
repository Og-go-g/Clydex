"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface ChartPanelState {
  isOpen: boolean;
  marketId: number;
  baseAsset: string;
  toggle: () => void;
  open: (marketId?: number, baseAsset?: string) => void;
  close: () => void;
  setMarket: (marketId: number, baseAsset: string) => void;
}

const ChartPanelContext = createContext<ChartPanelState | null>(null);

// Default to BTC (marketId 0 on 01 Exchange)
const DEFAULT_MARKET_ID = 0;
const DEFAULT_BASE_ASSET = "BTC";

export function ChartPanelProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [marketId, setMarketId] = useState(DEFAULT_MARKET_ID);
  const [baseAsset, setBaseAsset] = useState(DEFAULT_BASE_ASSET);

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
    <ChartPanelContext.Provider value={{ isOpen, marketId, baseAsset, toggle, open, close, setMarket }}>
      {children}
    </ChartPanelContext.Provider>
  );
}

export function useChartPanel(): ChartPanelState {
  const ctx = useContext(ChartPanelContext);
  if (!ctx) throw new Error("useChartPanel must be used within ChartPanelProvider");
  return ctx;
}

/** Safe version — returns null when outside ChartPanelProvider (no throw) */
export function useChartPanelSafe(): ChartPanelState | null {
  return useContext(ChartPanelContext);
}
