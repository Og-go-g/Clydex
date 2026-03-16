"use client";

import { useState, useEffect, useCallback } from "react";
import { useWallet } from "@/lib/wallet/context";
import { useAuth } from "@/lib/auth/context";
import { DepositWithdrawModal } from "@/components/collateral/DepositWithdrawModal";

interface PositionData {
  marketId: number;
  symbol: string;
  side: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
}

interface AccountData {
  exists: boolean;
  accountId?: number;
  account?: {
    positions: Array<{
      marketId: number;
      perp?: {
        baseSize: number;
        price: number;
        isLong: boolean;
        sizePricePnl: number;
        fundingPaymentPnl: number;
      };
    }>;
    balances: Array<{
      tokenId: number;
      token: string;
      amount: number;
    }>;
    margins: {
      omf: number;
      mf: number;
      imf: number;
      cmf: number;
      mmf: number;
      pon: number;
      pn: number;
      bankruptcy: boolean;
    };
    orders: Array<{
      orderId: number;
      marketId: number;
      side: string;
      size: number;
      price: number;
    }>;
  };
  orders?: Array<{
    orderId: number;
    marketId: number;
    side: string;
    size: number;
    price: number;
  }>;
  triggers?: Array<{
    marketId: number;
    triggerPrice: number;
    kind: string;
  }>;
  message?: string;
}

const N1_MARKET_SYMBOLS: Record<number, string> = {
  0: "BTC-PERP", 1: "ETH-PERP", 2: "SOL-PERP", 3: "HYPE-PERP",
  4: "SUI-PERP", 5: "XRP-PERP", 6: "EIGEN-PERP", 7: "VIRTUAL-PERP",
  8: "ENA-PERP", 9: "NEAR-PERP", 10: "ARB-PERP", 11: "ASTER-PERP",
  12: "PAXG-PERP", 13: "BERA-PERP", 14: "XPL-PERP", 15: "S-PERP",
  16: "JUP-PERP", 17: "APT-PERP", 18: "AAVE-PERP", 19: "ZEC-PERP",
  20: "LIT-PERP", 21: "WLFI-PERP", 22: "IP-PERP", 23: "KAITO-PERP",
};

function formatUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (Math.abs(n) >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  return "$" + n.toFixed(2);
}

