"use client";

import { useState, useCallback, useEffect } from "react";
import { useAuth } from "@/lib/auth/context";
import { trackInteraction } from "@/lib/util/track-interaction";
import type { LeaderboardEntry } from "./CompactLeaderboard";

type Step = "input" | "confirm" | "submitting" | "success" | "error";

interface FollowTraderDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  trader: LeaderboardEntry;
}

// ─── Formatters ─────────────────────────────────────────────────

function fmtAddr(addr: string): string {
  if (addr.startsWith("account:")) return "#" + addr.slice(8);
  if (addr.length < 10) return addr;
  return addr.slice(0, 4) + "…" + addr.slice(-4);
}

function fmtPnl(n: number): string {
  if (!isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  if (abs >= 1_000_000) return sign + "$" + (abs / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000) return sign + "$" + (abs / 1_000).toFixed(1) + "K";
  return sign + "$" + abs.toFixed(0);
}

function fmtVol(n: number): string {
  if (!isFinite(n) || n === 0) return "—";
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(0) + "K";
  return "$" + n.toFixed(0);
}

// ─── Component ──────────────────────────────────────────────────

export function FollowTraderDialog({ isOpen, onClose, onSuccess, trader }: FollowTraderDialogProps) {
  const { isAuthenticated } = useAuth();

  // Form state
  const [allocation, setAllocation] = useState("100");
  const [leverage, setLeverage] = useState(1);
  const [maxPosition, setMaxPosition] = useState("");
  const [maxTotal, setMaxTotal] = useState("");
  const [stopLoss, setStopLoss] = useState("");

  // Flow state
  const [step, setStep] = useState<Step>("input");
  const [error, setError] = useState<string | null>(null);
  const [sessionActive, setSessionActive] = useState<boolean | null>(null);

  // Check if copy trading session is active on open
  useEffect(() => {
    if (!isOpen || !isAuthenticated) return;
    setSessionActive(null);
    fetch("/api/copy/activate")
      .then((r) => r.json())
      .then((d) => setSessionActive(d.active ?? false))
      .catch(() => setSessionActive(false));
  }, [isOpen, isAuthenticated]);

  const handleClose = useCallback(() => {
    if (step === "submitting") return; // don't close while submitting
    setStep("input");
    setError(null);
    setAllocation("100");
    setLeverage(1);
    setMaxPosition("");
    setMaxTotal("");
    setStopLoss("");
    onClose();
  }, [step, onClose]);

  const handleAllocationChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val === "" || /^\d*\.?\d{0,2}$/.test(val)) {
      setAllocation(val);
    }
  }, []);

  const handleMaxPositionChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val === "" || /^\d*\.?\d{0,2}$/.test(val)) {
      setMaxPosition(val);
    }
  }, []);

  const handleMaxTotalChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val === "" || /^\d*\.?\d{0,2}$/.test(val)) {
      setMaxTotal(val);
    }
  }, []);

  const handleStopLossChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val === "" || /^\d*\.?\d{0,1}$/.test(val)) {
      const num = parseFloat(val);
      if (val === "" || (num >= 0 && num <= 100)) {
        setStopLoss(val);
      }
    }
  }, []);

  const validate = useCallback((): string | null => {
    const alloc = parseFloat(allocation);
    if (!allocation || isNaN(alloc) || alloc <= 0) {
      return "Allocation must be greater than $0";
    }
    if (alloc < 10) {
      return "Minimum allocation is $10";
    }
    if (alloc > 1_000_000) {
      return "Maximum allocation is $1,000,000";
    }
    if (stopLoss) {
      const sl = parseFloat(stopLoss);
      if (isNaN(sl) || sl <= 0 || sl > 100) {
        return "Stop loss must be between 1% and 100%";
      }
    }
    if (maxPosition) {
      const mp = parseFloat(maxPosition);
      if (isNaN(mp) || mp <= 0) {
        return "Max position must be greater than $0";
      }
    }
    if (maxTotal) {
      const mt = parseFloat(maxTotal);
      if (isNaN(mt) || mt <= 0) {
        return "Max total must be greater than $0";
      }
    }
    return null;
  }, [allocation, stopLoss, maxPosition, maxTotal]);

  const handleConfirm = useCallback(() => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setStep("confirm");
  }, [validate]);

  const handleSubmit = useCallback(async () => {
    setStep("submitting");
    setError(null);

    try {
      const body: Record<string, unknown> = {
        leaderAddr: trader.walletAddr,
        allocationUsdc: parseFloat(allocation),
        leverageMult: leverage,
      };
      if (maxPosition) body.maxPositionUsdc = parseFloat(maxPosition);
      if (maxTotal) body.maxTotalPositionUsdc = parseFloat(maxTotal);
      if (stopLoss) body.stopLossPct = parseFloat(stopLoss);

      const res = await fetch("/api/copy/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Failed to follow trader");
        setStep("error");
        return;
      }

      setStep("success");
      trackInteraction(trader.walletAddr, "follow");
      // Brief success state, then close and notify parent
      setTimeout(() => {
        handleClose();
        onSuccess();
      }, 800);
    } catch {
      setError("Network error — please try again");
      setStep("error");
    }
  }, [trader.walletAddr, allocation, leverage, maxPosition, maxTotal, stopLoss, handleClose, onSuccess]);

  if (!isOpen) return null;

  const allocNum = parseFloat(allocation) || 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border border-[#262626] bg-[#0f0f0f] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#262626] px-5 py-3">
          <h2 className="text-sm font-semibold text-white">Follow Trader</h2>
          <button
            onClick={handleClose}
            disabled={step === "submitting"}
            className="rounded-md p-1 text-gray-500 transition-colors hover:bg-[#1a1a1a] hover:text-white disabled:opacity-50"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4">
          {/* Not authenticated */}
          {!isAuthenticated && (
            <div className="py-4 text-center">
              <p className="text-xs text-gray-400">Connect your wallet and enable copy trading to follow traders.</p>
              <button onClick={handleClose} className="mt-3 rounded-lg bg-[#1a1a1a] px-5 py-1.5 text-xs text-white hover:bg-[#222]">
                Close
              </button>
            </div>
          )}

          {/* Session not active */}
          {isAuthenticated && sessionActive === false && (
            <div className="py-4 text-center">
              <p className="text-xs text-gray-400 mb-1">Copy trading is not activated.</p>
              <p className="text-[11px] text-gray-500">Enable it in the Copy Trading tab below the chart first, then try again.</p>
              <button onClick={handleClose} className="mt-3 rounded-lg bg-[#1a1a1a] px-5 py-1.5 text-xs text-white hover:bg-[#222]">
                Close
              </button>
            </div>
          )}

          {/* Loading session check */}
          {isAuthenticated && sessionActive === null && (
            <div className="flex h-16 items-center justify-center">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
            </div>
          )}

          {/* Authenticated + session active */}
          {isAuthenticated && sessionActive === true && (
            <>
              {/* Trader info card — single line */}
              <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-[#262626] bg-[#141414] px-3 py-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="text-xs font-mono font-semibold text-white">{fmtAddr(trader.walletAddr)}</span>
                  <span className={`text-[11px] font-semibold ${trader.totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {fmtPnl(trader.totalPnl)}
                  </span>
                  <span className={`text-[11px] ${trader.winRate >= 60 ? "text-emerald-400" : trader.winRate >= 50 ? "text-gray-300" : "text-red-400"}`}>
                    {trader.winRate.toFixed(0)}%
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-gray-500 whitespace-nowrap">
                  <span>{trader.totalTrades} trades</span>
                  <span>·</span>
                  <span>Vol {fmtVol(trader.totalVolume)}</span>
                </div>
              </div>

              {/* Step: Input */}
              {(step === "input" || step === "error") && (
                <>
                  {/* Allocation */}
                  <div className="mb-3">
                    <label className="mb-1 block text-[11px] font-medium text-gray-400">Allocation (USDC)</label>
                    <div className="flex gap-1.5">
                      <div className="relative flex-1">
                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-500">$</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={allocation}
                          onChange={handleAllocationChange}
                          placeholder="0.00"
                          className="w-full rounded-lg border border-[#262626] bg-[#141414] py-2 pl-6 pr-2.5 text-xs font-mono text-white placeholder-gray-600 outline-none transition-colors focus:border-emerald-500/50"
                        />
                      </div>
                      {[50, 100, 250, 500].map((v) => (
                        <button
                          key={v}
                          onClick={() => setAllocation(v.toString())}
                          className={`flex-1 rounded-lg border py-2 text-[11px] font-medium transition-colors ${
                            allocation === v.toString()
                              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                              : "border-[#262626] bg-[#141414] text-gray-400 hover:border-emerald-500/30 hover:text-white"
                          }`}
                        >
                          ${v}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Leverage */}
                  <div className="mb-3">
                    <label className="mb-1 block text-[11px] font-medium text-gray-400">Leverage</label>
                    <div className="flex gap-1.5">
                      {[1, 2, 3, 5].map((v) => (
                        <button
                          key={v}
                          onClick={() => setLeverage(v)}
                          className={`flex-1 rounded-lg border py-1.5 text-xs font-semibold transition-colors ${
                            leverage === v
                              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                              : "border-[#262626] bg-[#141414] text-gray-400 hover:border-emerald-500/30 hover:text-white"
                          }`}
                        >
                          {v}x
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Caps + Stop Loss — single 3-col row */}
                  <div className="mb-3 grid grid-cols-3 gap-2">
                    <div>
                      <label className="mb-1 block text-[10px] font-medium text-gray-400">Max / Market</label>
                      <div className="relative">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-gray-500">$</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={maxPosition}
                          onChange={handleMaxPositionChange}
                          placeholder="—"
                          className="w-full rounded-lg border border-[#262626] bg-[#141414] py-1.5 pl-5 pr-2 text-[11px] font-mono text-white placeholder-gray-600 outline-none transition-colors focus:border-emerald-500/50"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="mb-1 block text-[10px] font-medium text-gray-400">Max Total</label>
                      <div className="relative">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-gray-500">$</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={maxTotal}
                          onChange={handleMaxTotalChange}
                          placeholder="—"
                          className="w-full rounded-lg border border-[#262626] bg-[#141414] py-1.5 pl-5 pr-2 text-[11px] font-mono text-white placeholder-gray-600 outline-none transition-colors focus:border-emerald-500/50"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="mb-1 block text-[10px] font-medium text-gray-400">Stop Loss</label>
                      <div className="relative">
                        <input
                          type="text"
                          inputMode="decimal"
                          value={stopLoss}
                          onChange={handleStopLossChange}
                          placeholder="—"
                          className="w-full rounded-lg border border-[#262626] bg-[#141414] py-1.5 pl-2 pr-5 text-[11px] font-mono text-white placeholder-gray-600 outline-none transition-colors focus:border-emerald-500/50"
                        />
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-gray-500">%</span>
                      </div>
                    </div>
                  </div>

                  {/* Error */}
                  {error && (
                    <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-400">
                      {error}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-2">
                    <button
                      onClick={handleClose}
                      className="flex-1 rounded-lg border border-[#262626] bg-[#141414] py-2 text-xs font-medium text-gray-300 transition-colors hover:bg-[#1a1a1a]"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleConfirm}
                      className="flex-1 rounded-lg border border-emerald-500/30 bg-emerald-500/15 py-2 text-xs font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/25"
                    >
                      Review
                    </button>
                  </div>
                </>
              )}

              {/* Step: Confirm */}
              {step === "confirm" && (
                <>
                  <div className="mb-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                    <p className="mb-2 text-[11px] font-medium text-emerald-400">Confirm subscription</p>
                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px]">
                        <span className="text-gray-400">Allocation</span>
                        <span className="font-mono text-white">${allocNum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · {leverage}x</span>
                      </div>
                      {(maxPosition || maxTotal) && (
                        <div className="flex justify-between text-[11px]">
                          <span className="text-gray-400">Caps</span>
                          <span className="font-mono text-white">
                            {maxPosition ? `$${parseFloat(maxPosition).toLocaleString()}/mkt` : "—"}
                            {maxPosition && maxTotal ? " · " : ""}
                            {maxTotal ? `$${parseFloat(maxTotal).toLocaleString()} total` : ""}
                          </span>
                        </div>
                      )}
                      {stopLoss && (
                        <div className="flex justify-between text-[11px]">
                          <span className="text-gray-400">Stop Loss</span>
                          <span className="font-mono text-white">{stopLoss}%</span>
                        </div>
                      )}
                    </div>
                    <p className="mt-2 text-[10px] text-gray-500 leading-snug">
                      Engine mirrors this trader proportionally. Pause or unfollow anytime.
                    </p>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => setStep("input")}
                      className="flex-1 rounded-lg border border-[#262626] bg-[#141414] py-2 text-xs font-medium text-gray-300 transition-colors hover:bg-[#1a1a1a]"
                    >
                      Back
                    </button>
                    <button
                      onClick={handleSubmit}
                      className="flex-1 rounded-lg border border-emerald-500/30 bg-emerald-500/15 py-2 text-xs font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/25"
                    >
                      Confirm
                    </button>
                  </div>
                </>
              )}

              {/* Step: Submitting */}
              {step === "submitting" && (
                <div className="flex flex-col items-center py-6">
                  <div className="mb-3 h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
                  <div className="text-xs text-gray-300">Creating subscription...</div>
                </div>
              )}

              {/* Step: Success */}
              {step === "success" && (
                <div className="flex flex-col items-center py-6">
                  <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/20">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <div className="text-xs font-medium text-emerald-400">Now following {fmtAddr(trader.walletAddr)}</div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
