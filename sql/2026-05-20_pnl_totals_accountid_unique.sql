-- =============================================================================
--  2026-05-20 — pnl_totals UNIQUE swap from (walletAddr) to (accountId)  [C8]
-- =============================================================================
--
--  History DB (TimescaleDB). Run with:
--    psql "$HISTORY_DATABASE_URL" -f sql/2026-05-20_pnl_totals_accountid_unique.sql
--
--  Idempotent (IF EXISTS / IF NOT EXISTS); safe to re-run.
--
--  Background:
--    pnl_totals is the leaderboard's source of truth. accountId is the
--    stable identity; walletAddr starts as 'account:<id>' placeholder and
--    flips to the real Solana pubkey when the wallet resolver finds it.
--    With the old UNIQUE on (walletAddr) the mirror table could hold BOTH
--    a placeholder row AND a real row for the same trader until
--    propagateWallet collapsed them by hand — leaderboard showed each
--    such trader twice (once with the real wallet, once as a 0-PnL
--    'account:N' ghost). Reproduced in prod 2026-04-19; original fix
--    was a one-off DELETE pass + propagateWallet's twin-cleanup loop.
--
--  This migration closes the gap at the schema level: only one row per
--  accountId can exist. Existing twins are deduped before the new index
--  is added; the recomputePnlTotals UPSERT is updated to ON CONFLICT
--  (accountId); propagateWallet collapses to a single UPDATE.
--
--  Two-step swap so the dedup invariant is never weaker than before:
--    1. Dedup rows that collide on the new key (keep newest, prefer real
--       walletAddr over placeholder).
--    2. CREATE the new (accountId) unique index alongside the old one.
--    3. DROP the old (walletAddr) unique index.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Step 1: Dedup on (accountId). Within each group, keep:
--   * placeholder rows LAST (rank order CASE returns 1 for placeholder, 0 for
--     real — ORDER BY rank ASC puts the real wallet at row_number 1).
--   * within the same wallet category, the freshest fetchedAt wins.
-- -----------------------------------------------------------------------------

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY "accountId"
           ORDER BY
             CASE WHEN "walletAddr" LIKE 'account:%' THEN 1 ELSE 0 END,
             "fetchedAt" DESC
         ) AS rn
  FROM pnl_totals
)
DELETE FROM pnl_totals
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- -----------------------------------------------------------------------------
-- Step 2: Add the new unique index. CREATE UNIQUE IF NOT EXISTS keeps the
-- migration idempotent. Alongside the old walletAddr unique for now — we drop
-- that in step 3 so the dedup guarantee is never weaker than before this run.
-- -----------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS "pnl_totals_accountid_key"
  ON pnl_totals ("accountId");

-- -----------------------------------------------------------------------------
-- Step 3: Drop the old walletAddr unique. The column stays — it's still used
-- by read-path queries that filter by wallet, and by propagateWallet to find
-- the row to rewrite. It's just no longer the table's identity.
--
-- The constraint was created by Prisma so its name follows the
-- `<table>_<column>_key` convention. DROP INDEX IF EXISTS makes the
-- statement idempotent if a prior partial run already removed it.
-- -----------------------------------------------------------------------------

ALTER TABLE pnl_totals DROP CONSTRAINT IF EXISTS "pnl_totals_walletAddr_key";
DROP INDEX IF EXISTS "pnl_totals_walletAddr_key";

COMMIT;

-- -----------------------------------------------------------------------------
-- Post-deploy sanity (run separately, no transaction):
--
--   -- Should be 0 (single row per accountId):
--   SELECT "accountId", COUNT(*)
--   FROM pnl_totals
--   GROUP BY "accountId"
--   HAVING COUNT(*) > 1;
--
--   -- Should be 0 (no placeholder ghost when a real row exists for same id):
--   SELECT p."accountId"
--   FROM pnl_totals p
--   WHERE p."walletAddr" LIKE 'account:%'
--     AND EXISTS (
--       SELECT 1 FROM pnl_totals q
--       WHERE q."accountId" = p."accountId"
--         AND q."walletAddr" NOT LIKE 'account:%'
--     );
-- -----------------------------------------------------------------------------
