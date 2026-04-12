"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth/context";

interface HistoryTrade {
  id: string;
  symbol: string;
  side: string;
  size: string;
  price: string | null;
  status: string;
  error: string | null;
  leaderAddr: string;
  createdAt: string;
  filledAt: string | null;
}

const PAGE_SIZE = 30;

function shortenAddr(addr: string): string {
  if (addr.startsWith("account:")) return "#" + addr.slice(8);
  return addr.slice(0, 4) + "..." + addr.slice(-4);
}

export function CopyHistoryTab() {
  const { isAuthenticated } = useAuth();
  const [trades, setTrades] = useState<HistoryTrade[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [leaderFilter, setLeaderFilter] = useState("");

  const fetchHistory = useCallback(async (newOffset: number) => {
    if (!isAuthenticated) { setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(newOffset),
      });
      if (statusFilter) params.set("status", statusFilter);
      if (leaderFilter.trim()) params.set("leader", leaderFilter.trim());

      const res = await fetch(`/api/copy/history?${params}`);
      if (!res.ok) { setLoading(false); return; }
      const data = await res.json();
      setTrades(data.trades);
      setTotal(data.total);
      setOffset(newOffset);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, statusFilter, leaderFilter]);

  useEffect(() => {
    fetchHistory(0);
  }, [fetchHistory]);

  if (!isAuthenticated) {
    return (
      <div className="py-4 text-center text-[10px] text-muted">
        Connect wallet to view copy trade history
      </div>
    );
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="px-3 py-2 space-y-2">
      {/* Filters */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder="Filter by leader..."
          value={leaderFilter}
          onChange={(e) => setLeaderFilter(e.target.value)}
          className="flex-1 rounded-md border border-[#262626] bg-[#0a0a0a] px-2 py-1 text-[10px] text-[#ccc] placeholder-[#555] outline-none focus:border-emerald-500/30"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-[#262626] bg-[#0a0a0a] px-2 py-1 text-[10px] text-[#ccc] outline-none focus:border-emerald-500/30"
        >
          <option value="">All</option>
          <option value="filled">Filled</option>
          <option value="failed">Failed</option>
          <option value="pending">Pending</option>
        </select>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex h-16 items-center justify-center">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
        </div>
      )}

      {/* Empty */}
      {!loading && trades.length === 0 && (
        <div className="rounded-lg border border-dashed border-[#262626] p-4 text-center">
          <p className="text-[11px] text-[#666]">No copy trades found</p>
        </div>
      )}

      {/* Trade list */}
      {!loading && trades.length > 0 && (
        <div className="space-y-1">
          {/* Header */}
          <div className="grid grid-cols-[1fr_50px_60px_70px_50px_50px_54px] gap-1 px-2 text-[9px] text-[#555] font-medium">
            <span>Market</span>
            <span>Side</span>
            <span className="text-right">Size</span>
            <span className="text-right">Price</span>
            <span>Status</span>
            <span>Leader</span>
            <span className="text-right">Time</span>
          </div>

          {trades.map((t) => (
            <div
              key={t.id}
              className={`grid grid-cols-[1fr_50px_60px_70px_50px_50px_54px] gap-1 items-center rounded border px-2 py-1.5 text-[9px] font-mono ${
                t.status === "filled"
                  ? "border-emerald-500/10 bg-emerald-500/5"
                  : t.status === "failed"
                  ? "border-red-500/10 bg-red-500/5"
                  : "border-[#262626] bg-[#0a0a0a]"
              }`}
            >
              <span className="text-[#ccc] truncate">{t.symbol}</span>
              <span className={t.side === "Long" ? "text-emerald-400" : "text-red-400"}>
                {t.side}
              </span>
              <span className="text-[#999] text-right">{parseFloat(t.size).toFixed(4)}</span>
              <span className="text-[#666] text-right">
                {t.price ? "$" + parseFloat(t.price).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
              </span>
              <span className={`${
                t.status === "filled" ? "text-emerald-400" : t.status === "failed" ? "text-red-400" : "text-yellow-400"
              }`}>
                {t.status}
              </span>
              <span className="text-[#555] truncate" title={t.leaderAddr}>{shortenAddr(t.leaderAddr)}</span>
              <span className="text-[#555] text-right">
                {new Date(t.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                {" "}
                {new Date(t.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {!loading && total > PAGE_SIZE && (
        <div className="flex items-center justify-between pt-1">
          <span className="text-[9px] text-[#555]">{total} trades</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => fetchHistory(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="rounded px-2 py-0.5 text-[10px] text-[#888] hover:text-white disabled:opacity-30 disabled:hover:text-[#888] transition-colors border border-[#262626]"
            >
              Prev
            </button>
            <span className="text-[9px] text-[#666] px-1">{currentPage}/{totalPages}</span>
            <button
              onClick={() => fetchHistory(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total}
              className="rounded px-2 py-0.5 text-[10px] text-[#888] hover:text-white disabled:opacity-30 disabled:hover:text-[#888] transition-colors border border-[#262626]"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
