import { query } from "@/lib/db-history";

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

export interface TraderProfile extends LeaderboardEntry {
  topTrades: TraderTrade[];
  marketBreakdown: MarketStat[];
  recentTrades: TraderTrade[];
}

export interface TraderTrade {
  tradeId: string;
  marketId: number;
  symbol: string;
  side: string;
  size: string;
  price: string;
  closedPnl: string;
  time: string;
}

export interface MarketStat {
  marketId: number;
  symbol: string;
  trades: number;
  pnl: number;
}

type SortField = "pnl" | "winrate" | "volume" | "trades";
type Period = "7d" | "30d" | "all";

// ─── Period filter ──────────────────────────────────────────────

const VALID_ALIASES = new Set(["pnl_history", "trade_history"]);
const VALID_COLS = new Set(["time"]);

function periodClause(period: Period, alias: string, col: string): string {
  if (period === "all") return "";
  if (!VALID_ALIASES.has(alias) || !VALID_COLS.has(col)) {
    throw new Error("Invalid period clause parameters");
  }
  const days = period === "7d" ? 7 : 30;
  return ` AND ${alias}."${col}" >= NOW() - INTERVAL '${days} days'`;
}

// ─── Leaderboard ────────────────────────────────────────────────

export async function getLeaderboard(
  period: Period = "all",
  sort: SortField = "pnl",
  limit = 50,
): Promise<LeaderboardEntry[]> {
  // Clamp limit
  const safeLimit = Math.min(Math.max(1, limit), 100);

  // For "all" period, use pre-aggregated pnl_totals (fast).
  // For time-filtered periods, aggregate from pnl_history directly.
  const useTotals = period === "all";

  const pnlSource = useTotals
    ? `SELECT "walletAddr",
              "totalPnl"::numeric AS total_pnl,
              "totalTradingPnl"::numeric AS trading_pnl,
              "totalFundingPnl"::numeric AS funding_pnl
       FROM pnl_totals`
    : `SELECT "walletAddr",
              SUM("tradingPnl" + "settledFundingPnl")::numeric AS total_pnl,
              SUM("tradingPnl")::numeric AS trading_pnl,
              SUM("settledFundingPnl")::numeric AS funding_pnl
       FROM pnl_history
       WHERE 1=1 ${periodClause(period, "pnl_history", "time")}
       GROUP BY "walletAddr"`;

  // Sort mapping — hardcoded SQL fragments, never from user input.
  // Runtime guard as defense-in-depth against future refactors.
  const SORT_MAP: Record<string, string> = {
    pnl: "pnl.total_pnl DESC",
    winrate: "win_rate DESC NULLS LAST",
    volume: "total_volume DESC",
    trades: "total_trades DESC",
  };
  const orderClause = SORT_MAP[sort];
  if (!orderClause) throw new Error("Invalid sort parameter");

  const sql = `
    WITH pnl AS (${pnlSource}),
    trade_counts AS (
      SELECT "walletAddr", COUNT(DISTINCT "tradeId")::int AS total_trades
      FROM trade_history
      WHERE 1=1 ${periodClause(period, "trade_history", "time")}
      GROUP BY "walletAddr"
    ),
    win_loss AS (
      SELECT "walletAddr",
             COUNT(*) FILTER (WHERE "tradingPnl" > 0)::int AS wins,
             COUNT(*) FILTER (WHERE "tradingPnl" < 0)::int AS losses
      FROM pnl_history
      WHERE 1=1 ${periodClause(period, "pnl_history", "time")}
      GROUP BY "walletAddr"
    ),
    liqs AS (
      SELECT "walletAddr", COUNT(*)::int AS liquidations
      FROM liquidation_history
      GROUP BY "walletAddr"
    ),
    vol AS (
      SELECT "walletAddr", COALESCE(SUM(volume), 0)::numeric AS total_volume
      FROM volume_calendar
      GROUP BY "walletAddr"
    )
    SELECT
      pnl."walletAddr" AS wallet_addr,
      pnl.total_pnl,
      pnl.trading_pnl,
      pnl.funding_pnl,
      COALESCE(tc.total_trades, 0) AS total_trades,
      COALESCE(wl.wins, 0) AS wins,
      COALESCE(wl.losses, 0) AS losses,
      CASE WHEN COALESCE(wl.wins, 0) + COALESCE(wl.losses, 0) > 0
           THEN ROUND(wl.wins::numeric / (wl.wins + wl.losses) * 100, 1)
           ELSE 0 END AS win_rate,
      CASE WHEN COALESCE(tc.total_trades, 0) > 0
           THEN ROUND(pnl.total_pnl / tc.total_trades, 4)
           ELSE 0 END AS avg_pnl_per_trade,
      COALESCE(lq.liquidations, 0) AS liquidations,
      COALESCE(v.total_volume, 0) AS total_volume
    FROM pnl
    LEFT JOIN trade_counts tc ON tc."walletAddr" = pnl."walletAddr"
    LEFT JOIN win_loss wl ON wl."walletAddr" = pnl."walletAddr"
    LEFT JOIN liqs lq ON lq."walletAddr" = pnl."walletAddr"
    LEFT JOIN vol v ON v."walletAddr" = pnl."walletAddr"
    WHERE pnl."walletAddr" NOT LIKE 'account:%'
      AND COALESCE(tc.total_trades, 0) >= 5
    ORDER BY ${orderClause}
    LIMIT $1
  `;

  const rows = await query<{
    wallet_addr: string;
    total_pnl: string;
    trading_pnl: string;
    funding_pnl: string;
    total_trades: number;
    wins: number;
    losses: number;
    win_rate: string;
    avg_pnl_per_trade: string;
    liquidations: number;
    total_volume: string;
  }>(sql, [safeLimit]);

  return rows.map((r) => ({
    walletAddr: r.wallet_addr,
    totalPnl: parseFloat(r.total_pnl) || 0,
    tradingPnl: parseFloat(r.trading_pnl) || 0,
    fundingPnl: parseFloat(r.funding_pnl) || 0,
    totalTrades: r.total_trades,
    wins: r.wins,
    losses: r.losses,
    winRate: parseFloat(r.win_rate) || 0,
    avgPnlPerTrade: parseFloat(r.avg_pnl_per_trade) || 0,
    liquidations: r.liquidations,
    totalVolume: parseFloat(r.total_volume) || 0,
  }));
}

