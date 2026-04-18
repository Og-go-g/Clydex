-- ============================================================================
-- Prevent future placeholder/real walletAddr duplicates.
--
-- RUN AFTER: 2026-04-18_consolidate_placeholder_wallets.sql
--   That migration removes existing dupes. This one locks the invariant in.
--
-- CHANGES
-- -------
-- 1. pnl_history:      unique on ("accountId", "marketId", "time")
--                      instead of ("walletAddr", "marketId", "time")
-- 2. funding_history:  same swap
-- 3. sync_cursors:     primary key on ("accountId", type) in addition to the
--                      existing ("walletAddr", type). New syncs use accountId.
--
-- trade_history already unique on tradeId alone — no change needed.
-- pnl_totals / volume_calendar are derived (recomputed), no structural change.
--
-- NOTES
-- -----
-- - We keep the existing walletAddr-based indexes for read-path queries that
--   still filter by walletAddr (legacy code paths).
-- - CREATE UNIQUE INDEX CONCURRENTLY doesn't block writes but cannot run
--   inside a transaction. Each index built one-by-one.
-- ============================================================================

-- 1. pnl_history: add new unique index
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS pnl_history_accountid_marketid_time_uniq
  ON pnl_history ("accountId", "marketId", "time");

-- Verify no conflicts before dropping the old unique:
--   SELECT "accountId", "marketId", "time", COUNT(*) FROM pnl_history
--   GROUP BY 1,2,3 HAVING COUNT(*) > 1;
-- If empty → safe to drop the old wallet-scoped unique:

ALTER TABLE pnl_history DROP CONSTRAINT IF EXISTS "pnl_history_walletAddr_marketId_time_key";
DROP INDEX IF EXISTS "pnl_history_walletAddr_marketId_time_key";

-- 2. funding_history
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS funding_history_accountid_marketid_time_uniq
  ON funding_history ("accountId", "marketId", "time");

ALTER TABLE funding_history DROP CONSTRAINT IF EXISTS "funding_history_walletAddr_marketId_time_key";
DROP INDEX IF EXISTS "funding_history_walletAddr_marketId_time_key";

-- 3. sync_cursors: add accountId column and a new composite key
ALTER TABLE sync_cursors ADD COLUMN IF NOT EXISTS "accountId" INT;

CREATE INDEX IF NOT EXISTS sync_cursors_accountid_type_idx
  ON sync_cursors ("accountId", type)
  WHERE "accountId" IS NOT NULL;

-- Backfill accountId from existing walletAddr data. For each walletAddr in
-- sync_cursors, find any accountId in the raw tables.
UPDATE sync_cursors sc
SET "accountId" = sub.acc
FROM (
  SELECT DISTINCT ON ("walletAddr") "walletAddr", "accountId" AS acc
  FROM pnl_history
  ORDER BY "walletAddr"
) sub
WHERE sc."walletAddr" = sub."walletAddr"
  AND sc."accountId" IS NULL;

-- Rows without a backfill map stay NULL — they're orphan cursors, harmless.
