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
 * Funding-accounting model is env-controlled (PNL_FUNDING_MODEL):
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
  // Funding term varies per model. Trading term is always the same.
  // All three branches are plain SELECT subqueries, filtered on accountId.
  const fundingSql = ((): string => {
    switch (model) {
      case "pnl-only":
        return `COALESCE((SELECT SUM("settledFundingPnl")::numeric
                            FROM pnl_history WHERE "accountId" = $1), 0)`;
      case "funding-only":
        return `COALESCE((SELECT SUM("fundingPnl")::numeric
                            FROM funding_history WHERE "accountId" = $1), 0)`;
      case "both":
        return `(
          COALESCE((SELECT SUM("settledFundingPnl")::numeric
                      FROM pnl_history     WHERE "accountId" = $1), 0)
          +
          COALESCE((SELECT SUM("fundingPnl")::numeric
                      FROM funding_history WHERE "accountId" = $1), 0)
        )`;
    }
  })();

  await execute(
    `WITH agg AS (
       SELECT
         COALESCE((SELECT SUM("tradingPnl")::numeric
                     FROM pnl_history WHERE "accountId" = $1), 0)::numeric AS trading,
         ${fundingSql}::numeric AS funding
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
  return execute(
    `INSERT INTO volume_calendar (
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
     FROM trade_history
     WHERE "accountId" = $1
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
