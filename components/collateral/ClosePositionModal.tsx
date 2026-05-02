"use client";

import { useState } from "react";
import { useNordMarketTicker } from "@/hooks/useNordMarketTicker";

// ─── Types ──────────────────────────────────────────────────────

type Step = "input" | "signing" | "verifying" | "error" | "confirmed";

const SLIPPAGE_OPTIONS = [
  { label: "0.1%", value: 0.001 },
  { label: "0.5%", value: 0.005 },
  { label: "1%", value: 0.01 },
  { label: "5%", value: 0.05 },
  { label: "None", value: 0 },
] as const;

const SIZE_PRESETS = [25, 50, 75, 100] as const;

interface ClosePositionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  position: {
    symbol: string;       // "SOLUSD"
    displaySymbol: string; // "SOL/USD"
    side: "Long" | "Short";
    isLong: boolean;
    absSize: number;
    entryPrice: number;
    markPrice: number;     // initial snapshot — fallback if WS unavailable
    totalPnl: number;
    positionValue: number;
  };
  doClose: (params: { symbol: string; side: "Long" | "Short"; size: number; slippage?: number }) => Promise<boolean>;
}

// ─── Helpers ────────────────────────────────────────────────────

function formatUsd(n: number, decimals = 2): string {
  if (!isFinite(n)) return "$0.00";
  const sign = n < 0 ? "-" : "";
  return sign + "$" + Math.abs(n).toFixed(decimals);
}

