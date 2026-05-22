"use client";

import { useState, useCallback, useEffect } from "react";
import { useAuth } from "@/lib/auth/context";
import { trackInteraction } from "@/lib/util/track-interaction";
import { apiFetch } from "@/lib/apiFetch";
import type { LeaderboardEntry } from "./CompactLeaderboard";

type Step = "input" | "confirm" | "submitting" | "success" | "error";

interface FollowTraderDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  trader: LeaderboardEntry;
}

// ─── InfoHint — small (?) icon with tooltip ──────────────────────
//
// Hover on desktop, tap on mobile. Tooltip positioned above by default;
// pass align="end" for right-edge fields (Stop Loss in 3-col row) so the
// popover doesn't clip past the dialog edge.

function InfoHint({
  children,
  align = "center",
}: {
  children: React.ReactNode;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);
  const alignClass =
    align === "start"
      ? "left-0"
      : align === "end"
        ? "right-0"
        : "left-1/2 -translate-x-1/2";

  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onBlur={() => setOpen(false)}
        className="ml-1 inline-flex h-3 w-3 items-center justify-center rounded-full border border-gray-600 text-[8px] font-medium text-gray-500 transition-colors hover:border-gray-400 hover:text-gray-300"
        aria-label="More info"
      >
        ?
      </button>
      {open && (
        <span
          role="tooltip"
          className={`pointer-events-none absolute bottom-full z-20 mb-1.5 w-48 rounded-md border border-[#404040] bg-[#262626] px-2.5 py-1.5 text-[10px] leading-snug text-gray-200 shadow-2xl ring-1 ring-black/40 ${alignClass}`}
        >
          {children}
        </span>
      )}
    </span>
  );
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

  // "One leader per market" overlap — markets the candidate leader
  // currently trades that are already owned by another leader for this
  // user. Engine will skip these at trade-time; we surface here so the
  // user understands what they're getting.
  const [overlap, setOverlap] = useState<Array<{ marketId: number; symbol: string; owningLeaderAddr: string }> | null>(null);

  // Check if copy trading session is active on open.
  //
  // 503 from /api/copy/activate (DB transient) is NOT treated as
  // "inactive" — that would prompt the user to re-enable and
  // overwrite their real 7-day session. We re-poll once, and if
  // still 503 we leave sessionActive as null (the UI shows a
  // loading state instead of the enable prompt).
  useEffect(() => {
    if (!isOpen || !isAuthenticated) return;
    setSessionActive(null);
    let cancelled = false;
    const tryFetch = (attempt: number) => {
      fetch("/api/copy/activate", { cache: "no-store" })
        .then(async (r) => {
          if (cancelled) return;
          if (r.status === 503 && attempt < 2) {
            setTimeout(() => tryFetch(attempt + 1), 2_000);
            return;
          }
          if (!r.ok) {
            // Treat 4xx as definitive: user is unauthenticated /
            // session was DELETEd. Surface "inactive" so the UI can
            // prompt the user.
            setSessionActive(false);
            return;
          }
          const d = await r.json();
          setSessionActive(d.active ?? false);
        })
        .catch(() => {
          if (cancelled) return;
          if (attempt < 2) {
            setTimeout(() => tryFetch(attempt + 1), 2_000);
            return;
          }
          // Final retry failed — assume offline. Leave as null so
          // the dialog shows a "couldn't check" hint instead of
          // mistakenly prompting to enable.
          setSessionActive(null);
        });
    };
    tryFetch(0);
    return () => { cancelled = true; };
  }, [isOpen, isAuthenticated]);

  // Fetch market-overlap warning. Fire-and-forget; failure leaves
  // `overlap=null` and the warning block isn't rendered.
  useEffect(() => {
    if (!isOpen || !isAuthenticated) return;
    setOverlap(null);
    const ctrl = new AbortController();
    fetch(`/api/copy/markets-overlap?leaderAddr=${encodeURIComponent(trader.walletAddr)}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && Array.isArray(d.overlap)) setOverlap(d.overlap);
      })
      .catch(() => { /* abort or network — silent */ });
    return () => ctrl.abort();
  }, [isOpen, isAuthenticated, trader.walletAddr]);

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
    // Beta cap mirrors MAX_BETA_ALLOCATION_USDC on the server. The
    // server-side validator is the authoritative gate; this check just
    // prevents a wasted round-trip and surfaces the cap to the user.
    if (alloc > 1000) {
      return "Closed beta limit: max $1,000 allocation per subscription";
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

      const res = await apiFetch("/api/copy/subscribe", {
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

              {/* Market overlap warning — "one leader per market" rule */}
              {overlap && overlap.length > 0 && (step === "input" || step === "error") && (
                <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[10px] leading-snug text-amber-200">
                  <div className="flex items-center gap-1 font-medium">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    {overlap.length === 1 ? "1 market already copied" : `${overlap.length} markets already copied`}
                  </div>
                  <div className="mt-0.5 text-amber-200/70">
                    {overlap.map((o) => o.symbol).join(", ")} won&apos;t be mirrored from this leader (one leader per market).
                  </div>
                </div>
              )}

              {/* Step: Input */}
              {(step === "input" || step === "error") && (
                <>
                  {/* Allocation */}
                  <div className="mb-3">
                    <label className="mb-1 flex items-center text-[11px] font-medium text-gray-400">
                      Allocation (USDC)
                      <InfoHint align="start">
                        Sizing reference, not a deposit. Engine mirrors the leader at ratio
                        <strong className="text-gray-200"> allocation / leader equity</strong>.
                        Real margin comes from your USDC balance.
                      </InfoHint>
                    </label>
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
                      {/* Beta-allocation quick-picks. Top value matches the
                          server-side beta cap of $1,000 — bump in sync if
                          MAX_BETA_ALLOCATION_USDC is raised. */}
                      {[100, 250, 500, 1000].map((v) => (
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
                    <p className="mt-1.5 text-[10px] text-gray-500">
                      Closed beta: max <span className="text-gray-300 font-medium">$1,000</span> per subscription.
                    </p>
                  </div>

                  {/* Leverage */}
                  <div className="mb-3">
                    <label className="mb-1 flex items-center text-[11px] font-medium text-gray-400">
                      Leverage
                      <InfoHint align="start">
                        Multiplier on the mirror ratio. <strong className="text-gray-200">2×</strong>
                        {" "}doubles your proportional exposure relative to the leader.
                        At <strong className="text-amber-300">3×</strong> a 33% adverse move liquidates.
                      </InfoHint>
                    </label>
                    {/* Beta-leverage quick-picks. 3× matches MAX_BETA_LEVERAGE_MULT
                        server default; raising the cap should also raise the
                        top button here. Dropped 5× during closed-beta to
                        avoid auto-sign liquidation on overnight volatility. */}
                    <div className="flex gap-1.5">
                      {[1, 2, 3].map((v) => (
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
                    {leverage >= 3 && (
                      <p className="mt-1.5 text-[10px] text-amber-300/80">
                        At 3× a 33% adverse move liquidates your position. Crypto can move this much overnight.
                      </p>
                    )}
                  </div>

                  {/* Caps + Stop Loss — single 3-col row */}
                  <div className="mb-3 grid grid-cols-3 gap-2">
                    <div>
                      <label className="mb-1 flex items-center text-[10px] font-medium text-gray-400">
                        Max / Market
                        <InfoHint align="start">
                          Hard cap on a single position in one market. Protects against the
                          leader going all-in on one asset.
                        </InfoHint>
                      </label>
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
                      <label className="mb-1 flex items-center text-[10px] font-medium text-gray-400">
                        Max Total
                        <InfoHint align="center">
                          Hard cap on combined notional across all your copy positions.
                          Protects against the leader trading many markets at once or losing
                          equity (which auto-grows your ratio).
                        </InfoHint>
                      </label>
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
                      <label className="mb-1 flex items-center text-[10px] font-medium text-gray-400">
                        Stop Loss
                        <InfoHint align="end">
                          Sets a stop-loss trigger on the exchange for each copied position.
                          Auto-closes if it drops by this % from entry.
                        </InfoHint>
                      </label>
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
