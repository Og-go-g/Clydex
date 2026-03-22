"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/lib/auth/context";
import { useCollateral } from "@/hooks/useCollateral";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { useVerification } from "@/components/collateral/VerificationProvider";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;

type Tab = "deposit" | "withdraw";
type Step = "input" | "confirm" | "signing" | "error";

interface CollateralInfo {
  exists: boolean;
  collateral: number;
  availableMargin: number;
  hasPositions: boolean;
  positionCount: number;
  isBankrupt: boolean;
  message?: string;
}

interface ValidationResult {
  approved: boolean;
  action: string;
  amount: number;
  currentBalance?: number;
  warnings: string[];
  message: string;
  requiresConfirmation: boolean;
}

interface DepositWithdrawModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: Tab;
  onSuccess?: () => void;
}

function formatUsd(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function DepositWithdrawModal({
  isOpen,
  onClose,
  initialTab = "deposit",
  onSuccess,
}: DepositWithdrawModalProps) {
  const { isAuthenticated } = useAuth();
  const { publicKey } = useSolanaWallet();
  const { execute, reset: resetCollateral, executing, error: collateralError, success: collateralSuccess } = useCollateral();
  const startVerification = useVerification();

  const [tab, setTab] = useState<Tab>(initialTab);
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<Step>("input");
  const [info, setInfo] = useState<CollateralInfo | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [walletUsdcBalance, setWalletUsdcBalance] = useState<number | null>(null);
  const [confirmedAmount, setConfirmedAmount] = useState<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch collateral info from server
  const fetchCollateralInfo = useCallback(async (signal?: AbortSignal) => {
    if (!isAuthenticated) return;
    try {
      const res = await fetch("/api/collateral", { signal });
      if (res.ok) {
        setInfo(await res.json());
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Non-critical
    }
  }, [isAuthenticated]);

  // Fetch wallet USDC balance via RPC proxy
  const fetchWalletUsdc = useCallback(async (signal?: AbortSignal) => {
    if (!publicKey) {
      setWalletUsdcBalance(null);
      return;
    }
    try {
      const res = await fetch("/api/solana-rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenAccountsByOwner",
          params: [
            publicKey.toBase58(),
            { mint: USDC_MINT },
            { encoding: "jsonParsed" },
          ],
        }),
        signal,
      });

      if (!res.ok) return;

      const data = await res.json();
      const accounts = data?.result?.value;
      if (!Array.isArray(accounts) || accounts.length === 0) {
        setWalletUsdcBalance(0);
        return;
      }

      let total = 0;
      for (const acc of accounts) {
        const amt = acc?.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (amt) {
          const balance = Number(amt) / 10 ** USDC_DECIMALS;
          if (!isFinite(balance)) continue;
          total += balance;
        }
      }
      setWalletUsdcBalance(total);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Non-critical
    }
  }, [publicKey]);

  // Background verification: poll collateral balance until it changes, then show toast
  // Track collateral hook state changes
  useEffect(() => {
    if (step !== "signing") return;

    if (collateralError) {
      setErrorMsg(collateralError);
      setStep("error");
    }
  }, [collateralError, step]);

  // Fetch both balances when modal opens; abort in-flight requests on close
  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    fetchCollateralInfo(controller.signal);
    fetchWalletUsdc(controller.signal);
    return () => controller.abort();
  }, [isOpen, fetchCollateralInfo, fetchWalletUsdc]);

  // Reset state on tab change or modal open
  useEffect(() => {
    setAmount("");
    setStep("input");
    setValidation(null);
    setErrorMsg(null);
    resetCollateral();
  }, [tab, isOpen, resetCollateral]);

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen && step === "input") {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen, step]);

  const parsedAmount = parseFloat(amount);
  const isValidAmount = !isNaN(parsedAmount) && parsedAmount > 0 && isFinite(parsedAmount);

  const handleAmountChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val === "" || /^\d*\.?\d{0,6}$/.test(val)) {
      setAmount(val);
    }
  }, []);

  const setPercentage = useCallback(
    (pct: number) => {
      if (!info || !info.exists) return;
      const max = tab === "withdraw" ? info.collateral : 0;
      if (max > 0) {
        setAmount((max * pct / 100).toFixed(2));
      }
    },
    [info, tab]
  );

  // Step 1: Validate with server
  const handleContinue = useCallback(async () => {
    if (!isValidAmount) return;

    setLoading(true);
    setErrorMsg(null);

    try {
      const res = await fetch("/api/collateral", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: tab, amount: parsedAmount }),
      });

      const data = await res.json();

      if (!res.ok) {
        setErrorMsg(data.error || "Validation failed");
        setLoading(false);
        return;
      }

      setValidation(data);

      if (data.approved) {
        setConfirmedAmount(parsedAmount);
        setStep("confirm");
      } else {
        setErrorMsg(data.message);
      }
    } catch {
      setErrorMsg("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [isValidAmount, parsedAmount, tab]);

  // Step 2: Execute via useCollateral hook (wallet signing)
  const handleExecute = useCallback(async () => {
    setStep("signing");
    setErrorMsg(null);

    const currentTab = tab;
    const currentAmount = confirmedAmount;

    const result = await execute(currentTab, currentAmount);

    if (result.ok) {
      // Tx sent — start background verification, show success step
      // Don't auto-close: let user see the status and close manually
      // This prevents confusion when user thinks tx failed because modal disappeared
      startVerification(currentTab, currentAmount, result.balanceBefore, () => {
        onSuccess?.();
        // Auto-close only AFTER verification succeeds
        onClose();
      });
    } else {
      // Hook will set error via state → useEffect handles transition to error step
      // Fallback if hook didn't set error
      setTimeout(() => {
        setStep((current) => {
          if (current === "signing") {
            setErrorMsg("Transaction could not be completed. Please check your wallet.");
            return "error";
          }
          return current;
        });
      }, 500);
    }
  }, [tab, confirmedAmount, execute, onClose, startVerification, onSuccess]);

  // Close handler — always closeable
  const handleClose = useCallback(() => {
    if (executing) {
      resetCollateral();
    }
    setStep("input");
    setErrorMsg(null);
    onClose();
  }, [executing, resetCollateral, onClose]);

  if (!isOpen) return null;

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
          <h2 className="text-lg font-semibold text-white">Manage Collateral</h2>
          <button
            onClick={handleClose}
            className="rounded-lg p-1 text-gray-500 transition-colors hover:bg-[#1a1a1a] hover:text-white"
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[#262626]">
          {(["deposit", "withdraw"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              disabled={step === "signing"}
              className={`flex-1 py-3 text-sm font-medium transition-colors ${
                tab === t
                  ? "border-b-2 border-blue-500 text-white"
                  : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {t === "deposit" ? "Deposit" : "Withdraw"}
            </button>
          ))}
        </div>

        <div className="p-6">
          {/* Account info */}
          {info?.exists && (
            <div className="mb-4 rounded-xl border border-[#262626] bg-[#141414] p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">Collateral Balance</span>
                <span className="font-mono font-semibold text-white">
                  {formatUsd(info.collateral)}
                </span>
              </div>
              {info.hasPositions && (
                <div className="mt-1 flex items-center justify-between text-sm">
                  <span className="text-gray-500">Available Margin</span>
                  <span className="font-mono text-gray-300">
                    {formatUsd(info.availableMargin)}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Input step */}
          {step === "input" && (
            <>
              <div className="mb-4">
                <label className="mb-1.5 block text-sm text-gray-400">
                  Amount (USDC)
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                  <input
                    ref={inputRef}
                    type="text"
                    inputMode="decimal"
                    value={amount}
                    onChange={handleAmountChange}
                    placeholder="0.00"
                    className="w-full rounded-xl border border-[#262626] bg-[#141414] py-3 pl-7 pr-16 text-lg font-mono text-white placeholder-gray-600 outline-none transition-colors focus:border-blue-500/50"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-500">
                    USDC
                  </span>
                </div>
              </div>

              {/* Wallet balance + Max button for deposit */}
              {tab === "deposit" && walletUsdcBalance !== null && (
                <div className="mb-4 flex items-center justify-between">
                  <span className="text-xs text-gray-500">
                    Wallet: <span className="font-mono text-gray-400">{formatUsd(walletUsdcBalance)}</span>
                  </span>
                  <button
                    onClick={() => {
                      if (walletUsdcBalance > 0) {
                        setAmount(walletUsdcBalance.toFixed(6).replace(/0+$/, "").replace(/\.$/, ""));
                      }
                    }}
                    disabled={walletUsdcBalance <= 0}
                    className="rounded-lg border border-[#262626] bg-[#141414] px-3 py-1 text-xs font-medium text-blue-400 transition-colors hover:border-blue-500/30 hover:text-blue-300 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Max
                  </button>
                </div>
              )}

              {/* Quick percentage buttons for withdraw */}
              {tab === "withdraw" && info?.exists && info.collateral > 0 && (
                <div className="mb-4 flex gap-2">
                  {[25, 50, 75, 100].map((pct) => (
                    <button
                      key={pct}
                      onClick={() => setPercentage(pct)}
                      className="flex-1 rounded-lg border border-[#262626] bg-[#141414] py-1.5 text-xs text-gray-400 transition-colors hover:border-blue-500/30 hover:text-white"
                    >
                      {pct}%
                    </button>
                  ))}
                </div>
              )}

              {errorMsg && (
                <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
                  {errorMsg}
                </div>
              )}

              <button
                onClick={handleContinue}
                disabled={!isValidAmount || loading}
                className="w-full rounded-xl bg-blue-500 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? "Checking..." : "Continue"}
              </button>
            </>
          )}

          {/* Confirm step */}
          {step === "confirm" && validation && (
            <>
              <div className="mb-4 rounded-xl border border-[#262626] bg-[#141414] p-4">
                <div className="mb-3 text-center">
                  <div className="text-2xl font-bold font-mono text-white">
                    {formatUsd(validation.amount)}
                  </div>
                  <div className="mt-1 text-sm text-gray-400">
                    {tab === "deposit" ? "Deposit to" : "Withdraw from"} 01 Exchange
                  </div>
                </div>
              </div>

              {/* Warnings */}
              {validation.warnings.length > 0 && (
                <div className="mb-4 space-y-2">
                  {validation.warnings.map((w, i) => (
                    <div
                      key={i}
                      className={`rounded-xl border p-3 text-sm ${
                        w.includes("CRITICAL")
                          ? "border-red-500/30 bg-red-500/10 text-red-400"
                          : "border-yellow-500/30 bg-yellow-500/10 text-yellow-400"
                      }`}
                    >
                      {w}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => setStep("input")}
                  className="flex-1 rounded-xl border border-[#262626] bg-[#141414] py-3 text-sm font-medium text-gray-300 transition-colors hover:bg-[#1a1a1a]"
                >
                  Back
                </button>
                <button
                  onClick={handleExecute}
                  disabled={executing}
                  className={`flex-1 rounded-xl py-3 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    tab === "withdraw"
                      ? "bg-orange-500 hover:bg-orange-600"
                      : "bg-blue-500 hover:bg-blue-600"
                  }`}
                >
                  {tab === "deposit" ? "Confirm Deposit" : "Confirm Withdrawal"}
                </button>
              </div>
            </>
          )}

          {/* Signing step — wallet interaction in progress */}
          {step === "signing" && (
            <div className="flex flex-col items-center py-8">
              <div className="mb-4 h-10 w-10 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
              <div className="text-sm text-gray-300">
                {tab === "deposit"
                  ? "Depositing USDC..."
                  : "Withdrawing USDC..."}
              </div>
              <div className="mt-2 text-xs text-gray-500">
                Please confirm the transaction in your wallet.
              </div>
              <button
                onClick={handleClose}
                className="mt-4 text-xs text-gray-600 underline transition-colors hover:text-gray-400"
              >
                Cancel and close
              </button>
            </div>
          )}

          {/* Error step */}
          {step === "error" && (
            <div className="flex flex-col items-center py-8">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/20">
                <svg viewBox="0 0 24 24" className="h-6 w-6 text-red-400" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div className="text-sm font-medium text-white">Transaction Failed</div>
              <div className="mt-1 max-w-xs text-center text-xs text-gray-500">
                {errorMsg || "Something went wrong. Please try again."}
              </div>
              <button
                onClick={() => {
                  setStep("input");
                  setErrorMsg(null);
                  resetCollateral();
                }}
                className="mt-6 rounded-xl bg-[#1a1a1a] px-8 py-2.5 text-sm text-white transition-colors hover:bg-[#262626]"
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
