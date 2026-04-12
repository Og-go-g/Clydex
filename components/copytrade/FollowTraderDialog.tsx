"use client";

import { useState, useCallback, useEffect } from "react";
import { useAuth } from "@/lib/auth/context";
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
    return null;
  }, [allocation, stopLoss, maxPosition]);

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
      // Brief success state, then close and notify parent
      setTimeout(() => {
        handleClose();
        onSuccess();
      }, 800);
    } catch {
      setError("Network error — please try again");
      setStep("error");
    }
  }, [trader.walletAddr, allocation, leverage, maxPosition, stopLoss, handleClose, onSuccess]);

  if (!isOpen) return null;

  const allocNum = parseFloat(allocation) || 0;

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
          <h2 className="text-lg font-semibold text-white">Follow Trader</h2>
          <button
            onClick={handleClose}
            disabled={step === "submitting"}
            className="rounded-lg p-1 text-gray-500 transition-colors hover:bg-[#1a1a1a] hover:text-white disabled:opacity-50"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5">
          {/* Not authenticated */}
          {!isAuthenticated && (
            <div className="py-6 text-center">
              <p className="text-sm text-gray-400">Connect your wallet and enable copy trading to follow traders.</p>
              <button onClick={handleClose} className="mt-4 rounded-xl bg-[#1a1a1a] px-6 py-2 text-sm text-white hover:bg-[#222]">
                Close
              </button>
            </div>
          )}

          {/* Session not active */}
          {isAuthenticated && sessionActive === false && (
            <div className="py-6 text-center">
              <p className="text-sm text-gray-400 mb-2">Copy trading is not activated.</p>
              <p className="text-xs text-gray-500">Enable it in the Copy Trading tab below the chart first, then try again.</p>
              <button onClick={handleClose} className="mt-4 rounded-xl bg-[#1a1a1a] px-6 py-2 text-sm text-white hover:bg-[#222]">
                Close
              </button>
            </div>
          )}

          {/* Loading session check */}
          {isAuthenticated && sessionActive === null && (
            <div className="flex h-20 items-center justify-center">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
            </div>
          )}

          {/* Authenticated + session active */}
          {isAuthenticated && sessionActive === true && (
            <>
              {/* Trader info card */}
              <div className="mb-5 rounded-xl border border-[#262626] bg-[#141414] p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-mono font-semibold text-white">{fmtAddr(trader.walletAddr)}</span>
                  <span className="text-[10px] text-gray-500">{trader.totalTrades} trades</span>
                </div>
                <div className="mt-2 flex items-center gap-4 text-xs">
                  <span className={trader.totalPnl >= 0 ? "text-emerald-400 font-semibold" : "text-red-400 font-semibold"}>
                    {fmtPnl(trader.totalPnl)}
                  </span>
                  <span className={trader.winRate >= 60 ? "text-emerald-400" : trader.winRate >= 50 ? "text-gray-300" : "text-red-400"}>
                    {trader.winRate.toFixed(0)}% win
                  </span>
                  <span className="text-gray-500">Vol {fmtVol(trader.totalVolume)}</span>
                </div>
              </div>

              {/* Step: Input */}
              {(step === "input" || step === "error") && (
                <>
                  {/* Allocation */}
                  <div className="mb-4">
                    <label className="mb-1.5 block text-xs font-medium text-gray-400">Allocation (USDC)</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500">$</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={allocation}
                        onChange={handleAllocationChange}
                        placeholder="0.00"
                        className="w-full rounded-xl border border-[#262626] bg-[#141414] py-3 pl-7 pr-4 text-sm font-mono text-white placeholder-gray-600 outline-none transition-colors focus:border-emerald-500/50"
                      />
                    </div>
                    <div className="mt-2 flex gap-2">
                      {[50, 100, 250, 500].map((v) => (
                        <button
                          key={v}
                          onClick={() => setAllocation(v.toString())}
                          className={`flex-1 rounded-lg border py-1.5 text-xs font-medium transition-colors ${
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
                  <div className="mb-4">
                    <label className="mb-1.5 block text-xs font-medium text-gray-400">Leverage Multiplier</label>
                    <div className="flex gap-2">
                      {[1, 2, 3, 5].map((v) => (
                        <button
                          key={v}
                          onClick={() => setLeverage(v)}
                          className={`flex-1 rounded-lg border py-2.5 text-sm font-semibold transition-colors ${
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

                  {/* Max position & stop loss — compact row */}
                  <div className="mb-5 grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1.5 flex items-center gap-1 text-xs font-medium text-gray-400">
                        Max Position
                        <span className="text-[10px] text-gray-600">optional</span>
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-gray-500">$</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={maxPosition}
                          onChange={handleMaxPositionChange}
                          placeholder="No limit"
                          className="w-full rounded-xl border border-[#262626] bg-[#141414] py-2.5 pl-6 pr-3 text-xs font-mono text-white placeholder-gray-600 outline-none transition-colors focus:border-emerald-500/50"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="mb-1.5 flex items-center gap-1 text-xs font-medium text-gray-400">
                        Stop Loss
                        <span className="text-[10px] text-gray-600">optional</span>
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          inputMode="decimal"
                          value={stopLoss}
                          onChange={handleStopLossChange}
                          placeholder="None"
                          className="w-full rounded-xl border border-[#262626] bg-[#141414] py-2.5 pl-3 pr-6 text-xs font-mono text-white placeholder-gray-600 outline-none transition-colors focus:border-emerald-500/50"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-500">%</span>
                      </div>
                    </div>
                  </div>

                  {/* Summary box */}
                  <div className="mb-5 space-y-2 rounded-xl border border-[#262626] bg-[#141414] p-4">
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-400">Allocation</span>
                      <span className="font-mono text-white">${allocNum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-400">Leverage</span>
                      <span className="font-mono text-white">{leverage}x</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-400">Max Position</span>
                      <span className="font-mono text-white">{maxPosition ? `$${parseFloat(maxPosition).toLocaleString()}` : "Unlimited"}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-400">Stop Loss</span>
                      <span className="font-mono text-white">{stopLoss ? `${stopLoss}%` : "None"}</span>
                    </div>
                  </div>

                  {/* Error */}
                  {error && (
                    <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
                      {error}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-3">
                    <button
                      onClick={handleClose}
                      className="flex-1 rounded-xl border border-[#262626] bg-[#141414] py-3 text-sm font-medium text-gray-300 transition-colors hover:bg-[#1a1a1a]"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleConfirm}
                      className="flex-1 rounded-xl border border-emerald-500/30 bg-emerald-500/15 py-3 text-sm font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/25"
                    >
                      Follow Trader
                    </button>
                  </div>
                </>
              )}

              {/* Step: Confirm */}
              {step === "confirm" && (
                <>
                  <div className="mb-5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                    <p className="mb-3 text-xs font-medium text-emerald-400">Confirm subscription</p>
                    <div className="space-y-2">
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-400">Trader</span>
                        <span className="font-mono text-white">{fmtAddr(trader.walletAddr)}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-400">Allocation</span>
                        <span className="font-mono text-white">${allocNum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-400">Leverage</span>
                        <span className="font-mono text-white">{leverage}x</span>
                      </div>
                      {maxPosition && (
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-400">Max Position</span>
                          <span className="font-mono text-white">${parseFloat(maxPosition).toLocaleString()}</span>
                        </div>
                      )}
                      {stopLoss && (
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-400">Stop Loss</span>
                          <span className="font-mono text-white">{stopLoss}%</span>
                        </div>
                      )}
                    </div>
                    <p className="mt-3 text-[10px] text-gray-500">
                      The copy engine will mirror this trader's positions proportionally to your allocation.
                      You can pause or unfollow at any time.
                    </p>
                  </div>

                  <div className="flex gap-3">
                    <button
                      onClick={() => setStep("input")}
                      className="flex-1 rounded-xl border border-[#262626] bg-[#141414] py-3 text-sm font-medium text-gray-300 transition-colors hover:bg-[#1a1a1a]"
                    >
                      Back
                    </button>
                    <button
                      onClick={handleSubmit}
                      className="flex-1 rounded-xl border border-emerald-500/30 bg-emerald-500/15 py-3 text-sm font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/25"
                    >
                      Confirm
                    </button>
                  </div>
                </>
              )}

              {/* Step: Submitting */}
              {step === "submitting" && (
                <div className="flex flex-col items-center py-8">
                  <div className="mb-4 h-10 w-10 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
                  <div className="text-sm text-gray-300">Creating subscription...</div>
                </div>
              )}

              {/* Step: Success */}
              {step === "success" && (
                <div className="flex flex-col items-center py-8">
                  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/20">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <div className="text-sm font-medium text-emerald-400">Now following {fmtAddr(trader.walletAddr)}</div>
                  <div className="mt-1 text-xs text-gray-500">Subscription active</div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
