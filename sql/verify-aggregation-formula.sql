-- ============================================================================
-- Verify which funding-accounting model matches 01.xyz ground truth.
--
-- Before dropping the Vercel frontend API, we need to be sure our local
-- aggregation from pnl_history + funding_history reproduces exactly what
-- 01.xyz returned in pnl_totals. Run this against any account that was
-- successfully synced recently (fetchedAt within last 7 days).
--
-- Three hypotheses for totalFundingPnl:
--   A) BOTH               — SUM(pnl_history.settledFundingPnl) + SUM(funding_history.fundingPnl)
--   B) PNL-ONLY           — SUM(pnl_history.settledFundingPnl)
--   C) FUNDING-ONLY       — SUM(funding_history.fundingPnl)
--
-- The "correct" model is the one whose `diff_*` column is ~0 across the
-- board (allow tiny rounding jitter on the order of 1e-6). Pick that model
-- and set PNL_FUNDING_MODEL=<both|pnl-only|funding-only> in .env.
--
-- Usage:
--   psql -d clydex_history -f sql/verify-aggregation-formula.sql
-- ============================================================================

WITH refs AS (
  SELECT "accountId", "walletAddr",
         "totalPnl"::numeric        AS vercel_total,
         "totalTradingPnl"::numeric AS vercel_trading,
         "totalFundingPnl"::numeric AS vercel_funding,
         "fetchedAt"
  FROM pnl_totals
  WHERE "walletAddr" NOT LIKE 'account:%'
    AND "fetchedAt" > NOW() - INTERVAL '14 days'
  -- Big enough sample, small enough to read:
  ORDER BY ABS("totalPnl"::numeric) DESC
  LIMIT 50
),
local AS (
  SELECT r."accountId",
         r.vercel_total,
         r.vercel_trading,
         r.vercel_funding,
         COALESCE((SELECT SUM("tradingPnl")::numeric
                     FROM pnl_history     WHERE "accountId" = r."accountId"), 0) AS sum_trading,
         COALESCE((SELECT SUM("settledFundingPnl")::numeric
                     FROM pnl_history     WHERE "accountId" = r."accountId"), 0) AS sum_settled_funding,
         COALESCE((SELECT SUM("fundingPnl")::numeric
                     FROM funding_history WHERE "accountId" = r."accountId"), 0) AS sum_standalone_funding
  FROM refs r
)
SELECT
  "accountId",
  ROUND(vercel_trading, 2)                            AS vercel_trading,
  ROUND(sum_trading, 2)                               AS local_trading,
  ROUND(vercel_trading - sum_trading, 4)              AS trading_diff,
  '|'                                                 AS "|",
  ROUND(vercel_funding, 2)                            AS vercel_funding,
  ROUND(sum_settled_funding + sum_standalone_funding, 2) AS model_A_both,
  ROUND(vercel_funding - (sum_settled_funding + sum_standalone_funding), 4) AS diff_A,
  ROUND(sum_settled_funding, 2)                       AS model_B_pnl_only,
  ROUND(vercel_funding - sum_settled_funding, 4)      AS diff_B,
  ROUND(sum_standalone_funding, 2)                    AS model_C_funding_only,
  ROUND(vercel_funding - sum_standalone_funding, 4)   AS diff_C
FROM local
ORDER BY ABS(vercel_funding) DESC;

-- ────────────────────────────────────────────────────────────────────────────
-- Summary verdict — which model wins on aggregate squared error?
-- ────────────────────────────────────────────────────────────────────────────
WITH refs AS (
  SELECT "accountId",
         "totalTradingPnl"::numeric AS vercel_trading,
         "totalFundingPnl"::numeric AS vercel_funding
  FROM pnl_totals
  WHERE "walletAddr" NOT LIKE 'account:%'
    AND "fetchedAt" > NOW() - INTERVAL '14 days'
),
local AS (
  SELECT r."accountId",
         r.vercel_trading,
         r.vercel_funding,
         COALESCE((SELECT SUM("tradingPnl")::numeric
                     FROM pnl_history     WHERE "accountId" = r."accountId"), 0) AS sum_trading,
         COALESCE((SELECT SUM("settledFundingPnl")::numeric
                     FROM pnl_history     WHERE "accountId" = r."accountId"), 0) AS sum_settled_funding,
         COALESCE((SELECT SUM("fundingPnl")::numeric
                     FROM funding_history WHERE "accountId" = r."accountId"), 0) AS sum_standalone_funding
  FROM refs r
)
SELECT
  COUNT(*)                                                                       AS sampled_accounts,
  ROUND(AVG(ABS(vercel_trading - sum_trading)), 4)                               AS mae_trading,
  ROUND(AVG(ABS(vercel_funding - (sum_settled_funding + sum_standalone_funding))), 4) AS mae_funding_A_both,
  ROUND(AVG(ABS(vercel_funding - sum_settled_funding)), 4)                       AS mae_funding_B_pnl,
  ROUND(AVG(ABS(vercel_funding - sum_standalone_funding)), 4)                    AS mae_funding_C_fund,
  ROUND(MAX(ABS(vercel_funding - (sum_settled_funding + sum_standalone_funding))), 4) AS max_abs_A_both,
  ROUND(MAX(ABS(vercel_funding - sum_settled_funding)), 4)                       AS max_abs_B_pnl,
  ROUND(MAX(ABS(vercel_funding - sum_standalone_funding)), 4)                    AS max_abs_C_fund
FROM local;