export default function PortfolioPage() {
  const { address } = useWallet();
  const { isAuthenticated } = useAuth();
  const [data, setData] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collateralModalOpen, setCollateralModalOpen] = useState(false);

  const fetchAccount = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/account");
      if (res.status === 401) {
        setError("Please sign in to view your portfolio.");
        return;
      }
      if (!res.ok) throw new Error("Failed to fetch");
      setData(await res.json());
    } catch {
      setError("Failed to load account data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    fetchAccount();
  }, [isAuthenticated, fetchAccount]);

  if (!address) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-foreground">Connect Wallet</h2>
          <p className="mt-2 text-sm text-muted">Connect your Solana wallet to view your portfolio.</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-foreground">Sign In</h2>
          <p className="mt-2 text-sm text-muted">Sign the message in your wallet to view your portfolio.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-red-400">
          {error}
        </div>
      </div>
    );
  }

  if (!data?.exists) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-foreground">No Account</h2>
          <p className="mt-2 text-sm text-muted">{data?.message || "Deposit USDC to 01 Exchange to create your account."}</p>
        </div>
      </div>
    );
  }

  const account = data.account;
  const positions = account?.positions?.filter(p => p.perp && p.perp.baseSize !== 0) ?? [];
  const balances = account?.balances ?? [];
  const margins = account?.margins;
  const orders = data.orders ?? account?.orders ?? [];
  const triggers = data.triggers ?? [];

  const usdcBalance = balances.find(b => b.tokenId === 0)?.amount ?? 0;
  const totalPnl = positions.reduce(
    (sum, p) => sum + (p.perp?.sizePricePnl ?? 0) + (p.perp?.fundingPaymentPnl ?? 0),
    0
  );

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">Portfolio</h1>
          <button
            onClick={() => setCollateralModalOpen(true)}
            className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600"
          >
            Deposit / Withdraw
          </button>
        </div>

        <DepositWithdrawModal
          isOpen={collateralModalOpen}
          onClose={() => setCollateralModalOpen(false)}
          onSuccess={fetchAccount}
        />

        {/* Account Summary */}
        <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="text-xs text-muted">Collateral</div>
            <div className="mt-1 text-lg font-semibold text-foreground">{formatUsd(usdcBalance)}</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="text-xs text-muted">Unrealized PnL</div>
            <div className={`mt-1 text-lg font-semibold ${totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
              {totalPnl >= 0 ? "+" : ""}{formatUsd(totalPnl)}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="text-xs text-muted">Open Positions</div>
            <div className="mt-1 text-lg font-semibold text-foreground">{positions.length}</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="text-xs text-muted">Margin Health</div>
            <div className={`mt-1 text-lg font-semibold ${
              margins?.bankruptcy ? "text-red-400" : "text-green-400"
            }`}>
              {margins?.bankruptcy ? "DANGER" : "Healthy"}
            </div>
          </div>
        </div>

        {/* Positions */}
        <div className="mb-6">
          <h2 className="mb-3 text-lg font-semibold text-foreground">Open Positions</h2>
          {positions.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted">
              No open positions. Use the Chat to place trades.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-card text-xs text-muted">
                    <th className="px-4 py-3 text-left">Market</th>
                    <th className="px-4 py-3 text-left">Side</th>
                    <th className="px-4 py-3 text-right">Size</th>
                    <th className="px-4 py-3 text-right">Entry Price</th>
                    <th className="px-4 py-3 text-right">PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => {
                    const pnl = (p.perp?.sizePricePnl ?? 0) + (p.perp?.fundingPaymentPnl ?? 0);
                    return (
                      <tr key={p.marketId} className="border-b border-border">
                        <td className="px-4 py-3 font-medium text-foreground">
                          {N1_MARKET_SYMBOLS[p.marketId] ?? `Market-${p.marketId}`}
                        </td>
                        <td className={`px-4 py-3 ${p.perp?.isLong ? "text-green-400" : "text-red-400"}`}>
                          {p.perp?.isLong ? "Long" : "Short"}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-foreground">
                          {Math.abs(p.perp?.baseSize ?? 0).toFixed(6)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-foreground">
                          {formatUsd(p.perp?.price ?? 0)}
                        </td>
                        <td className={`px-4 py-3 text-right font-mono ${pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {pnl >= 0 ? "+" : ""}{formatUsd(pnl)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Open Orders */}
        {orders.length > 0 && (
          <div className="mb-6">
            <h2 className="mb-3 text-lg font-semibold text-foreground">Open Orders ({orders.length})</h2>
            <div className="overflow-hidden rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-card text-xs text-muted">
                    <th className="px-4 py-3 text-left">Market</th>
                    <th className="px-4 py-3 text-left">Side</th>
                    <th className="px-4 py-3 text-right">Size</th>
                    <th className="px-4 py-3 text-right">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.orderId} className="border-b border-border">
                      <td className="px-4 py-3 text-foreground">
                        {N1_MARKET_SYMBOLS[o.marketId] ?? `Market-${o.marketId}`}
                      </td>
                      <td className={`px-4 py-3 ${o.side === "bid" ? "text-green-400" : "text-red-400"}`}>
                        {o.side === "bid" ? "Buy" : "Sell"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-foreground">{o.size.toFixed(6)}</td>
                      <td className="px-4 py-3 text-right font-mono text-foreground">{formatUsd(o.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Active Triggers */}
        {triggers.length > 0 && (
          <div>
            <h2 className="mb-3 text-lg font-semibold text-foreground">Active Triggers ({triggers.length})</h2>
            <div className="overflow-hidden rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-card text-xs text-muted">
                    <th className="px-4 py-3 text-left">Market</th>
                    <th className="px-4 py-3 text-left">Type</th>
                    <th className="px-4 py-3 text-right">Trigger Price</th>
                  </tr>
                </thead>
                <tbody>
                  {triggers.map((t, i) => (
                    <tr key={i} className="border-b border-border">
                      <td className="px-4 py-3 text-foreground">
                        {N1_MARKET_SYMBOLS[t.marketId] ?? `Market-${t.marketId}`}
                      </td>
                      <td className={`px-4 py-3 ${t.kind === "StopLoss" ? "text-red-400" : "text-green-400"}`}>
                        {t.kind === "StopLoss" ? "Stop-Loss" : "Take-Profit"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-foreground">
                        {formatUsd(t.triggerPrice)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