// ─── Trader Profile ─────────────────────────────────────────────

export async function getTraderProfile(walletAddr: string): Promise<TraderProfile | null> {
  // 1. Get leaderboard entry for this trader
  const entries = await getLeaderboard("all", "pnl", 1);
  // Re-query specifically for this wallet
  const statsRows = await query<{
    total_pnl: string;
    trading_pnl: string;
    funding_pnl: string;
  }>(
    `SELECT "totalPnl"::numeric AS total_pnl,
            "totalTradingPnl"::numeric AS trading_pnl,
            "totalFundingPnl"::numeric AS funding_pnl
     FROM pnl_totals WHERE "walletAddr" = $1`,
    [walletAddr],
  );

  if (statsRows.length === 0) return null;

  const tradeCountRows = await query<{ total_trades: number; wins: number; losses: number }>(
    `SELECT
       (SELECT COUNT(DISTINCT "tradeId")::int FROM trade_history WHERE "walletAddr" = $1) AS total_trades,
       (SELECT COUNT(*)::int FROM pnl_history WHERE "walletAddr" = $1 AND "tradingPnl" > 0) AS wins,
       (SELECT COUNT(*)::int FROM pnl_history WHERE "walletAddr" = $1 AND "tradingPnl" < 0) AS losses`,
    [walletAddr],
  );

  const liqRows = await query<{ liquidations: number }>(
    `SELECT COUNT(*)::int AS liquidations FROM liquidation_history WHERE "walletAddr" = $1`,
    [walletAddr],
  );

  const volRows = await query<{ total_volume: string }>(
    `SELECT COALESCE(SUM(volume), 0)::numeric AS total_volume FROM volume_calendar WHERE "walletAddr" = $1`,
    [walletAddr],
  );

  const stats = statsRows[0];
  const tc = tradeCountRows[0] ?? { total_trades: 0, wins: 0, losses: 0 };
  const totalPnl = parseFloat(stats.total_pnl) || 0;
  const totalTrades = tc.total_trades;
  const wins = tc.wins;
  const losses = tc.losses;

  const entry: LeaderboardEntry = {
    walletAddr,
    totalPnl,
    tradingPnl: parseFloat(stats.trading_pnl) || 0,
    fundingPnl: parseFloat(stats.funding_pnl) || 0,
    totalTrades,
    wins,
    losses,
    winRate: wins + losses > 0 ? Math.round((wins / (wins + losses)) * 1000) / 10 : 0,
    avgPnlPerTrade: totalTrades > 0 ? Math.round((totalPnl / totalTrades) * 10000) / 10000 : 0,
    liquidations: liqRows[0]?.liquidations ?? 0,
    totalVolume: parseFloat(volRows[0]?.total_volume ?? "0") || 0,
  };

  // 2. Top trades by closedPnl (uses recursive CTE from queries.ts pattern)
  const topTrades = await getTraderTopTrades(walletAddr, 10);

  // 3. Market breakdown
  const marketBreakdown = await getTraderMarketBreakdown(walletAddr);

  // 4. Recent trades (last 5)
  const recentTrades = await getRecentTrades(walletAddr, 5);

  return { ...entry, topTrades, marketBreakdown, recentTrades };
}

// ─── Top Trades by Closed PnL ───────────────────────────────────

