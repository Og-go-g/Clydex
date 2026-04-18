/**
 * Aggregate raw history data into pnl_totals and volume_calendar.
 *
 * These two tables used to be populated from 01.xyz frontend API
 * (https://01.xyz/api/pnl-totals/:id, /api/volume-calendar/:id) — but that
 * endpoint sits behind Vercel's WAF JavaScript challenge and rejects
 * automated clients. Both outputs are pure aggregations over raw data
 * we already sync from mainnet-backend.01.xyz, so we rebuild them locally.
 *
 * Numbers match 01.xyz exactly as long as the raw tables (trade_history,
 * pnl_history, funding_history) are current. Call recomputeAggregates()
 * immediately after a successful sync cycle.
 *
 * ─── Duplicate-row handling ─────────────────────────────────────────
 *
 * History tables contain duplicate rows per logical event: one inserted
 * when the account was first seen via placeholder walletAddr 'account:<id>',
 * a second when sync later resolved the real Solana address. The unique
 * constraint is on (walletAddr, marketId, time) — different walletAddr for
 * the same event bypasses it.
 *
 * We dedupe inline via DISTINCT ON (accountId, marketId, time), preferring
 * rows with a real walletAddr so newer/more-complete fills win. This keeps
 * totals correct without mutating storage; an async cleanup migration will
 * eventually drop placeholder rows where a real one exists.
 *
 * ─── Funding accounting ─────────────────────────────────────────────
 *
 * Env-controlled via PNL_FUNDING_MODEL:
 *   - "pnl-only"      — totalFundingPnl = SUM(pnl_history.settledFundingPnl)   [default]
 *   - "funding-only"  — totalFundingPnl = SUM(funding_history.fundingPnl)
 *   - "both"          — totalFundingPnl = SUM of both (use only if 01.xyz double-counts)
 *
 * Run sql/verify-aggregation-formula.sql before deploying to pick the right
 * model — it compares all three against ground-truth pnl_totals rows that
 * were fetched from Vercel before the WAF started blocking us.
 */

import { execute } from "@/lib/db-history";

export type FundingModel = "pnl-only" | "funding-only" | "both";

const VALID_MODELS: ReadonlySet<FundingModel> = new Set(["pnl-only", "funding-only", "both"]);

export function getFundingModel(): FundingModel {
  const raw = (process.env.PNL_FUNDING_MODEL ?? "pnl-only").toLowerCase();
  return VALID_MODELS.has(raw as FundingModel) ? (raw as FundingModel) : "pnl-only";
}

// ─── pnl_totals ────────────────────────────────────────────────────

/**
 * Rebuild pnl_totals row for a single account from pnl_history + funding_history.
 *
 * The aggregation always filters by accountId (stable across wallet linking),
 * but writes the row keyed on the wallet address supplied by the caller.
 * That matches the upstream schema where pnl_totals."walletAddr" is UNIQUE.
 *
 * Idempotent: ON CONFLICT ("walletAddr") DO UPDATE.
 */
export async function recomputePnlTotals(
  accountId: number,
  walletAddr: string,
  model: FundingModel = getFundingModel(),
): Promise<void> {
  // Dedupe rule (same for all CTEs below): DISTINCT ON (accountId, marketId, time)
  // with ORDER BY preferring real walletAddr over 'account:%' placeholder.
  // This collapses duplicate rows that entered the table before the
  // accountId→real-wallet mapping was resolved.

  // CTEs hold trading + settled-funding pulled from deduped pnl_history
  // and optional standalone funding pulled from deduped funding_history.
  // The final INSERT picks a different funding term per model.
  const fundingExpr = ((): string => {
    switch (model) {
      case "pnl-only":
        return `COALESCE(pnl.settled, 0)`;
      case "funding-only":
        return `COALESCE(fund.standalone, 0)`;
      case "both":
        return `COALESCE(pnl.settled, 0) + COALESCE(fund.standalone, 0)`;
    }
  })();

  await execute(
    `WITH pnl_dedup AS (
       SELECT DISTINCT ON ("accountId", "marketId", "time")
              "tradingPnl"::numeric        AS trading_pnl,
              "settledFundingPnl"::numeric AS settled_funding
       FROM pnl_history
       WHERE "accountId" = $1
       ORDER BY "accountId", "marketId", "time",
                (CASE WHEN "walletAddr" LIKE 'account:%' THEN 1 ELSE 0 END)
     ),
     pnl AS (
       SELECT SUM(trading_pnl)::numeric   AS trading,
              SUM(settled_funding)::numeric AS settled
       FROM pnl_dedup
     ),
     fund_dedup AS (
       SELECT DISTINCT ON ("accountId", "marketId", "time")
              "fundingPnl"::numeric AS funding_pnl
       FROM funding_history
       WHERE "accountId" = $1
       ORDER BY "accountId", "marketId", "time",
                (CASE WHEN "walletAddr" LIKE 'account:%' THEN 1 ELSE 0 END)
     ),
     fund AS (
       SELECT SUM(funding_pnl)::numeric AS standalone FROM fund_dedup
     ),
     agg AS (
       SELECT COALESCE(pnl.trading, 0)::numeric AS trading,
              (${fundingExpr})::numeric         AS funding
       FROM pnl LEFT JOIN fund ON TRUE
     )
     INSERT INTO pnl_totals (
       id, "accountId", "walletAddr",
       "totalPnl", "totalTradingPnl", "totalFundingPnl", "fetchedAt"
     )
     SELECT gen_random_uuid(), $1::int, $2::text,
            trading + funding, trading, funding, NOW()
     FROM agg
     ON CONFLICT ("walletAddr") DO UPDATE SET
       "accountId"       = EXCLUDED."accountId",
       "totalPnl"        = EXCLUDED."totalPnl",
       "totalTradingPnl" = EXCLUDED."totalTradingPnl",
       "totalFundingPnl" = EXCLUDED."totalFundingPnl",
       "fetchedAt"       = EXCLUDED."fetchedAt"`,
    [accountId, walletAddr],
  );
}

