"use client";

// Card renderers for the Copy-Trading (Analyze-mode) chat tools.
//
// Each card takes the raw tool `output` from /api/chat/copytrade and
// renders it in a consistent dark/emerald visual language that
// matches `components/copytrade/CompactLeaderboard.tsx` and
// `components/copytrade/FollowTraderDialog.tsx`. Tool prompts in
// the chat tell the AI "the card shows everything — keep your text
// to one sentence", so every important number must surface here.
//
// All cards accept `onSendMessage` for inline CTAs (rows that
// dispatch follow-up prompts like "copy #7915 with $100"). The
// close-copy card additionally calls `onOpenCloseCopyModal` to
// trigger the shared modal.

import type { CloseCopyModalData } from "@/components/copytrade/CloseCopyPositionModal";
import type { LeaderboardEntry } from "@/components/copytrade/CompactLeaderboard";

// ─── Shared types ───────────────────────────────────────────────

export interface CardCtx {
  onSendMessage?: (msg: string) => void;
  onOpenCloseCopyModal?: (data: CloseCopyModalData) => void;
  /**
   * Pops the shared FollowTraderDialog (the proper UX for picking
   * allocation / leverage / max-pos / stop-loss). Called by Copy
   * buttons on Trader Profile / Suggest / Compare / Positions
   * cards. The host page wires this to also open the chart panel
   * if it's currently collapsed.
   */
  onCopyTrader?: (trader: LeaderboardEntry) => void;
}

/**
 * Helper to construct a LeaderboardEntry from partial tool-result
 * data. The FollowTraderDialog only needs walletAddr to actually
 * subscribe — the other fields are for display in the dialog
 * header. Missing fields default to 0 so the dialog doesn't
 * render NaN.
 */
function toLeaderboardEntry(p: Partial<LeaderboardEntry> & { walletAddr: string }): LeaderboardEntry {
  return {
    walletAddr: p.walletAddr,
    totalPnl: p.totalPnl ?? 0,
    tradingPnl: p.tradingPnl ?? 0,
    fundingPnl: p.fundingPnl ?? 0,
    totalTrades: p.totalTrades ?? 0,
    wins: p.wins ?? 0,
    losses: p.losses ?? 0,
    winRate: p.winRate ?? 0,
    avgPnlPerTrade: p.avgPnlPerTrade ?? 0,
    liquidations: p.liquidations ?? 0,
    totalVolume: p.totalVolume ?? 0,
  };
}

type Json = Record<string, unknown>;

// ─── Formatting helpers ─────────────────────────────────────────

export function fmtAddr(addr: string | null | undefined): string {
  if (!addr) return "—";
  if (addr.startsWith("account:")) return "#" + addr.slice(8);
  if (addr.length < 10) return addr;
  return addr.slice(0, 4) + "…" + addr.slice(-4);
}

function fmtPnl(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  if (abs >= 1_000_000) return sign + "$" + (abs / 1_000_000).toFixed(2) + "M";
  if (abs >= 1_000) return sign + "$" + (abs / 1_000).toFixed(2) + "K";
  if (abs >= 1) return sign + "$" + abs.toFixed(2);
  return sign + "$" + abs.toFixed(4);
}

