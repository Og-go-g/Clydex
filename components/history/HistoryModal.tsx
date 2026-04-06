"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";

// ─── Types ────────────────────────────────────────────────────────

type Tab = "orders" | "trades" | "funding" | "transfers";

interface OrderRow {
  id: string;
  orderId: string;
  marketId: number;
  symbol: string;
  side: string;
  placedSize: string;
  filledSize: string | null;
  placedPrice: string;
  orderValue: string;
  fillMode: string;
  fillStatus: string;
  status: string;
  addedAt: string;
}

interface TradeRow {
  id: string;
  tradeId: string;
  marketId: number;
  symbol: string;
  side: string;
  size: string;
  price: string;
  role: string;
  fee: string;
  closedPnl: string | null;
  time: string;
}

interface PnlRow {
  id: string;
  marketId: number;
  symbol: string;
  tradingPnl: string;
  settledFundingPnl: string;
  positionSize: string;
  time: string;
}

interface FundingRow {
  id: string;
  marketId: number;
  symbol: string;
  fundingPnl: string;
  positionSize: string;
  time: string;
}

interface DepositRow {
  id: string;
  amount: string;
  balance: string;
  time: string;
}

interface WithdrawalRow {
  id: string;
  amount: string;
  balance: string;
  fee: string;
  destPubkey: string;
  time: string;
}

interface PagedResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

interface TransferResult {
  deposits: PagedResult<DepositRow>;
  withdrawals: PagedResult<WithdrawalRow>;
}

interface SyncStatus {
  synced: boolean;
  lastSyncAt: string | null;
}

interface SyncResultItem {
  type: string;
  inserted: number;
  error?: string;
}

// ─── Props ────────────────────────────────────────────────────────

interface HistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// ─── Formatters ───────────────────────────────────────────────────

function fmtUsd(v: string | number, decimals = 2): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!isFinite(n)) return "--";
  if (n === 0) return "--";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return sign + "$" + abs.toFixed(decimals);
}

function fmtPrice(v: string | number): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!isFinite(n)) return "$0.00";
  const decimals = Math.abs(n) < 1 ? 6 : Math.abs(n) < 100 ? 4 : 2;
  return "$" + n.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

function fmtSize(v: string | number): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!isFinite(n)) return "0";
  const decimals = Math.abs(n) < 0.01 ? 6 : Math.abs(n) < 1 ? 4 : 2;
  return n.toFixed(decimals);
}

function fmtDateLocal(iso: string): string {
  const d = new Date(iso);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const year = d.getFullYear();
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `${month}/${day}/${year} - ${h}:${m}:${s}`;
}

/** Client-only date cell — renders empty on SSR, fills on mount to get correct timezone */
function DateCell({ iso, className }: { iso: string; className: string }) {
  const [text, setText] = useState("");
  useEffect(() => {
    setText(fmtDateLocal(iso));
  }, [iso]);
  return <td className={className}>{text || "\u00A0"}</td>;
}

function fmtAddr(addr: string): string {
  if (!addr || addr.length <= 10) return addr || "--";
  return addr.slice(0, 4) + "..." + addr.slice(-4);
}

function pnlColor(v: string | number): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (n > 0.001) return "text-emerald-400";
  if (n < -0.001) return "text-red-400";
  return "text-muted";
}

function tradeValue(price: string, size: string): number {
  const p = parseFloat(price);
  const s = parseFloat(size);
  if (!isFinite(p) || !isFinite(s)) return 0;
  return Math.abs(p * s);
}

// 01 Exchange standard fee rates (verified from volume-calendar API)
const TAKER_FEE_RATE = 0.00035;  // 0.035%
const MAKER_FEE_RATE = 0.0001;   // 0.01%

function estimateFee(tv: number, role: string, dbFee: string): number {
  const stored = parseFloat(dbFee);
  if (isFinite(stored) && stored !== 0) return stored;
  if (tv <= 0) return 0;
  return tv * (role === "taker" ? TAKER_FEE_RATE : MAKER_FEE_RATE);
}