// ─── volume_calendar ───────────────────────────────────────────────

/**
 * Rebuild volume_calendar rows for a single account from trade_history.
 *
 * One row per (walletAddr, date). Uses FILTER () clauses to split maker
 * vs taker. Idempotent — existing days upsert, new days insert.
 *
 * Note: trade_history has UNIQUE(tradeId), so if account A and account B
 * were opposite sides of the same trade we only keep the row for whichever
 * was synced first. In practice retail traders face market makers (not
 * synced), so this is a non-issue. Tracked as follow-up if it ever shows up.
 *
 * Returns number of days written (for logging).
 */
export async function recomputeVolumeCalendar(
  accountId: number,
  walletAddr: string,
): Promise<number> {
  // DISTINCT ON (tradeId, role) dedupes placeholder+real rows the same way
  // recomputePnlTotals does for (marketId, time). Role is part of the key
  // because the same tradeId legitimately appears twice when both taker
  // and maker sides of a trade are tracked.
  return execute(
    `WITH dedup AS (
       SELECT DISTINCT ON ("tradeId", role)
              "time", size, price, role, fee
       FROM trade_history
       WHERE "accountId" = $1
       ORDER BY "tradeId", role,
                (CASE WHEN "walletAddr" LIKE 'account:%' THEN 1 ELSE 0 END)
     )
     INSERT INTO volume_calendar (
       id, "accountId", "walletAddr", date,
       volume, "makerVolume", "takerVolume",
       "makerFees", "takerFees", "totalFees"
     )
     SELECT
       gen_random_uuid(),
       $1::int,
       $2::text,
       to_char(date_trunc('day', "time"), 'YYYY-MM-DD')                             AS date,
       COALESCE(SUM(size::numeric * price::numeric), 0)                             AS volume,
       COALESCE(SUM(size::numeric * price::numeric) FILTER (WHERE role = 'maker'), 0) AS maker_volume,
       COALESCE(SUM(size::numeric * price::numeric) FILTER (WHERE role = 'taker'), 0) AS taker_volume,
       COALESCE(SUM(fee::numeric)                   FILTER (WHERE role = 'maker'), 0) AS maker_fees,
       COALESCE(SUM(fee::numeric)                   FILTER (WHERE role = 'taker'), 0) AS taker_fees,
       COALESCE(SUM(fee::numeric), 0)                                               AS total_fees
     FROM dedup
     GROUP BY date_trunc('day', "time")
     ON CONFLICT ("walletAddr", date) DO UPDATE SET
       "accountId"   = EXCLUDED."accountId",
       volume        = EXCLUDED.volume,
       "makerVolume" = EXCLUDED."makerVolume",
       "takerVolume" = EXCLUDED."takerVolume",
       "makerFees"   = EXCLUDED."makerFees",
       "takerFees"   = EXCLUDED."takerFees",
       "totalFees"   = EXCLUDED."totalFees"`,
    [accountId, walletAddr],
  );
}

// ─── Combined ──────────────────────────────────────────────────────

export interface AggregateResult {
  /** Days written/updated in volume_calendar. */
  volumeDays: number;
}

/**
 * Recompute both pnl_totals and volume_calendar for one account.
 * Safe to call after every sync; all-or-nothing not required (each
 * write is idempotent on its own unique key).
 */
export async function recomputeAggregates(
  accountId: number,
  walletAddr: string,
): Promise<AggregateResult> {
  const volumeDays = await recomputeVolumeCalendar(accountId, walletAddr);
  await recomputePnlTotals(accountId, walletAddr);
  return { volumeDays };
}