function fmtVol(n: number | null | undefined): string {
  if (n == null || !isFinite(n) || n === 0) return "—";
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

function fmtSize(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1) return abs.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return abs.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  if (n >= 1000) return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return "$" + n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return "$" + n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function fmtAge(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return "—";
  const diff = Math.max(0, Date.now() - t);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function rankColor(rank: number): string {
  if (rank === 1) return "text-yellow-400";
  if (rank === 2) return "text-gray-300";
  if (rank === 3) return "text-amber-600";
  return "text-[#666]";
}

function pnlColor(n: number | null | undefined, neutralWhenZero = false): string {
  if (n == null || n === 0) return neutralWhenZero ? "text-[#777]" : "text-foreground";
  return n > 0 ? "text-emerald-400" : "text-red-400";
}

function winrateColor(n: number | null | undefined): string {
  if (n == null) return "text-foreground";
  if (n >= 60) return "text-emerald-400";
  if (n >= 50) return "text-foreground";
  return "text-red-400";
}

function riskColor(score: number): string {
  if (score <= 3) return "text-emerald-400";
  if (score <= 6) return "text-yellow-400";
  return "text-red-400";
}

// ─── SuggestionChips ────────────────────────────────────────────
//
// Rendered ONCE per assistant message under the last tool card,
// derived from the tool output's `nextSteps` array. Clicking a
// chip dispatches the prompt to the chat as if the user typed it.

export function SuggestionChips({
  nextSteps,
  onSendMessage,
}: {
  nextSteps: string[];
  onSendMessage?: (msg: string) => void;
}) {
  if (!nextSteps || nextSteps.length === 0 || !onSendMessage) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {nextSteps.slice(0, 4).map((step, i) => (
        <button
          key={i}
          onClick={() => onSendMessage(step)}
          className="rounded-full border border-[#262626] bg-[#141414] px-3 py-1 text-[11px] font-medium text-gray-300 transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/5 hover:text-emerald-400"
        >
          {step}
        </button>
      ))}
    </div>
  );
}

// ─── Card shell ─────────────────────────────────────────────────

function CardShell({
  title,
  badge,
  rightHeader,
  children,
}: {
  title: string;
  badge?: { count: number; tone?: "accent" | "neutral" };
  rightHeader?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="my-2 w-full max-w-3xl overflow-hidden rounded-xl border border-[#262626] bg-[#0f0f0f]">
      {/* `pr-10` reserves space for CollapsibleCard's chevron at
          (absolute top-2 right-2) — same pattern Trade-mode cards
          use (see app/chat/page.tsx — pr-10 on Markets / Orderbook
          / Funding headers). Without it, rightHeader text slides
          under the chevron when the card is expanded. */}
      <div className="flex items-center justify-between border-b border-[#262626] px-4 pr-10 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-white">{title}</span>
          {badge && (
            <span
              className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                badge.tone === "neutral"
                  ? "bg-white/10 text-gray-300"
                  : "bg-emerald-500/15 text-emerald-400"
              }`}
            >
              {badge.count}
            </span>
          )}
        </div>
        {rightHeader && (
          <div className="shrink-0 pl-2 text-[10px] text-[#888]">{rightHeader}</div>
        )}
      </div>
      {children}
    </div>
  );
}

function EmptyHint({ msg }: { msg: string }) {
  return <div className="px-4 py-6 text-center text-xs text-gray-500">{msg}</div>;
}

// ─── 1. LeaderboardCard ─────────────────────────────────────────

interface LeaderRow {
  rank: number;
  wallet: string;
  fullAddress: string;
  totalPnl: number;
  winRate: number;
  totalTrades: number;
  liquidations: number;
  totalVolume: number;
}

export function LeaderboardCard({ data, ctx }: { data: Json; ctx?: CardCtx }) {
  const traders = (data.traders as LeaderRow[] | undefined) ?? [];
  const periodRaw = data.period;
  const period: number | "all" =
    typeof periodRaw === "number" && periodRaw > 0
      ? periodRaw
      : periodRaw === "all"
        ? "all"
        : "all";
  const sort = String(data.sort ?? "pnl");
  const mmFiltered = typeof data.mmFiltered === "number" ? data.mmFiltered : 0;
  const mmIncluded = data.mmIncluded === true;
  if (traders.length === 0) {
    return (
      <CardShell title="Leaderboard">
        <EmptyHint msg="No traders found." />
      </CardShell>
    );
  }
  return (
    <CardShell
      title="Leaderboard"
      badge={{ count: traders.length }}
      rightHeader={
        <span>
          {periodLabel(period)} · sort: {sort}
        </span>
      }
    >
      {/* MM transparency strip — shows when at least one MM-like row
          was hidden. Click hint sends a chat message that re-runs
          the query with includeMM=true. */}
      {mmFiltered > 0 && !mmIncluded && (
        <div className="border-b border-[#1f1f1f] bg-[#0a0a0a] px-3 py-1.5 text-[10px] text-[#888]">
          {mmFiltered} market-maker / bot account{mmFiltered === 1 ? "" : "s"} hidden ·{" "}
          <button
            type="button"
            onClick={() => ctx?.onSendMessage?.("Show all top traders including market makers")}
            className="text-emerald-400 underline hover:text-emerald-300"
          >
            include them
          </button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[#1f1f1f] text-[10px] text-[#888]">
              <th className="w-8 px-3 py-2 text-left">#</th>
              <th className="px-2 py-2 text-left">Trader</th>
              <th className="px-2 py-2 text-right">PnL</th>
              <th className="px-2 py-2 text-right">Win%</th>
              <th className="px-2 py-2 text-right hidden sm:table-cell">Trades</th>
              <th className="px-2 py-2 text-right">Vol</th>
              <th className="px-2 py-2 text-right hidden sm:table-cell">Liq</th>
              <th className="w-16 px-3 py-2 text-right"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#1a1a1a]">
            {traders.map((t) => (
              <tr key={t.fullAddress} className="group transition hover:bg-white/[0.02]">
                <td className={`px-3 py-2 text-[11px] font-bold ${rankColor(t.rank)}`}>{t.rank}</td>
                <td className="px-2 py-2 font-mono text-[11px] text-white">{t.wallet}</td>
                <td className={`px-2 py-2 text-right font-mono text-[11px] font-semibold ${pnlColor(t.totalPnl)}`}>
                  {fmtPnl(t.totalPnl)}
                </td>
                <td className={`px-2 py-2 text-right font-mono text-[11px] ${winrateColor(t.winRate)}`}>
                  {t.winRate.toFixed(0)}%
                </td>
                <td className="px-2 py-2 text-right font-mono text-[10px] text-[#888] hidden sm:table-cell">
                  {t.totalTrades}
                </td>
                <td className="px-2 py-2 text-right font-mono text-[10px] text-[#888]">{fmtVol(t.totalVolume)}</td>
                <td
                  className={`px-2 py-2 text-right font-mono text-[10px] hidden sm:table-cell ${
                    t.liquidations === 0 ? "text-[#666]" : "text-red-400"
                  }`}
                >
                  {t.liquidations}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => ctx?.onSendMessage?.(`Analyze ${t.fullAddress}`)}
                    className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 opacity-0 transition-opacity hover:bg-emerald-500/20 group-hover:opacity-100"
                  >
                    Analyze
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CardShell>
  );
}

// ─── 2. TraderProfileCard ───────────────────────────────────────

interface TraderProfileData {
  wallet: string;
  fullAddress: string;
  /** Window the numbers cover. `number` = days, `"all"` = lifetime.
   * Mirrored from the AI tool input → forwarded by the route. */
  period?: number | "all";
  totalPnl: number;
  tradingPnl: number;
  fundingPnl: number;
  winRate: number;
  totalTrades: number;
  wins: number;
  losses: number;
  avgPnlPerTrade: number;
  liquidations: number;
  totalVolume: number;
  topTrades: Array<{ symbol: string; side: string; closedPnl: number; time: string }>;
  marketBreakdown: Array<{ symbol: string; pnl: number; trades: number }>;
}

function periodLabel(p: number | "all" | undefined): string {
  if (p === "all" || p == null) return "ALL-TIME";
  if (typeof p === "number" && Number.isFinite(p) && p > 0) return `${p}D`;
  return "ALL-TIME";
}

function isScopedPeriod(p: number | "all" | undefined): boolean {
  return typeof p === "number" && p > 0;
}

function MetricCell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-[#1f1f1f] bg-[#141414] px-3 py-2">
      <span className="text-[9px] uppercase tracking-wider text-[#666]">{label}</span>
      <span className={`font-mono text-sm font-semibold ${tone ?? "text-white"}`}>{value}</span>
    </div>
  );
}

export function TraderProfileCard({ data, ctx }: { data: Json; ctx?: CardCtx }) {
  const d = data as unknown as TraderProfileData;
  return (
    <CardShell
      title="Trader Profile"
      rightHeader={
        <span className="flex items-center gap-2">
          {/* Period badge — mirrors `data.period` from the tool result.
              When the AI chains period from a 7d leaderboard, this
              renders "7D"; explicit lifetime profiles render "ALL-TIME".
              Keeps the user's mental model aligned: leaderboard row
              numbers always match what the profile card shows. */}
          <span
            className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
              isScopedPeriod(d.period)
                ? "bg-emerald-500/15 text-emerald-400"
                : "bg-white/5 text-[#888]"
            }`}
          >
            {periodLabel(d.period)}
          </span>
          <span className="font-mono">{d.wallet}</span>
        </span>
      }
    >
      <div className="space-y-3 p-3">
        {/* Headline metrics */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MetricCell label="Total PnL" value={fmtPnl(d.totalPnl)} tone={pnlColor(d.totalPnl)} />
          <MetricCell label="Win Rate" value={`${d.winRate.toFixed(1)}%`} tone={winrateColor(d.winRate)} />
          <MetricCell label="Trades" value={String(d.totalTrades)} />
          <MetricCell
            label="Liquidations"
            value={String(d.liquidations)}
            tone={d.liquidations === 0 ? "text-emerald-400" : "text-red-400"}
          />
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MetricCell label="Trading PnL" value={fmtPnl(d.tradingPnl)} tone={pnlColor(d.tradingPnl)} />
          <MetricCell label="Funding PnL" value={fmtPnl(d.fundingPnl)} tone={pnlColor(d.fundingPnl)} />
          <MetricCell label="Avg / Trade" value={fmtPnl(d.avgPnlPerTrade)} tone={pnlColor(d.avgPnlPerTrade)} />
          <MetricCell label="Volume" value={fmtVol(d.totalVolume)} />
        </div>

        {/* Markets breakdown */}
        {d.marketBreakdown && d.marketBreakdown.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-[#888]">By Market</div>
            <div className="overflow-x-auto rounded-lg border border-[#1f1f1f] bg-[#141414]">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] text-[#888]">
                    <th className="px-3 py-1.5 text-left">Market</th>
                    <th className="px-3 py-1.5 text-right">PnL</th>
                    <th className="px-3 py-1.5 text-right">Trades</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1a1a1a]">
                  {d.marketBreakdown.slice(0, 8).map((m) => (
                    <tr key={m.symbol}>
                      <td className="px-3 py-1.5 font-medium text-white">{m.symbol}</td>
                      <td className={`px-3 py-1.5 text-right font-mono ${pnlColor(m.pnl)}`}>{fmtPnl(m.pnl)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-[#888]">{m.trades}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Top trades */}
        {d.topTrades && d.topTrades.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-[#888]">Top Trades</div>
            <div className="space-y-1">
              {d.topTrades.map((t, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-lg border border-[#1f1f1f] bg-[#141414] px-3 py-1.5"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${
                        t.side === "Long" || t.side === "long"
                          ? "bg-emerald-500/15 text-emerald-400"
                          : "bg-red-500/15 text-red-400"
                      }`}
                    >
                      {t.side}
                    </span>
                    <span className="font-medium text-white">{t.symbol}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`font-mono text-xs ${pnlColor(t.closedPnl)}`}>{fmtPnl(t.closedPnl)}</span>
                    <span className="text-[10px] text-[#666]">{fmtAge(t.time)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* CTA row.
            - Copy button → opens the chart-panel-hosted
              FollowTraderDialog (proper UX for picking allocation /
              leverage / max-pos / SL). Falls back to a chat message
              if onCopyTrader isn't wired in (defensive, host always
              wires it in the production page).
            - Live Positions → vague chat reference; AI resolves
              "this trader" from the profile result already in
              conversation context. */}
        <div className="flex gap-2 pt-1">
          <button
            onClick={() => {
              if (ctx?.onCopyTrader) {
                ctx.onCopyTrader(
                  toLeaderboardEntry({
                    walletAddr: d.fullAddress,
                    totalPnl: d.totalPnl,
                    tradingPnl: d.tradingPnl,
                    fundingPnl: d.fundingPnl,
                    totalTrades: d.totalTrades,
                    wins: d.wins,
                    losses: d.losses,
                    winRate: d.winRate,
                    avgPnlPerTrade: d.avgPnlPerTrade,
                    liquidations: d.liquidations,
                    totalVolume: d.totalVolume,
                  }),
                );
              } else {
                ctx?.onSendMessage?.("Copy this trader with $100");
              }
            }}
            className="flex-1 rounded-lg bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/25"
          >
            Copy this trader
          </button>
          <button
            onClick={() => ctx?.onSendMessage?.("Show this trader's open positions")}
            className="flex-1 rounded-lg border border-[#262626] bg-[#141414] px-3 py-2 text-xs font-medium text-gray-300 transition-colors hover:bg-[#1a1a1a]"
          >
            Live Positions
          </button>
        </div>
      </div>
    </CardShell>
  );
}

// ─── 3. CopyStatusCard ──────────────────────────────────────────

interface CopyStatusData {
  sessionActive: boolean;
  sessionExpires: string | null;
  subscriptions: Array<{
    leaderAddr: string;
    fullLeaderAddr: string;
    allocationUsdc: string | number;
    leverageMult: string | number;
    active: boolean;
  }>;
  stats: Record<string, unknown> | null;
  recentTrades: Array<{
    symbol: string;
    side: string;
    size: string | number;
    status: string;
    error: string | null;
    createdAt: string;
  }>;
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
        active
          ? "bg-emerald-500/15 text-emerald-400"
          : "bg-red-500/15 text-red-400"
      }`}
    >
      {active ? "ACTIVE" : "INACTIVE"}
    </span>
  );
}

export function CopyStatusCard({ data, ctx }: { data: Json; ctx?: CardCtx }) {
  const d = data as unknown as CopyStatusData;
  const expiresIn = d.sessionExpires
    ? Math.max(0, Math.floor((new Date(d.sessionExpires).getTime() - Date.now()) / 86_400_000))
    : null;
  return (
    <CardShell title="Copy Trading Status" rightHeader={<StatusBadge active={d.sessionActive} />}>
      <div className="space-y-3 p-3">
        {/* Session */}
        <div className="flex items-center justify-between rounded-lg border border-[#1f1f1f] bg-[#141414] px-3 py-2">
          <span className="text-xs text-gray-400">Session</span>
          {d.sessionActive ? (
            <span className="font-mono text-xs text-white">
              {expiresIn !== null ? `${expiresIn}d remaining` : "Active"}
            </span>
          ) : (
            <button
              onClick={() => ctx?.onSendMessage?.("How do I activate my copy trading session?")}
              className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 hover:bg-emerald-500/25"
            >
              Activate
            </button>
          )}
        </div>

        {/* Subscriptions */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-[#888]">
              Subscriptions ({d.subscriptions.length})
            </span>
          </div>
          {d.subscriptions.length === 0 ? (
            <EmptyHint msg="No active subscriptions yet." />
          ) : (
            <div className="space-y-1">
              {d.subscriptions.map((s) => (
                <div
                  key={s.fullLeaderAddr}
                  className="flex items-center justify-between rounded-lg border border-[#1f1f1f] bg-[#141414] px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full ${s.active ? "bg-emerald-400" : "bg-[#444]"}`} />
                    <span className="font-mono text-xs text-white">{s.leaderAddr}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-[#888]">
                    <span className="font-mono">${s.allocationUsdc}</span>
                    <span>·</span>
                    <span className="font-mono">{s.leverageMult}x</span>
                    <button
                      onClick={() => ctx?.onSendMessage?.(`Stop copying ${s.fullLeaderAddr}`)}
                      className="ml-2 rounded border border-[#262626] px-1.5 py-0.5 text-[9px] font-medium text-[#888] transition-colors hover:border-red-500/40 hover:text-red-400"
                    >
                      Unfollow
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent trades */}
        {d.recentTrades && d.recentTrades.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-[#888]">Recent Copies</div>
            <div className="space-y-1">
              {d.recentTrades.map((t, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-lg border border-[#1f1f1f] bg-[#141414] px-3 py-1.5 text-[11px]"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1 py-0.5 text-[9px] font-semibold uppercase ${
                        t.side.toLowerCase() === "long"
                          ? "bg-emerald-500/15 text-emerald-400"
                          : "bg-red-500/15 text-red-400"
                      }`}
                    >
                      {t.side}
                    </span>
                    <span className="text-white">{t.symbol}</span>
                    <span className="font-mono text-[#888]">{fmtSize(Number(t.size))}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[10px] uppercase ${
                        t.status === "filled"
                          ? "text-emerald-400"
                          : t.status === "failed"
                            ? "text-red-400"
                            : "text-[#888]"
                      }`}
                    >
                      {t.status}
                    </span>
                    <span className="text-[10px] text-[#666]">{fmtAge(t.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </CardShell>
  );
}

// ─── 4. FollowConfirmCard ───────────────────────────────────────
//
// Renders the AI's `followTrader` PREVIEW. No subscription is created
// at this point — the user must click "Open Copy Dialog" to land in
// FollowTraderDialog (right panel) and confirm allocation / leverage /
// max-pos / SL there. This deliberately mirrors the close-copy
// pattern so every state-changing action funnels through the proper
// UX, never through a chat tool call.

interface FollowConfirmData {
  preview: true;
  wallet: string;
  fullAddress: string;
  sessionActive?: boolean;
  totalPnl?: number;
  winRate?: number;
  totalTrades?: number;
  liquidations?: number;
  totalVolume?: number;
  tradingPnl?: number;
  fundingPnl?: number;
  avgPnlPerTrade?: number;
  wins?: number;
  losses?: number;
}

export function FollowConfirmCard({ data, ctx }: { data: Json; ctx?: CardCtx }) {
  const d = data as unknown as FollowConfirmData;
  const handleOpen = () => {
    ctx?.onCopyTrader?.(
      toLeaderboardEntry({
        walletAddr: d.fullAddress,
        totalPnl: d.totalPnl,
        tradingPnl: d.tradingPnl,
        fundingPnl: d.fundingPnl,
        totalTrades: d.totalTrades,
        wins: d.wins,
        losses: d.losses,
        winRate: d.winRate,
        avgPnlPerTrade: d.avgPnlPerTrade,
        liquidations: d.liquidations,
        totalVolume: d.totalVolume,
      }),
    );
  };
  return (
    <CardShell title="Ready to Copy">
      <div className="space-y-3 p-3">
        <div className="rounded-lg border border-[#1f1f1f] bg-[#141414] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-sm font-semibold text-white">{d.wallet}</span>
            {d.liquidations != null && (
              <span
                className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${
                  d.liquidations === 0 ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
                }`}
              >
                {d.liquidations} liq
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <div className="flex flex-col">
              <span className="text-[9px] uppercase text-[#666]">Total PnL</span>
              <span className={`font-mono font-semibold ${pnlColor(d.totalPnl)}`}>{fmtPnl(d.totalPnl)}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[9px] uppercase text-[#666]">Win rate</span>
              <span className={`font-mono ${winrateColor(d.winRate)}`}>
                {d.winRate != null ? `${d.winRate.toFixed(0)}%` : "—"}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[9px] uppercase text-[#666]">Trades</span>
              <span className="font-mono text-gray-300">{d.totalTrades ?? "—"}</span>
            </div>
          </div>
        </div>

        {d.sessionActive === false && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300">
            Copy trading session is not active yet. Click below — the dialog
            will walk you through enabling it before subscribing.
          </div>
        )}

        <p className="text-center text-[11px] text-[#888]">
          No subscription is created until you confirm in the dialog on
          the right. You pick allocation, leverage, max position and
          stop-loss there.
        </p>

        <button
          onClick={handleOpen}
          className="w-full rounded-lg bg-gradient-to-r from-emerald-500/80 to-emerald-400/80 px-3 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90"
        >
          Open Copy Dialog
        </button>
      </div>
    </CardShell>
  );
}

// ─── 5. UnfollowResultCard ──────────────────────────────────────

export function UnfollowResultCard({ data, ctx }: { data: Json; ctx?: CardCtx }) {
  const leader = String(data.leader ?? "");
  return (
    <CardShell title="Unfollowed">
      <div className="space-y-3 p-4">
        <div className="rounded-xl border border-[#262626] bg-[#141414] px-4 py-3 text-sm text-gray-300">
          No more trades will be copied from{" "}
          <span className="font-mono font-semibold text-white">{leader}</span>. Any existing
          positions stay open until you close them manually.
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => ctx?.onSendMessage?.("Show my open copy positions")}
            className="flex-1 rounded-lg border border-[#262626] bg-[#141414] px-3 py-2 text-xs font-medium text-gray-300 hover:bg-[#1a1a1a]"
          >
            Show My Open Copies
          </button>
          <button
            onClick={() => ctx?.onSendMessage?.("Show top traders this week")}
            className="flex-1 rounded-lg border border-[#262626] bg-[#141414] px-3 py-2 text-xs font-medium text-gray-300 hover:bg-[#1a1a1a]"
          >
            Top Traders
          </button>
        </div>
      </div>
    </CardShell>
  );
}

// ─── 6. TraderPositionsCard ─────────────────────────────────────

interface TraderPositionsData {
  trader: string;
  fullAddress: string;
  accountId: number;
  equity: number;
  positionCount: number;
  positions: Array<{
    marketId: number;
    symbol: string;
    side: "Long" | "Short";
    size: number;
    entryPrice: number;
    /** Current mark price — fallback to entryPrice if API omitted. */
    markPrice?: number;
    /** Position value in USD (size × markPrice). */
    notional?: number;
    /** Effective leverage (1 / marketImf rounded down — what 01 UI shows). */
    leverage?: number;
    /** Liquidation price computed from cross-margin cushion. */
    liqPrice?: number;
    tradingPnl: number;
  }>;
}

export function TraderPositionsCard({ data, ctx }: { data: Json; ctx?: CardCtx }) {
  const d = data as unknown as TraderPositionsData;
  return (
    <CardShell
      title={`${d.trader} Positions`}
      badge={{ count: d.positionCount, tone: d.positionCount === 0 ? "neutral" : "accent" }}
      rightHeader={<span>Equity: <span className="font-mono text-white">${d.equity.toFixed(2)}</span></span>}
    >
      {d.positions.length === 0 ? (
        <EmptyHint msg="No open positions right now." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#1f1f1f] text-[10px] text-[#888]">
                <th className="px-3 py-2 text-left">Market</th>
                <th className="px-2 py-2 text-left">Side</th>
                <th className="px-2 py-2 text-right">Size</th>
                <th className="px-2 py-2 text-right">Value</th>
                <th className="px-2 py-2 text-right">Entry</th>
                <th className="px-2 py-2 text-right">Liq</th>
                <th className="px-2 py-2 text-right">Lev</th>
                <th className="px-2 py-2 text-right">PnL</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1a1a1a]">
              {d.positions.map((p) => (
                <tr key={p.marketId} className="transition hover:bg-white/[0.02]">
                  <td className="px-3 py-2 font-medium text-white">{p.symbol}</td>
                  <td className="px-2 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${
                        p.side === "Long"
                          ? "bg-emerald-500/15 text-emerald-400"
                          : "bg-red-500/15 text-red-400"
                      }`}
                    >
                      {p.side}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-[11px] text-gray-300">{fmtSize(p.size)}</td>
                  <td className="px-2 py-2 text-right font-mono text-[11px] text-gray-300">
                    {p.notional != null ? fmtVol(p.notional) : "—"}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-[11px] text-gray-300">{fmtPrice(p.entryPrice)}</td>
                  <td
                    className={`px-2 py-2 text-right font-mono text-[11px] ${
                      p.liqPrice && p.liqPrice > 0 ? "text-red-400" : "text-[#555]"
                    }`}
                    title={p.liqPrice && p.liqPrice > 0 ? "Liquidation price (cross-margin)" : "Liquidation price not available"}
                  >
                    {p.liqPrice && p.liqPrice > 0 ? fmtPrice(p.liqPrice) : "—"}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-[11px] text-gray-300">
                    {p.leverage && p.leverage > 0 ? `${p.leverage}x` : "—"}
                  </td>
                  <td className={`px-2 py-2 text-right font-mono text-[11px] font-semibold ${pnlColor(p.tradingPnl)}`}>
                    {fmtPnl(p.tradingPnl)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="border-t border-[#1f1f1f] px-3 py-2">
        <button
          onClick={() => {
            if (ctx?.onCopyTrader) {
              ctx.onCopyTrader(toLeaderboardEntry({ walletAddr: d.fullAddress }));
            } else {
              ctx?.onSendMessage?.("Copy this trader with $100");
            }
          }}
          className="w-full rounded-lg bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-400 hover:bg-emerald-500/25"
        >
          Copy {d.trader}
        </button>
      </div>
    </CardShell>
  );
}

// ─── 7. SuggestTradersCard (AI-curated recommendation) ──────────

interface SuggestData {
  period: number | "all";
  riskProfile: "conservative" | "balanced" | "aggressive";
  screened: number;
  survived: number;
  rejectedMM: number;
  rejectedSample: number;
  rejectedRisk: number;
  suggestions: Array<{
    rank: number;
    wallet: string;
    fullAddress: string;
    totalPnl: number;
    winRate: number;
    totalTrades: number;
    liquidations: number;
    totalVolume: number;
    avgPnlPerTrade: number;
    tradingPnl: number;
    fundingPnl: number;
    riskScore: number;
    consistencyScore: number;
    flags: string[];
    summary: string;
  }>;
}

export function SuggestTradersCard({ data, ctx }: { data: Json; ctx?: CardCtx }) {
  const d = data as unknown as SuggestData;
  if (!d.suggestions || d.suggestions.length === 0) {
    return (
      <CardShell title="Recommended Traders">
        <EmptyHint
          msg={`No survivors after screening ${d.screened ?? 0} candidates. Try a different risk profile or window.`}
        />
      </CardShell>
    );
  }
  // Screening summary — surfaces the curating work the tool did.
  const screened = d.screened ?? 0;
  const rejected = (d.rejectedMM ?? 0) + (d.rejectedSample ?? 0) + (d.rejectedRisk ?? 0);
  return (
    <CardShell
      title="Recommended Traders"
      badge={{ count: d.suggestions.length }}
      rightHeader={
        <span>
          {periodLabel(d.period)} · {d.riskProfile}
        </span>
      }
    >
      {/* Screening transparency: shows how many candidates were
          considered and rejected, so the user trusts the picks. */}
      <div className="border-b border-[#1f1f1f] bg-[#0a0a0a] px-3 py-1.5 text-[10px] text-[#888]">
        Screened {screened} traders · rejected {rejected}
        {(d.rejectedMM ?? 0) > 0 && ` (${d.rejectedMM} MM-like)`}
        {(d.rejectedSample ?? 0) > 0 && ` · ${d.rejectedSample} low-sample`}
        {(d.rejectedRisk ?? 0) > 0 && ` · ${d.rejectedRisk} risk-filter`}
      </div>

      <div className="space-y-2 p-3">
        {d.suggestions.map((s) => (
          <div
            key={s.fullAddress}
            className="flex flex-col gap-2 rounded-lg border border-[#1f1f1f] bg-[#141414] p-3"
          >
            {/* Header row: rank, wallet, risk score, Copy button */}
            <div className="flex items-center gap-3">
              <span className={`text-base font-bold ${rankColor(s.rank)}`}>{s.rank}</span>
              <span className="flex-1 font-mono text-sm text-white">{s.wallet}</span>
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold ${riskColor(s.riskScore)}`}>
                R{s.riskScore}
              </span>
              <button
                onClick={() => {
                  if (ctx?.onCopyTrader) {
                    ctx.onCopyTrader(
                      toLeaderboardEntry({
                        walletAddr: s.fullAddress,
                        totalPnl: s.totalPnl,
                        tradingPnl: s.tradingPnl,
                        fundingPnl: s.fundingPnl,
                        winRate: s.winRate,
                        totalTrades: s.totalTrades,
                        liquidations: s.liquidations,
                        totalVolume: s.totalVolume,
                        avgPnlPerTrade: s.avgPnlPerTrade,
                      }),
                    );
                  } else {
                    ctx?.onSendMessage?.(`Copy ${s.fullAddress} with $100`);
                  }
                }}
                className="shrink-0 rounded bg-emerald-500/15 px-2.5 py-1 text-[10px] font-semibold text-emerald-400 hover:bg-emerald-500/25"
              >
                Copy
              </button>
            </div>

            {/* Stats row */}
            <div className="flex items-center gap-3 text-[10px]">
              <span className={`font-mono ${pnlColor(s.totalPnl)}`}>{fmtPnl(s.totalPnl)}</span>
              <span className={winrateColor(s.winRate)}>{s.winRate.toFixed(0)}% win</span>
              <span className="text-[#666]">{s.totalTrades} trades</span>
              <span className="text-[#666]">{fmtVol(s.totalVolume)}</span>
              <span className="text-[#666]">Consistency {s.consistencyScore}/100</span>
            </div>

            {/* "Why" — one-line reason this candidate made the cut */}
            <p className="text-[11px] leading-snug text-gray-300">{s.summary}</p>

            {/* Flags row */}
            {s.flags && s.flags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {s.flags.map((f) => {
                  const isWarn = /liquidation|small/i.test(f);
                  return (
                    <span
                      key={f}
                      className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${
                        isWarn
                          ? "bg-amber-500/10 text-amber-300"
                          : "bg-emerald-500/10 text-emerald-300"
                      }`}
                    >
                      {f}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </CardShell>
  );
}

// ─── 8. MarketTopTradersCard ────────────────────────────────────

interface MarketTopData {
  market: string;
  period: number | "all";
  mmFiltered?: number;
  mmIncluded?: boolean;
  traders: Array<{
    rank: number;
    wallet: string;
    fullAddress: string;
    pnl: number;
    winRate: number;
    trades: number;
    volume: number;
  }>;
}

export function MarketTopTradersCard({ data, ctx }: { data: Json; ctx?: CardCtx }) {
  const d = data as unknown as MarketTopData;
  const mmFiltered = d.mmFiltered ?? 0;
  const mmIncluded = d.mmIncluded === true;
  return (
    <CardShell
      title={`Top on ${d.market}`}
      badge={{ count: d.traders.length }}
      rightHeader={<span>{periodLabel(d.period)}</span>}
    >
      {mmFiltered > 0 && !mmIncluded && (
        <div className="border-b border-[#1f1f1f] bg-[#0a0a0a] px-3 py-1.5 text-[10px] text-[#888]">
          {mmFiltered} market-maker / bot account{mmFiltered === 1 ? "" : "s"} hidden ·{" "}
          <button
            type="button"
            onClick={() => ctx?.onSendMessage?.(`Show all top ${d.market} traders including market makers`)}
            className="text-emerald-400 underline hover:text-emerald-300"
          >
            include them
          </button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[#1f1f1f] text-[10px] text-[#888]">
              <th className="w-8 px-3 py-2 text-left">#</th>
              <th className="px-2 py-2 text-left">Trader</th>
              <th className="px-2 py-2 text-right">PnL</th>
              <th className="px-2 py-2 text-right">Win%</th>
              <th className="px-2 py-2 text-right">Trades</th>
              <th className="px-2 py-2 text-right">Vol</th>
              <th className="w-16 px-3 py-2 text-right"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#1a1a1a]">
            {d.traders.map((t) => (
              <tr key={t.fullAddress} className="group transition hover:bg-white/[0.02]">
                <td className={`px-3 py-2 text-[11px] font-bold ${rankColor(t.rank)}`}>{t.rank}</td>
                <td className="px-2 py-2 font-mono text-[11px] text-white">{t.wallet}</td>
                <td className={`px-2 py-2 text-right font-mono text-[11px] font-semibold ${pnlColor(t.pnl)}`}>
                  {fmtPnl(t.pnl)}
                </td>
                <td className={`px-2 py-2 text-right font-mono text-[11px] ${winrateColor(t.winRate)}`}>
                  {t.winRate.toFixed(0)}%
                </td>
                <td className="px-2 py-2 text-right font-mono text-[10px] text-[#888]">{t.trades}</td>
                <td className="px-2 py-2 text-right font-mono text-[10px] text-[#888]">{fmtVol(t.volume)}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => ctx?.onSendMessage?.(`Analyze ${t.fullAddress}`)}
                    className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 opacity-0 transition-opacity hover:bg-emerald-500/20 group-hover:opacity-100"
                  >
                    Analyze
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CardShell>
  );
}

// ─── 9. CompareTradersCard ──────────────────────────────────────

interface CompareData {
  traders: Array<
    | { address: string; fullAddress: string; error: string }
    | {
        address: string;
        fullAddress: string;
        totalPnl: number;
        winRate: number;
        totalTrades: number;
        liquidations: number;
        totalVolume: number;
        avgPnlPerTrade: number;
        riskScore: number;
        topMarkets: string[];
      }
  >;
}

export function CompareTradersCard({ data, ctx }: { data: Json; ctx?: CardCtx }) {
  const d = data as unknown as CompareData;
  return (
    <CardShell title="Compare" badge={{ count: d.traders.length }}>
      <div className={`grid gap-2 p-3 ${d.traders.length === 2 ? "grid-cols-2" : "grid-cols-3"}`}>
        {d.traders.map((t, i) => {
          if ("error" in t && t.error) {
            return (
              <div
                key={i}
                className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400"
              >
                <div className="font-mono text-white">{t.address}</div>
                <div className="mt-1">{t.error}</div>
              </div>
            );
          }
          const ft = t as Exclude<CompareData["traders"][number], { error: string }>;
          return (
            <div
              key={i}
              className="flex flex-col gap-1.5 rounded-lg border border-[#1f1f1f] bg-[#141414] p-3"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-semibold text-white">{ft.address}</span>
                <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${riskColor(ft.riskScore)}`}>
                  R{ft.riskScore}
                </span>
              </div>
              <div className="space-y-0.5 text-[10px]">
                <div className="flex justify-between">
                  <span className="text-[#888]">PnL</span>
                  <span className={`font-mono ${pnlColor(ft.totalPnl)}`}>{fmtPnl(ft.totalPnl)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#888]">Win Rate</span>
                  <span className={`font-mono ${winrateColor(ft.winRate)}`}>{ft.winRate.toFixed(0)}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#888]">Trades</span>
                  <span className="font-mono text-gray-300">{ft.totalTrades}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#888]">Liq</span>
                  <span className={`font-mono ${ft.liquidations === 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {ft.liquidations}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#888]">Avg</span>
                  <span className={`font-mono ${pnlColor(ft.avgPnlPerTrade)}`}>{fmtPnl(ft.avgPnlPerTrade)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#888]">Volume</span>
                  <span className="font-mono text-gray-300">{fmtVol(ft.totalVolume)}</span>
                </div>
              </div>
              {ft.topMarkets && ft.topMarkets.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {ft.topMarkets.slice(0, 3).map((m) => (
                    <span
                      key={m}
                      className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] text-gray-300"
                    >
                      {m}
                    </span>
                  ))}
                </div>
              )}
              <button
                onClick={() => {
                  if (ctx?.onCopyTrader) {
                    ctx.onCopyTrader(
                      toLeaderboardEntry({
                        walletAddr: ft.fullAddress,
                        totalPnl: ft.totalPnl,
                        winRate: ft.winRate,
                        totalTrades: ft.totalTrades,
                        liquidations: ft.liquidations,
                        totalVolume: ft.totalVolume,
                        avgPnlPerTrade: ft.avgPnlPerTrade,
                      }),
                    );
                  } else {
                    ctx?.onSendMessage?.(`Copy ${ft.fullAddress} with $100`);
                  }
                }}
                className="mt-1 rounded bg-emerald-500/15 px-2 py-1 text-[10px] font-semibold text-emerald-400 hover:bg-emerald-500/25"
              >
                Copy
              </button>
            </div>
          );
        })}
      </div>
    </CardShell>
  );
}

// ─── 10. OpenCopyPositionsCard ──────────────────────────────────

interface OpenCopyPosData {
  count: number;
  positions: Array<{
    marketId: number;
    symbol: string;
    side: "Long" | "Short";
    size: number;
    entryPrice: number;
    tradingPnl: number;
    fundingPnl: number;
    totalPnl: number;
    owningLeader: string;
    fullLeaderAddr: string;
    openedAt: string;
  }>;
}

export function OpenCopyPositionsCard({ data, ctx }: { data: Json; ctx?: CardCtx }) {
  const d = data as unknown as OpenCopyPosData;
  if (d.positions.length === 0) {
    return (
      <CardShell title="Open Copy Positions" badge={{ count: 0, tone: "neutral" }}>
        <EmptyHint msg="You don't have any open copy-tracked positions right now." />
      </CardShell>
    );
  }
  return (
    <CardShell title="Open Copy Positions" badge={{ count: d.positions.length }}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[#1f1f1f] text-[10px] text-[#888]">
              <th className="px-3 py-2 text-left">Market</th>
              <th className="px-2 py-2 text-left">Side</th>
              <th className="px-2 py-2 text-right">Size</th>
              <th className="px-2 py-2 text-right">Entry</th>
              <th className="px-2 py-2 text-right">PnL</th>
              <th className="px-2 py-2 text-left">Leader</th>
              <th className="px-2 py-2 text-left hidden sm:table-cell">Opened</th>
              <th className="w-20 px-3 py-2 text-right"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#1a1a1a]">
            {d.positions.map((p) => (
              <tr key={p.marketId} className="transition hover:bg-white/[0.02]">
                <td className="px-3 py-2 font-medium text-white">{p.symbol}</td>
                <td className="px-2 py-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${
                      p.side === "Long"
                        ? "bg-emerald-500/15 text-emerald-400"
                        : "bg-red-500/15 text-red-400"
                    }`}
                  >
                    {p.side}
                  </span>
                </td>
                <td className="px-2 py-2 text-right font-mono text-[11px] text-gray-300">{fmtSize(p.size)}</td>
                <td className="px-2 py-2 text-right font-mono text-[11px] text-gray-300">{fmtPrice(p.entryPrice)}</td>
                <td className={`px-2 py-2 text-right font-mono text-[11px] font-semibold ${pnlColor(p.totalPnl)}`}>
                  {fmtPnl(p.totalPnl)}
                </td>
                <td className="px-2 py-2 font-mono text-[10px] text-[#888]">{p.owningLeader}</td>
                <td className="px-2 py-2 text-[10px] text-[#666] hidden sm:table-cell">{fmtAge(p.openedAt)}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => ctx?.onSendMessage?.(`Close my ${p.symbol} copy`)}
                    className="rounded bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-400 hover:bg-red-500/20"
                  >
                    Close
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CardShell>
  );
}

// ─── 11. CloseCopyConfirmCard ───────────────────────────────────

interface CloseCopyPreview {
  preview: true;
  marketId: number;
  symbol: string;
  side: "Long" | "Short";
  size: number;
  entryPrice: number;
  tradingPnl: number;
  fundingPnl: number;
  totalPnl: number;
  owningLeader: string;
  fullLeaderAddr: string;
}

export function CloseCopyConfirmCard({ data, ctx }: { data: Json; ctx?: CardCtx }) {
  const d = data as unknown as CloseCopyPreview;
  const handleClick = () => {
    ctx?.onOpenCloseCopyModal?.({
      marketId: d.marketId,
      symbol: d.symbol,
      side: d.side,
      size: d.size,
      entryPrice: d.entryPrice,
      tradingPnl: d.tradingPnl,
      fundingPnl: d.fundingPnl,
      owningLeader: d.owningLeader,
    });
  };
  return (
    <CardShell title="Close Copy Position">
      <div className="space-y-3 p-3">
        <div className="rounded-lg border border-[#1f1f1f] bg-[#141414] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-medium text-white">{d.symbol}</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                d.side === "Long" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
              }`}
            >
              {d.side}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <div className="flex flex-col">
              <span className="text-[9px] uppercase text-[#666]">Size</span>
              <span className="font-mono text-gray-300">{fmtSize(d.size)}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[9px] uppercase text-[#666]">Entry</span>
              <span className="font-mono text-gray-300">{fmtPrice(d.entryPrice)}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[9px] uppercase text-[#666]">PnL</span>
              <span className={`font-mono font-semibold ${pnlColor(d.totalPnl)}`}>{fmtPnl(d.totalPnl)}</span>
            </div>
          </div>
          <div className="mt-2 text-[10px] text-[#888]">
            Copied from <span className="font-mono text-gray-300">{d.owningLeader}</span>
          </div>
        </div>
        <button
          onClick={handleClick}
          className="w-full rounded-lg bg-gradient-to-r from-red-500/80 to-red-400/80 px-3 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
        >
          Open Close Dialog
        </button>
      </div>
    </CardShell>
  );
}

// ─── 12. CopyHistoryCard ────────────────────────────────────────

interface CopyHistoryData {
  total: number;
  shown: number;
  filter: { leaderAddr: string | null; status: string | null };
  trades: Array<{
    id: string;
    symbol: string;
    side: string;
    size: string | number;
    price: string | number | null;
    status: string;
    error: string | null;
    leader: string;
    fullLeaderAddr: string;
    createdAt: string;
    filledAt: string | null;
  }>;
}

function statusColor(s: string): string {
  switch (s) {
    case "filled":
      return "text-emerald-400";
    case "failed":
      return "text-red-400";
    case "skipped":
    case "cancelled":
      return "text-yellow-400";
    case "pending":
      return "text-blue-400";
    default:
      return "text-[#888]";
  }
}

export function CopyHistoryCard({ data, ctx }: { data: Json; ctx?: CardCtx }) {
  const d = data as unknown as CopyHistoryData;
  const filterLabel: string[] = [];
  if (d.filter.leaderAddr) filterLabel.push(fmtAddr(d.filter.leaderAddr));
  if (d.filter.status) filterLabel.push(d.filter.status);
  if (d.trades.length === 0) {
    return (
      <CardShell title="Copy History" badge={{ count: 0, tone: "neutral" }}>
        <EmptyHint msg="No copy trades match this filter yet." />
      </CardShell>
    );
  }
  return (
    <CardShell
      title="Copy History"
      badge={{ count: d.total }}
      rightHeader={
        <span>
          {d.shown} of {d.total}
          {filterLabel.length > 0 ? ` · ${filterLabel.join(" · ")}` : ""}
        </span>
      }
    >
      <div className="max-h-[400px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-[#0f0f0f]">
            <tr className="border-b border-[#1f1f1f] text-[10px] text-[#888]">
              <th className="px-3 py-2 text-left">When</th>
              <th className="px-2 py-2 text-left">Market</th>
              <th className="px-2 py-2 text-left">Side</th>
              <th className="px-2 py-2 text-right">Size</th>
              <th className="px-2 py-2 text-right">Price</th>
              <th className="px-2 py-2 text-left">Leader</th>
              <th className="px-2 py-2 text-left">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#1a1a1a]">
            {d.trades.map((t) => (
              <tr key={t.id} className="transition hover:bg-white/[0.02]">
                <td
                  className="px-3 py-2 text-[10px] text-[#888]"
                  title={t.createdAt}
                >
                  {fmtAge(t.createdAt)}
                </td>
                <td className="px-2 py-2 font-medium text-white">{t.symbol}</td>
                <td className="px-2 py-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${
                      t.side.toLowerCase() === "long"
                        ? "bg-emerald-500/15 text-emerald-400"
                        : "bg-red-500/15 text-red-400"
                    }`}
                  >
                    {t.side}
                  </span>
                </td>
                <td className="px-2 py-2 text-right font-mono text-[11px] text-gray-300">
                  {fmtSize(Number(t.size))}
                </td>
                <td className="px-2 py-2 text-right font-mono text-[10px] text-[#888]">
                  {t.price != null ? fmtPrice(Number(t.price)) : "—"}
                </td>
                <td className="px-2 py-2 font-mono text-[10px] text-[#888]">{t.leader}</td>
                <td className="px-2 py-2">
                  <span className={`text-[10px] font-semibold uppercase ${statusColor(t.status)}`}>
                    {t.status}
                  </span>
                  {t.error && (
                    <span
                      className="ml-1 text-[10px] text-red-400"
                      title={t.error}
                    >
                      ⚠
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-[#1f1f1f] px-3 py-2">
        <button
          onClick={() => ctx?.onSendMessage?.("Show my open copy positions")}
          className="w-full rounded-lg border border-[#262626] bg-[#141414] px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-[#1a1a1a]"
        >
          Show My Open Copies
        </button>
      </div>
    </CardShell>
  );
}