// ─── Tab Config ───────────────────────────────────────────────────

const TABS: { key: Tab; label: string }[] = [
  { key: "orders", label: "Order History" },
  { key: "trades", label: "Trade History" },
  { key: "funding", label: "Funding History" },
  { key: "transfers", label: "Deposit and Withdrawal History" },
];

const PAGE_SIZE = 50;

// ─── Modal Component ──────────────────────────────────────────────

export function HistoryModal({ isOpen, onClose }: HistoryModalProps) {
  const [tab, setTab] = useState<Tab>("trades");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncResults, setSyncResults] = useState<SyncResultItem[] | null>(null);
  const [offset, setOffset] = useState(0);
  const initialSyncDone = useRef(false);

  const [orders, setOrders] = useState<PagedResult<OrderRow> | null>(null);
  const [trades, setTrades] = useState<PagedResult<TradeRow> | null>(null);
  const [pnl, setPnl] = useState<PagedResult<PnlRow> | null>(null);
  const [funding, setFunding] = useState<PagedResult<FundingRow> | null>(null);
  const [transfers, setTransfers] = useState<TransferResult | null>(null);

  useEffect(() => setOffset(0), [tab]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  // ─── Sync ─────────────────────────────────────────────────────

  const checkSyncStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/history/sync");
      if (res.ok) {
        const status: SyncStatus = await res.json();
        setSyncStatus(status);
        return status;
      }
    } catch { /* silent */ }
    return null;
  }, []);

  const triggerSync = useCallback(async () => {
    setSyncing(true);
    setSyncResults(null);
    try {
      const res = await fetch("/api/history/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        const body = await res.json();
        setSyncResults(body.results);
        await checkSyncStatus();
      }
    } catch (err) {
      console.error("[history] sync failed:", err);
    } finally {
      setSyncing(false);
    }
  }, [checkSyncStatus]);

  // Auto-sync on first open: sync then fetch data.
  // For new users (never synced): wait for full sync before showing data.
  // For synced users: show DB data immediately, sync in background.
  useEffect(() => {
    if (!isOpen || initialSyncDone.current) return;
    initialSyncDone.current = true;

    (async () => {
      // Check if user has been synced before
      const status = await checkSyncStatus();
      const alreadySynced = status?.synced ?? false;

      if (alreadySynced) {
        // Synced user: show data immediately from DB, sync in background
        fetchData();
        triggerSync(); // background — will refresh data when done
      } else {
        // New user: wait for full sync, then show data
        await triggerSync();
        // fetchData will be triggered by syncResults useEffect below
      }
    })();
  }, [isOpen, triggerSync, checkSyncStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Fetch Data ───────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    if (!isOpen) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (tab === "orders") {
        const res = await fetch(`/api/history/orders?${params}`);
        if (res.ok) setOrders(await res.json());
      } else if (tab === "trades") {
        const res = await fetch(`/api/history/trades?${params}`);
        if (res.ok) setTrades(await res.json());
      } else if (tab === "funding") {
        const res = await fetch(`/api/history/funding?${params}`);
        if (res.ok) setFunding(await res.json());
      } else if (tab === "transfers") {
        const res = await fetch(`/api/history/transfers?${params}`);
        if (res.ok) setTransfers(await res.json());
      }
    } catch (err) {
      console.error("[history] fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [isOpen, tab, offset]);

  // Re-fetch when tab or page changes (only if we have data or sync is done)
  useEffect(() => {
    if (isOpen && (syncStatus?.synced || syncResults)) fetchData();
  }, [isOpen, tab, offset]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch after sync completes (covers both new and returning users)
  useEffect(() => {
    if (syncResults) fetchData();
  }, [syncResults]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOpen) return null;

  // ─── Pagination ───────────────────────────────────────────────

  function getTotal(): number {
    if (tab === "orders") return orders?.total ?? 0;
    if (tab === "trades") return trades?.total ?? 0;
    if (tab === "funding") return funding?.total ?? 0;
    if (tab === "transfers") return (transfers?.deposits?.total ?? 0) + (transfers?.withdrawals?.total ?? 0);
    return 0;
  }

  const total = getTotal();
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  // ─── Render ───────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative mx-4 my-8 w-full max-w-6xl rounded-2xl border border-[#262626] bg-[#0a0a0a] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#262626] px-6 py-4">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-bold text-white">History</h2>
            {syncStatus?.lastSyncAt && (
              <span className="text-xs text-muted">
                Synced: {fmtDateLocal(syncStatus.lastSyncAt)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={triggerSync}
              disabled={syncing}
              className="flex items-center gap-2 rounded-lg border border-[#333] bg-[#1a1a1a] px-3 py-1.5 text-xs text-white transition hover:border-emerald-500/50 hover:bg-[#222] disabled:opacity-50"
            >
              {syncing ? (
                <>
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
                  Syncing...
                </>
              ) : (
                "Sync"
              )}
            </button>
            <button onClick={onClose} className="rounded-lg p-1.5 text-muted transition hover:bg-[#1a1a1a] hover:text-white">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Sync banner */}
        {syncing && (
          <div className="border-b border-emerald-500/20 bg-emerald-500/5 px-6 py-2">
            <div className="flex items-center gap-2 text-xs text-emerald-400">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
              Syncing history from 01 Exchange...
            </div>
          </div>
        )}

        {/* Tabs — styled like 01 Exchange */}
        <div className="flex border-b border-[#262626]">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`whitespace-nowrap px-6 py-3 text-sm font-medium transition ${
                tab === t.key
                  ? "border-b-2 border-emerald-500 text-white"
                  : "text-muted hover:text-white"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Table */}
        <div className="max-h-[60vh] overflow-auto">
          {loading ? (
            <div className="flex h-32 items-center justify-center">
              <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
            </div>
          ) : (
            <>
              {tab === "orders" && <OrderHistoryTable data={orders?.data ?? []} />}
              {tab === "trades" && <TradeHistoryTable data={trades?.data ?? []} />}
              {tab === "funding" && <FundingHistoryTable data={funding?.data ?? []} />}
              {tab === "transfers" && <TransferHistoryTable deposits={transfers?.deposits?.data ?? []} withdrawals={transfers?.withdrawals?.data ?? []} />}
            </>
          )}
        </div>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-center gap-2 border-t border-[#262626] px-6 py-3">
            <button
              onClick={() => setOffset(0)}
              disabled={offset === 0}
              className="rounded px-2 py-1 text-xs text-muted transition hover:text-white disabled:opacity-30"
            >
              &laquo;
            </button>
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="rounded px-2 py-1 text-xs text-muted transition hover:text-white disabled:opacity-30"
            >
              &lsaquo;
            </button>
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              let page: number;
              if (totalPages <= 5) {
                page = i + 1;
              } else if (currentPage <= 3) {
                page = i + 1;
              } else if (currentPage >= totalPages - 2) {
                page = totalPages - 4 + i;
              } else {
                page = currentPage - 2 + i;
              }
              return (
                <button
                  key={page}
                  onClick={() => setOffset((page - 1) * PAGE_SIZE)}
                  className={`min-w-[28px] rounded px-2 py-1 text-xs transition ${
                    page === currentPage
                      ? "bg-emerald-500/20 text-emerald-400 font-medium"
                      : "text-muted hover:text-white"
                  }`}
                >
                  {page}
                </button>
              );
            })}
            {totalPages > 5 && currentPage < totalPages - 2 && (
              <>
                <span className="text-xs text-muted">...</span>
                <button
                  onClick={() => setOffset((totalPages - 1) * PAGE_SIZE)}
                  className="rounded px-2 py-1 text-xs text-muted transition hover:text-white"
                >
                  {totalPages}
                </button>
              </>
            )}
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={currentPage >= totalPages}
              className="rounded px-2 py-1 text-xs text-muted transition hover:text-white disabled:opacity-30"
            >
              &rsaquo;
            </button>
            <button
              onClick={() => setOffset((totalPages - 1) * PAGE_SIZE)}
              disabled={currentPage >= totalPages}
              className="rounded px-2 py-1 text-xs text-muted transition hover:text-white disabled:opacity-30"
            >
              &raquo;
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Table Components ─────────────────────────────────────────────

const TH = "px-4 py-3 text-left text-xs font-medium text-muted";
const TD = "whitespace-nowrap px-4 py-3 text-sm";

function EmptyState() {
  return (
    <div className="flex h-24 items-center justify-center text-sm text-muted">
      No records found
    </div>
  );
}

// ─── Trade History (like 01 Exchange) ─────────────────────────────

function TradeHistoryTable({ data }: { data: TradeRow[] }) {
  if (data.length === 0) return <EmptyState />;
  return (
    <table className="w-full">
      <thead className="sticky top-0 border-b border-[#262626] bg-[#0d0d0d]">
        <tr>
          <th className={TH}>Time</th>
          <th className={TH}>Market</th>
          <th className={TH}>Trade</th>
          <th className={TH}>Price</th>
          <th className={TH}>Trade Value</th>
          <th className={TH}>Fee Paid</th>
          <th className={TH}>Closed PnL</th>
          <th className={TH}>Trade Type</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#1a1a1a]">
        {data.map((row) => {
          const tv = tradeValue(row.price, row.size);
          const sizeNum = parseFloat(row.size);
          const fee = estimateFee(tv, row.role, row.fee);
          return (
            <tr key={row.id} className="transition hover:bg-[#111]">
              <DateCell iso={row.time} className={`${TD} text-muted`} />
              <td className={`${TD} text-white`}>{row.symbol.replace("USD", "/USD")}</td>
              <td className={`${TD} ${row.side === "Long" ? "text-emerald-400" : "text-red-400"}`}>
                {row.side === "Short" ? "-" : ""}{fmtSize(Math.abs(sizeNum))}
              </td>
              <td className={`${TD} text-white`}>{fmtPrice(row.price)}</td>
              <td className={`${TD} text-white`}>{tv > 0 ? "$" + tv.toFixed(2) : "--"}</td>
              <td className={`${TD} text-red-400`}>
                {fee > 0 ? fmtUsd(-fee) : "--"}
              </td>
              <td className={`${TD} ${row.closedPnl ? pnlColor(row.closedPnl) : "text-muted"}`}>
                {row.closedPnl && parseFloat(row.closedPnl) !== 0 ? fmtUsd(row.closedPnl) : "--"}
              </td>
              <td className={`${TD} text-muted capitalize`}>{row.role}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Order History (like 01 Exchange) ─────────────────────────────

function OrderHistoryTable({ data }: { data: OrderRow[] }) {
  if (data.length === 0) return <EmptyState />;
  return (
    <table className="w-full">
      <thead className="sticky top-0 border-b border-[#262626] bg-[#0d0d0d]">
        <tr>
          <th className={TH}>Time</th>
          <th className={TH}>Market</th>
          <th className={TH}>Order</th>
          <th className={TH}>Price</th>
          <th className={TH}>Order Value</th>
          <th className={TH}>Fill Status</th>
          <th className={TH}>Status</th>
          <th className={TH}>Order ID</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#1a1a1a]">
        {data.map((row) => {
          const size = parseFloat(row.placedSize);
          const value = parseFloat(row.orderValue);
          return (
            <tr key={row.id} className="transition hover:bg-[#111]">
              <DateCell iso={row.addedAt} className={`${TD} text-muted`} />
              <td className={`${TD} ${row.side === "Long" ? "text-emerald-400" : "text-red-400"} font-medium`}>
                {row.symbol.replace("USD", "/USD")}
              </td>
              <td className={`${TD} text-white`}>{fmtSize(size)}</td>
              <td className={`${TD} text-white`}>{fmtPrice(row.placedPrice)}</td>
              <td className={`${TD} text-white`}>{value > 0 ? "$" + value.toFixed(2) : "--"}</td>
              <td className={`${TD} ${row.fillStatus === "Filled" ? "text-emerald-400" : "text-muted"}`}>
                {row.fillStatus}
              </td>
              <td className={`${TD} ${row.status === "Filled" ? "text-emerald-400" : row.status === "Cancelled" ? "text-muted" : "text-white"}`}>
                {row.status}
              </td>
              <td className={`${TD} text-muted font-mono text-xs`}>{row.orderId}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Funding History ──────────────────────────────────────────────

function FundingHistoryTable({ data }: { data: FundingRow[] }) {
  if (data.length === 0) return <EmptyState />;
  return (
    <table className="w-full">
      <thead className="sticky top-0 border-b border-[#262626] bg-[#0d0d0d]">
        <tr>
          <th className={TH}>Time</th>
          <th className={TH}>Market</th>
          <th className={TH}>Position Size</th>
          <th className={TH}>Funding Payment</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#1a1a1a]">
        {data.map((row) => (
          <tr key={row.id} className="transition hover:bg-[#111]">
            <DateCell iso={row.time} className={`${TD} text-muted`} />
            <td className={`${TD} text-white`}>{row.symbol.replace("USD", "/USD")}</td>
            <td className={`${TD} text-white`}>{fmtSize(row.positionSize)}</td>
            <td className={`${TD} ${pnlColor(row.fundingPnl)}`}>
              {parseFloat(row.fundingPnl) !== 0 ? fmtUsd(row.fundingPnl, 4) : "--"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Deposit and Withdrawal History ───────────────────────────────

function TransferHistoryTable({ deposits, withdrawals }: { deposits: DepositRow[]; withdrawals: WithdrawalRow[] }) {
  const merged = [
    ...deposits.map((d) => ({ ...d, type: "deposit" as const })),
    ...withdrawals.map((w) => ({ ...w, type: "withdrawal" as const })),
  ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  if (merged.length === 0) return <EmptyState />;

  return (
    <table className="w-full">
      <thead className="sticky top-0 border-b border-[#262626] bg-[#0d0d0d]">
        <tr>
          <th className={TH}>Time</th>
          <th className={TH}>Type</th>
          <th className={TH}>Amount</th>
          <th className={TH}>Balance After</th>
          <th className={TH}>Fee</th>
          <th className={TH}>Destination</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#1a1a1a]">
        {merged.map((row) => (
          <tr key={row.id} className="transition hover:bg-[#111]">
            <DateCell iso={row.time} className={`${TD} text-muted`} />
            <td className={`${TD} ${row.type === "deposit" ? "text-emerald-400" : "text-red-400"}`}>
              {row.type === "deposit" ? "Deposit" : "Withdrawal"}
            </td>
            <td className={`${TD} text-white`}>${parseFloat(row.amount).toFixed(2)}</td>
            <td className={`${TD} text-muted`}>${parseFloat(row.balance).toFixed(2)}</td>
            <td className={`${TD} text-muted`}>
              {row.type === "withdrawal" && parseFloat((row as WithdrawalRow).fee) > 0
                ? "$" + parseFloat((row as WithdrawalRow).fee).toFixed(2)
                : "--"}
            </td>
            <td className={`${TD} text-muted font-mono text-xs`}>
              {row.type === "withdrawal" ? fmtAddr((row as WithdrawalRow).destPubkey) : "--"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
