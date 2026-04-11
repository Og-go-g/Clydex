"use client";

import { useState, useEffect, useCallback } from "react";

// ─── Types ──────────────────────────────────────────────────────

export interface LeaderboardEntry {
  walletAddr: string;
  totalPnl: number;
  tradingPnl: number;
  fundingPnl: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnlPerTrade: number;
  liquidations: number;
  totalVolume: number;
}

type Period = "7d" | "30d" | "all";

// ─── Formatters ─────────────────────────────────────────────────

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

function fmtAddr(addr: string): string {
  if (!addr) return "—";
  if (addr.startsWith("account:")) return "#" + addr.slice(8);
  if (addr.length < 10) return addr;
  return addr.slice(0, 4) + "…" + addr.slice(-4);
}

// ─── Component ──────────────────────────────────────────────────

/** Leaderboard content without wrapper — used inside CopyTradeSection tabs */
export function LeaderboardContent({ onCopyTrader }: { onCopyTrader?: (entry: LeaderboardEntry) => void }) {
  const [period, setPeriod] = useState<Period>("7d");
  const [data, setData] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/leaderboard?period=${period}&sort=pnl&limit=10`);
      if (res.ok) {
        const body = await res.json();
        setData(body.data ?? []);
      }
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [period]);

  useEffect(() => { fetchData(); }, [fetchData]);

  return (
    <div className="flex flex-col h-full">
      {/* Period filter */}
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[10px] text-muted">
          {data.length > 0 ? `${data.length} traders` : ""}
        </span>
        <div className="flex items-center gap-0.5">
          {(["7d", "30d", "all"] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-1.5 py-0.5 text-[10px] font-medium rounded transition-colors ${
                period === p
                  ? "text-emerald-400 bg-emerald-400/10"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {p === "all" ? "All" : p.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-y-auto flex-1">
        {loading ? (
          <div className="flex h-16 items-center justify-center">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
          </div>
        ) : data.length === 0 ? (
          <div className="px-3 py-4 text-center text-[10px] text-muted">No data</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-[10px] text-muted">
                <th className="px-3 py-1 text-left font-medium w-6">#</th>
                <th className="px-2 py-1 text-left font-medium">Trader</th>
                <th className="px-2 py-1 text-right font-medium">PnL</th>
                <th className="px-2 py-1 text-right font-medium">Win%</th>
                <th className="px-2 py-1 text-right font-medium">Vol</th>
                <th className="px-3 py-1 text-right font-medium w-12"></th>
              </tr>
            </thead>
            <tbody>
              {data.map((entry, i) => {
                const rank = i + 1;
                return (
                  <tr key={entry.walletAddr} className="hover:bg-white/[0.02] transition-colors group">
                    <td className={`px-3 py-1.5 text-[10px] font-bold ${
                      rank === 1 ? "text-yellow-400" : rank === 2 ? "text-gray-300" : rank === 3 ? "text-amber-600" : "text-muted"
                    }`}>
                      {rank}
                    </td>
                    <td className="px-2 py-1.5">
                      <span className="text-[11px] font-mono text-foreground">{fmtAddr(entry.walletAddr)}</span>
                    </td>
                    <td className={`px-2 py-1.5 text-right text-[11px] font-mono font-semibold ${
                      entry.totalPnl > 0 ? "text-emerald-400" : entry.totalPnl < 0 ? "text-red-400" : "text-muted"
                    }`}>
                      {fmtPnl(entry.totalPnl)}
                    </td>
                    <td className={`px-2 py-1.5 text-right text-[11px] font-mono ${
                      entry.winRate >= 60 ? "text-emerald-400" : entry.winRate >= 50 ? "text-foreground" : "text-red-400"
                    }`}>
                      {entry.winRate.toFixed(0)}%
                    </td>
                    <td className="px-2 py-1.5 text-right text-[10px] font-mono text-muted">
                      {fmtVol(entry.totalVolume)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        onClick={(e) => { e.stopPropagation(); onCopyTrader?.(entry); }}
                        className="rounded bg-emerald-500/10 px-2 py-0.5 text-[9px] font-semibold text-emerald-400 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-emerald-500/20"
                      >
                        Copy
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** @deprecated Use CopyTradeSection instead */
export function CompactLeaderboard() {
  return <LeaderboardContent />;
}