function formatSize(n: number, decimals = 4): string {
  return n.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

// ─── Component ──────────────────────────────────────────────────

export function ClosePositionModal({
  isOpen,
  onClose,
  onSuccess,
  position,
  doClose,
}: ClosePositionModalProps) {
  const [sizePercent, setSizePercent] = useState(100);
  const [slippage, setSlippage] = useState(0.001); // default 0.1%
  const [step, setStep] = useState<Step>("input");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Real-time price via the Nord WS singleton manager. Subscribes only
  // while the modal is open; tears down on close so the manager can drop
  // the trade subscription if no other component needs it.
  const wsSymbol = position.symbol.replace(/\//, "");
  const { lastPrice } = useNordMarketTicker(wsSymbol, { enabled: isOpen });
  const livePrice = lastPrice ?? position.markPrice;

  const closeSize = position.absSize * (sizePercent / 100);
  const closeValue = closeSize * livePrice;
  const estimatedPnl = position.isLong
    ? (livePrice - position.entryPrice) * closeSize
    : (position.entryPrice - livePrice) * closeSize;

  // Estimated taker fee (0.05% default)
  const estimatedFee = closeValue * 0.0005;

  if (!isOpen) return null;

  const handleClose = () => {
    if (step === "signing" || step === "verifying") return; // don't close mid-execution
    setStep("input");
    setErrorMsg(null);
    setSizePercent(100);
    onClose();
  };

  const handleSubmit = async () => {
    setStep("signing");
    setErrorMsg(null);

    try {
      const ok = await doClose({
        symbol: position.symbol,
        side: position.side,
        size: closeSize,
        slippage: slippage || undefined,
      });

      if (ok) {
        setStep("verifying");
        const verified = await verifyPositionClosed();
        if (verified) {
          setStep("confirmed");
          onSuccess?.();
          setTimeout(handleClose, 1500);
        } else {
          setStep("error");
          setErrorMsg("Position may still be open — increase slippage and retry");
        }
      } else {
        setStep("error");
        setErrorMsg("Close order failed — try increasing slippage");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Close failed";
      const isUserReject = /user rejected|user denied|cancelled|canceled/i.test(msg);
      if (isUserReject) {
        setStep("input");
      } else {
        setStep("error");
        setErrorMsg(msg);
      }
    }
  };

  async function verifyPositionClosed(): Promise<boolean> {
    const sym = position.symbol.replace(/\//, "").toUpperCase();
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const res = await fetch(`/api/account?_t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) continue;
        const data = await res.json();
        const positions = (data.positions ?? []) as Array<{ symbol?: string; perp?: { baseSize?: number } }>;
        const stillOpen = positions.some(p => {
          const pSym = (p.symbol ?? "").replace(/\//, "").toUpperCase();
          return (pSym === sym || pSym.startsWith(sym.replace(/USD$/, "")))
            && Math.abs(p.perp?.baseSize ?? 0) > 1e-12;
        });
        if (!stillOpen) return true;
      } catch {
        // retry
      }
    }
    return false;
  }

  // ─── Render ─────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-[#262626] bg-[#0f0f0f] shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#262626] px-6 py-4">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-white">Close Position</h2>
            <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${
              position.isLong
                ? "bg-green-500/15 text-green-400"
                : "bg-red-500/15 text-red-400"
            }`}>
              {position.displaySymbol} {position.side.toUpperCase()}
            </span>
          </div>
          <button
            onClick={handleClose}
            className="rounded-lg p-1 text-gray-500 transition-colors hover:bg-[#1a1a1a] hover:text-white"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6">
          {/* ─── Input Step ─── */}
          {step === "input" && (
            <div className="space-y-5">
              {/* Size */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm text-gray-400">Close Size</span>
                  <span className="font-mono text-sm text-white">
                    {formatSize(closeSize)} <span className="text-gray-500">{position.displaySymbol.split("/")[0]}</span>
                  </span>
                </div>
                <div className="flex gap-2">
                  {SIZE_PRESETS.map(pct => (
                    <button
                      key={pct}
                      onClick={() => setSizePercent(pct)}
                      className={`flex-1 rounded-lg border py-2 text-sm font-medium transition-colors ${
                        sizePercent === pct
                          ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-400"
                          : "border-[#262626] bg-[#141414] text-gray-400 hover:bg-[#1a1a1a] hover:text-white"
                      }`}
                    >
                      {pct}%
                    </button>
                  ))}
                </div>
              </div>

              {/* Slippage */}
              <div>
                <span className="mb-2 block text-sm text-gray-400">Max Slippage</span>
                <div className="flex gap-2">
                  {SLIPPAGE_OPTIONS.map(opt => (
                    <button
                      key={opt.label}
                      onClick={() => setSlippage(opt.value)}
                      className={`flex-1 rounded-lg border py-2 text-sm font-medium transition-colors ${
                        slippage === opt.value
                          ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-400"
                          : "border-[#262626] bg-[#141414] text-gray-400 hover:bg-[#1a1a1a] hover:text-white"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Info box — all values update in real-time */}
              <div className="space-y-2 rounded-xl border border-[#262626] bg-[#141414] p-4">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Mark Price</span>
                  <span className="font-mono text-white">{formatUsd(livePrice, livePrice < 1 ? 6 : livePrice < 100 ? 3 : 2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Close Value</span>
                  <span className="font-mono text-white">{formatUsd(closeValue)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Est. PnL</span>
                  <span className={`font-mono ${estimatedPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {estimatedPnl >= 0 ? "+" : ""}{formatUsd(estimatedPnl)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Est. Fee</span>
                  <span className="font-mono text-gray-300">{formatUsd(estimatedFee, 4)}</span>
                </div>
              </div>

              {/* Error from previous attempt */}
              {errorMsg && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
                  {errorMsg}
                </div>
              )}

              {/* Submit */}
              <button
                onClick={handleSubmit}
                className="w-full rounded-xl bg-gradient-to-r from-emerald-500/80 to-emerald-400/80 py-3.5 text-sm font-semibold text-black transition-opacity hover:opacity-90"
              >
                Market Close
              </button>
            </div>
          )}

          {/* ─── Signing Step ─── */}
          {step === "signing" && (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="h-10 w-10 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
              <div className="text-center">
                <p className="text-sm font-medium text-white">Signing transaction...</p>
                <p className="mt-1 text-xs text-gray-500">Confirm in your wallet</p>
              </div>
            </div>
          )}

          {/* ─── Verifying Step ─── */}
          {step === "verifying" && (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="h-10 w-10 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
              <div className="text-center">
                <p className="text-sm font-medium text-white">Verifying close...</p>
                <p className="mt-1 text-xs text-gray-500">Checking if position was closed on-chain</p>
              </div>
            </div>
          )}

          {/* ─── Error Step ─── */}
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
                onClick={() => { setStep("input"); setErrorMsg(errorMsg); }}
                className="w-full rounded-xl border border-[#262626] bg-[#141414] py-3 text-sm font-medium text-gray-300 transition-colors hover:bg-[#1a1a1a]"
              >
                Adjust Slippage &amp; Retry
              </button>
            </div>
          )}

          {/* ─── Confirmed Step ─── */}
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
