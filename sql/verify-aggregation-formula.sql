-- ============================================================================
-- Verify which funding-accounting model matches 01.xyz ground truth.
--
-- Before dropping the Vercel frontend API, we need to be sure our local
-- aggregation from pnl_history + funding_history reproduces exactly what
-- 01.xyz returned in pnl_totals. Run this against any account that was
-- successfully synced recently (fetchedAt within last 14 days).
--
-- IMPORTANT — row-level dedup is applied inline:
--   Both pnl_history and funding_history contain duplicate rows per event
--   (placeholder 'account:<id>' walletAddr + real-resolved walletAddr, same
--   marketId + time). A raw SUM double-counts. DISTINCT ON (accountId,
--   marketId, time) ORDER BY ... preference for real wallets collapses
--   duplicates the same way aggregate.ts does at runtime.
--
-- Three hypotheses for totalFundingPnl:
--   A) BOTH               — SUM(pnl_history.settledFundingPnl) + SUM(funding_history.fundingPnl)
--   B) PNL-ONLY           — SUM(pnl_history.settledFundingPnl)
--   C) FUNDING-ONLY       — SUM(funding_history.fundingPnl)
--
-- The "correct" model is the one whose `mae_*` is ~0 across the sample.
-- Pick that model and set PNL_FUNDING_MODEL=<both|pnl-only|funding-only>
-- in .env.
--
-- Usage:
--   psql -d clydex_history -f sql/verify-aggregation-formula.sql
-- ============================================================================

\pset pager off
\timing on

-- ────────────────────────────────────────────────────────────────────────────
-- Per-account breakdown.
-- ────────────────────────────────────────────────────────────────────────────
WITH refs AS (
  SELECT "accountId", "walletAddr",
         "totalPnl"::numeric        AS v_total,
         "totalTradingPnl"::numeric AS v_trading,
         "totalFundingPnl"::numeric AS v_funding,
         "fetchedAt"
  FROM pnl_totals
  WHERE "walletAddr" NOT LIKE 'account:%'
    AND "fetchedAt" > NOW() - INTERVAL '14 days'
  ORDER BY ABS("totalPnl"::numeric) DESC
  LIMIT 50
),
-- Dedupe pnl_history: one row per (accountId, marketId, time), prefer real wallet.
pnl_dedup AS (
  SELECT DISTINCT ON ("accountId", "marketId", "time")
         "accountId",
         "tradingPnl"::numeric        AS trading_pnl,
         "settledFundingPnl"::numeric AS settled_funding
  FROM pnl_history
  WHERE "accountId" IN (SELECT "accountId" FROM refs)
  ORDER BY "accountId", "marketId", "time",
           (CASE WHEN "walletAddr" LIKE 'account:%' THEN 1 ELSE 0 END)
),
pnl_agg AS (
  SELECT "accountId",
         SUM(trading_pnl)::numeric    AS sum_trading,
         SUM(settled_funding)::numeric AS sum_settled_funding
  FROM pnl_dedup
  GROUP BY "accountId"
),
fund_dedup AS (
  SELECT DISTINCT ON ("accountId", "marketId", "time")
         "accountId",
         "fundingPnl"::numeric AS funding_pnl
  FROM funding_history
  WHERE "accountId" IN (SELECT "accountId" FROM refs)
  ORDER BY "accountId", "marketId", "time",
           (CASE WHEN "walletAddr" LIKE 'account:%' THEN 1 ELSE 0 END)
),
fund_agg AS (
  SELECT "accountId",
         SUM(funding_pnl)::numeric AS sum_standalone_funding
  FROM fund_dedup
  GROUP BY "accountId"
),
joined AS (
  SELECT r.*,
         COALESCE(p.sum_trading, 0)            AS sum_trading,
         COALESCE(p.sum_settled_funding, 0)    AS sum_settled_funding,
         COALESCE(f.sum_standalone_funding, 0) AS sum_standalone_funding
  FROM refs r
  LEFT JOIN pnl_agg  p ON p."accountId" = r."accountId"
  LEFT JOIN fund_agg f ON f."accountId" = r."accountId"
)
SELECT
  "accountId",
  ROUND(v_trading, 2)                                       AS v_trading,
  ROUND(sum_trading, 2)                                     AS local_trading,
  ROUND(v_trading - sum_trading, 4)                         AS trading_diff,
  '|'                                                       AS "|",
  ROUND(v_funding, 2)                                       AS v_funding,
  ROUND(sum_settled_funding + sum_standalone_funding, 2)    AS model_A_both,
  ROUND(v_funding - (sum_settled_funding + sum_standalone_funding), 4) AS diff_A,
  ROUND(sum_settled_funding, 2)                             AS model_B_pnl,
  ROUND(v_funding - sum_settled_funding, 4)                 AS diff_B,
  ROUND(sum_standalone_funding, 2)                          AS model_C_fund,
  ROUND(v_funding - sum_standalone_funding, 4)              AS diff_C