async function getTraderTopTrades(walletAddr: string, limit: number): Promise<TraderTrade[]> {
  // Get markets that have trades for this wallet
  const marketRows = await query<{ marketId: number }>(
    `SELECT DISTINCT "marketId" FROM trade_history WHERE "walletAddr" = $1`,
    [walletAddr],
  );

  if (marketRows.length === 0) return [];

  // For each market, compute PnL via recursive CTE, collect all, sort by |pnl|
  const allPnl: TraderTrade[] = [];

  for (const { marketId } of marketRows) {
    const rows = await query<{
      tradeId: string; symbol: string; side: string; size: string;
      price: string; closedPnl: string; time: Date;
    }>(
      `WITH RECURSIVE
       numbered AS MATERIALIZED (
         SELECT "tradeId", side, price::numeric AS price, size::numeric AS size,
                symbol, "time",
                (CASE WHEN side = 'Long' THEN size ELSE -size END)::numeric AS delta,
                ROW_NUMBER() OVER (ORDER BY "time" ASC, CAST("tradeId" AS bigint) ASC) AS rn
         FROM trade_history
         WHERE "walletAddr" = $1 AND "marketId" = $2 AND size > 0 AND price > 0
       ),
       tracker AS (
         SELECT n."tradeId", n.symbol, n.side, n.size::text AS size, n.price::text AS price,
                n."time", n.delta AS pos_after, n.price AS avg_entry,
                0::numeric AS closed_pnl, n.rn
         FROM numbered n WHERE n.rn = 1
         UNION ALL
         SELECT n."tradeId", n.symbol, n.side, n.size::text, n.price::text, n."time",
           CASE WHEN t.pos_after = 0 OR SIGN(n.delta) = SIGN(t.pos_after)
                THEN t.pos_after + n.delta
                WHEN ABS(n.delta) > ABS(t.pos_after) THEN n.delta + t.pos_after
                ELSE t.pos_after + n.delta END,
           CASE WHEN t.pos_after = 0 THEN n.price
                WHEN SIGN(n.delta) = SIGN(t.pos_after)
                THEN (t.avg_entry * t.pos_after + n.price * n.delta) / (t.pos_after + n.delta)
                WHEN ABS(n.delta) > ABS(t.pos_after) THEN n.price
                WHEN t.pos_after + n.delta = 0 THEN 0::numeric
                ELSE t.avg_entry END,
           CASE WHEN t.pos_after = 0 OR SIGN(n.delta) = SIGN(t.pos_after) THEN 0::numeric
                ELSE (n.price - t.avg_entry) * LEAST(ABS(n.delta), ABS(t.pos_after)) * SIGN(t.pos_after) END,
           n.rn
         FROM numbered n JOIN tracker t ON n.rn = t.rn + 1
       )
       SELECT "tradeId", symbol, side, size, price,
              closed_pnl::text AS "closedPnl", "time"
       FROM tracker WHERE ABS(closed_pnl) > 0.0001
       ORDER BY ABS(closed_pnl) DESC LIMIT $3`,
      [walletAddr, marketId, limit],
    );

    for (const r of rows) {
      allPnl.push({
        tradeId: r.tradeId,
        marketId,
        symbol: r.symbol,
        side: r.side,
        size: r.size,
        price: r.price,
        closedPnl: r.closedPnl,
        time: new Date(r.time).toISOString(),
      });
    }
  }

  // Sort all trades across markets by |pnl| descending, take top N
  return allPnl
    .sort((a, b) => Math.abs(parseFloat(b.closedPnl)) - Math.abs(parseFloat(a.closedPnl)))
    .slice(0, limit);
}

// ─── Market Breakdown ───────────────────────────────────────────

async function getTraderMarketBreakdown(walletAddr: string): Promise<MarketStat[]> {
  const rows = await query<{
    market_id: number; symbol: string; trades: number; pnl: string;
  }>(
    `SELECT t."marketId" AS market_id,
            t.symbol,
            COUNT(DISTINCT t."tradeId")::int AS trades,
            COALESCE(SUM(p."tradingPnl"), 0)::numeric::text AS pnl
     FROM trade_history t
     LEFT JOIN pnl_history p ON p."walletAddr" = t."walletAddr" AND p."marketId" = t."marketId"
     WHERE t."walletAddr" = $1
     GROUP BY t."marketId", t.symbol
     ORDER BY trades DESC`,
    [walletAddr],
  );

  return rows.map((r) => ({
    marketId: r.market_id,
    symbol: r.symbol,
    trades: r.trades,
    pnl: parseFloat(r.pnl) || 0,
  }));
}

// ─── Recent Trades ──────────────────────────────────────────────

async function getRecentTrades(walletAddr: string, limit: number): Promise<TraderTrade[]> {
  const rows = await query<{
    tradeId: string; marketId: number; symbol: string; side: string;
    size: string; price: string; time: Date;
  }>(
    `SELECT "tradeId", "marketId", symbol, side, size::text, price::text, "time"
     FROM trade_history
     WHERE "walletAddr" = $1
     ORDER BY "time" DESC LIMIT $2`,
    [walletAddr, limit],
  );

  return rows.map((r) => ({
    tradeId: r.tradeId,
    marketId: r.marketId,
    symbol: r.symbol,
    side: r.side,
    size: r.size,
    price: r.price,
    closedPnl: "0",
    time: new Date(r.time).toISOString(),
  }));
}
