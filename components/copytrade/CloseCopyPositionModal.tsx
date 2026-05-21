"use client";

import { useState } from "react";
import { useNordMarketTicker } from "@/hooks/useNordMarketTicker";
import { apiFetch } from "@/lib/apiFetch";

// Copy-trading close modal. Mirrors the look-and-feel of
// `components/collateral/ClosePositionModal.tsx` but talks to the
// copy-engine endpoint (/api/copy/close-position), which is always
// full-close at a fixed slippage (no partial / no slippage picker —
// the engine guarantees reduce-only and ownership-gated close, so
// extra knobs would just be noise here).

type Step = "input" | "submitting" | "verifying" | "error" | "confirmed";

export interface CloseCopyModalData {
  marketId: number;
  symbol: string; // e.g. "SOLUSD"
  side: "Long" | "Short";
  size: number;
  entryPrice: number;
  tradingPnl: number;
  fundingPnl: number;
  owningLeader: string; // display, e.g. "#7915"
}

interface Props {
  isOpen: boolean;
  data: CloseCopyModalData;
  onClose: () => void;
  onSuccess?: () => void;
}

function fmtUsd(n: number, decimals = 2): string {
  if (!isFinite(n)) return "$0.00";
  const sign = n < 0 ? "-" : "";
  return sign + "$" + Math.abs(n).toFixed(decimals);
}

function fmtSize(n: number): string {
  return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

export function CloseCopyPositionModal({ isOpen, data, onClose, onSuccess }: Props) {
  const [step, setStep] = useState<Step>("input");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Real-time mark price for live PnL while the modal is open.
  const { lastPrice } = useNordMarketTicker(data.symbol, { enabled: isOpen });
  const isLong = data.side === "Long";
  const livePrice = lastPrice ?? data.entryPrice;
  const liveTradingPnl = isLong
    ? (livePrice - data.entryPrice) * data.size
    : (data.entryPrice - livePrice) * data.size;
  const liveTotalPnl = liveTradingPnl + (data.fundingPnl ?? 0);
  const closeValue = data.size * livePrice;
  const baseAsset = data.symbol.replace(/USD$/, "");

  if (!isOpen) return null;

  const handleClose = () => {
    if (step === "submitting" || step === "verifying") return;
    setStep("input");
    setErrorMsg(null);
    onClose();
  };

  async function verifyClosed(): Promise<boolean> {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch(`/api/copy/open-positions?_t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) continue;
        const body = await res.json();
        const positions = (body.positions ?? []) as Array<{ marketId?: number }>;
        const stillOpen = positions.some((p) => p.marketId === data.marketId);
        if (!stillOpen) return true;
      } catch {
        // retry
      }
    }
    return false;
  }

  const handleSubmit = async () => {
    setStep("submitting");
    setErrorMsg(null);
    try {
      const res = await apiFetch("/api/copy/close-position", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketId: data.marketId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStep("error");
        setErrorMsg(body.error || `Close failed (HTTP ${res.status})`);
        return;
      }
      const body = await res.json();
      if (body.noop) {
        setStep("confirmed");
        onSuccess?.();
        setTimeout(handleClose, 1500);
        return;
      }
      setStep("verifying");
      const ok = await verifyClosed();
      if (ok) {
        setStep("confirmed");
        onSuccess?.();
        setTimeout(handleClose, 1500);
      } else {
        setStep("error");
        setErrorMsg("Close submitted, but position is still showing as open. Refresh in a moment.");
      }
    } catch (err) {
      setStep("error");
      setErrorMsg(err instanceof Error ? err.message : "Close failed");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-[#262626] bg-[#0f0f0f] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#262626] px-6 py-4">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-white">Close Copy Position</h2>
            <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${
              isLong ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"
            }`}>
              {data.symbol} {data.side.toUpperCase()}
            </span>
          </div>
          <button
            onClick={handleClose}
            className="rounded-lg p-1 text-gray-500 transition-colors hover:bg-[#1a1a1a] hover:text-white"
            aria-label="Close"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6">
          {step === "input" && (
            <div className="space-y-5">
              {/* Position summary */}
              <div className="space-y-2 rounded-xl border border-[#262626] bg-[#141414] p-4">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Copied From</span>
                  <span className="font-mono text-white">{data.owningLeader}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Size</span>
                  <span className="font-mono text-white">
                    {fmtSize(data.size)} <span className="text-gray-500">{baseAsset}</span>
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Entry</span>
                  <span className="font-mono text-white">
                    {fmtUsd(data.entryPrice, data.entryPrice < 1 ? 6 : data.entryPrice < 100 ? 3 : 2)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Mark</span>
                  <span className="font-mono text-white">
                    {fmtUsd(livePrice, livePrice < 1 ? 6 : livePrice < 100 ? 3 : 2)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Close Value</span>
                  <span className="font-mono text-white">{fmtUsd(closeValue)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Live PnL</span>
                  <span className={`font-mono ${liveTotalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {liveTotalPnl >= 0 ? "+" : ""}{fmtUsd(liveTotalPnl)}
                  </span>
                </div>
              </div>

              <p className="text-xs text-gray-500">
                The engine will release ownership of this market after closing, so other leaders
                you follow can take it over.
              </p>

              {errorMsg && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
                  {errorMsg}
                </div>
              )}

              <button
                onClick={handleSubmit}
                className="w-full rounded-xl bg-gradient-to-r from-emerald-500/80 to-emerald-400/80 py-3.5 text-sm font-semibold text-black transition-opacity hover:opacity-90"
              >
                Market Close
              </button>
            </div>
          )}

          {step === "submitting" && (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="h-10 w-10 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
              <div className="text-center">
                <p className="text-sm font-medium text-white">Submitting close...</p>
                <p className="mt-1 text-xs text-gray-500">Sending order to 01 Exchange</p>
              </div>
            </div>
          )}

          {step === "verifying" && (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="h-10 w-10 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
              <div className="text-center">
                <p className="text-sm font-medium text-white">Verifying close...</p>
                <p className="mt-1 text-xs text-gray-500">Checking on-chain state</p>
              </div>
            </div>
          )}

          {step === "error" && (
            <div className="flex flex-col items-center gap-4 py-6">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/20">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-white">Close Failed</p>
                <p className="mt-1 text-xs text-gray-400">{errorMsg}</p>
              </div>
              <button
                onClick={() => { setStep("input"); }}
                className="w-full rounded-xl border border-[#262626] bg-[#141414] py-3 text-sm font-medium text-gray-300 transition-colors hover:bg-[#1a1a1a]"
              >
                Try Again
              </button>
            </div>
          )}

          {step === "confirmed" && (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/20">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              </div>
              <p className="text-sm font-medium text-white">Position Closed</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