FROM joined
ORDER BY ABS(v_total) DESC;

-- ────────────────────────────────────────────────────────────────────────────
-- Summary verdict — which model wins on aggregate error?
-- ────────────────────────────────────────────────────────────────────────────
WITH refs AS (
  SELECT "accountId",
         "totalTradingPnl"::numeric AS v_trading,
         "totalFundingPnl"::numeric AS v_funding
  FROM pnl_totals
  WHERE "walletAddr" NOT LIKE 'account:%'
    AND "fetchedAt" > NOW() - INTERVAL '14 days'
),
pnl_dedup AS (
  SELECT DISTINCT ON ("accountId", "marketId", "time")
         "accountId",
         "tradingPnl"::numeric        AS trading_pnl,
         "settledFundingPnl"::numeric AS settled_funding
  FROM pnl_history
  WHERE "accountId" IN (SELECT "accountId" FROM refs)
  ORDER BY "accountId", "marketId", "time",
           (CASE WHEN "walletAddr" LIKE 'account:%' THEN 1 ELSE 0 END)
),
pnl_agg AS (
  SELECT "accountId",
         SUM(trading_pnl)::numeric    AS sum_trading,
         SUM(settled_funding)::numeric AS sum_settled_funding
  FROM pnl_dedup
  GROUP BY "accountId"
),
fund_dedup AS (
  SELECT DISTINCT ON ("accountId", "marketId", "time")
         "accountId",
         "fundingPnl"::numeric AS funding_pnl
  FROM funding_history
  WHERE "accountId" IN (SELECT "accountId" FROM refs)
  ORDER BY "accountId", "marketId", "time",
           (CASE WHEN "walletAddr" LIKE 'account:%' THEN 1 ELSE 0 END)
),
fund_agg AS (
  SELECT "accountId",
         SUM(funding_pnl)::numeric AS sum_standalone_funding
  FROM fund_dedup
  GROUP BY "accountId"
),
joined AS (
  SELECT r.*,
         COALESCE(p.sum_trading, 0)            AS sum_trading,
         COALESCE(p.sum_settled_funding, 0)    AS sum_settled_funding,
         COALESCE(f.sum_standalone_funding, 0) AS sum_standalone_funding
  FROM refs r
  LEFT JOIN pnl_agg  p ON p."accountId" = r."accountId"
  LEFT JOIN fund_agg f ON f."accountId" = r."accountId"
)
SELECT
  COUNT(*)                                                                            AS sampled,
  ROUND(AVG(ABS(v_trading - sum_trading)), 4)                                         AS mae_trading,
  ROUND(AVG(ABS(v_funding - (sum_settled_funding + sum_standalone_funding))), 4)      AS mae_A_both,
  ROUND(AVG(ABS(v_funding - sum_settled_funding)), 4)                                 AS mae_B_pnl,
  ROUND(AVG(ABS(v_funding - sum_standalone_funding)), 4)                              AS mae_C_fund,
  ROUND(MAX(ABS(v_funding - (sum_settled_funding + sum_standalone_funding))), 4)      AS max_A_both,
  ROUND(MAX(ABS(v_funding - sum_settled_funding)), 4)                                 AS max_B_pnl,
  ROUND(MAX(ABS(v_funding - sum_standalone_funding)), 4)                              AS max_C_fund
FROM joined;
