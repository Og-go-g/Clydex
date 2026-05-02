-- ============================================================================
-- Phase 8c — two-sided trade_history.
--
-- THE BUG
-- -------
-- trade_history has UNIQUE (tradeId, time). Every trade on 01 has TWO
-- participants (taker + maker), but this constraint allowed only ONE row
-- per trade. With sync_taker/sync_maker both calling
--   INSERT ... ON CONFLICT DO NOTHING
-- whoever synced first won; the other side was silently discarded. Tier-1
-- cron syncs all top-500 MM accounts every 30 min, so any retail user
-- trading against any active MM had their trades vanish from their own
-- portfolio view.
--
-- Confirmed via diagnostic on 2026-05-02:
--   SELECT COUNT(DISTINCT "tradeId"), COUNT(*) FROM trade_history;
--   → 10,151,084 / 10,151,084   (zero two-sided rows in 14 months of data)
--
-- THE FIX
-- -------
-- UNIQUE moves to (accountId, tradeId, time). Each participant gets their
-- own row, with their own walletAddr / side / role. Existing rows stay
-- one-sided (still valid). Re-syncing post-migration will fill in the
-- missing other side via the backfill script (scripts/backfill-trades-two-sided.ts).
--
-- TimescaleDB hypertable requires `time` to be present in every UNIQUE
-- index — the new key honors this.
--
-- CONCURRENT INDEX BUILD
-- ----------------------
-- 10.15M rows. CREATE INDEX CONCURRENTLY does not block writes but cannot
-- run inside a transaction — each statement is its own implicit txn.
--
-- ROLLBACK (if needed)
-- --------------------
--   DROP INDEX IF EXISTS trade_history_account_trade_time_uniq;
--   CREATE UNIQUE INDEX CONCURRENTLY trade_history_tradeid_time_uniq
--     ON trade_history ("tradeId", "time");
--
-- POST-MIGRATION VERIFICATION
-- ---------------------------
--   \d trade_history       -- expect new constraint listed
--   SELECT COUNT(*) FROM trade_history;  -- must equal pre-migration count
-- ============================================================================

-- 1. Build the new constraint without blocking writes. IF NOT EXISTS makes
--    re-runs safe; the old constraint is dropped only after this succeeds.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS trade_history_account_trade_time_uniq
  ON trade_history ("accountId", "tradeId", "time");

-- 2. Drop the old constraint that was discarding the second side of every
--    multi-participant trade. Both DROP statements because the original was
--    created via Prisma's @@unique → starts as a CONSTRAINT (with backing
--    INDEX of the same name). Drop the constraint first; the IF EXISTS
--    on the index handles the case where it's already gone.
ALTER TABLE trade_history DROP CONSTRAINT IF EXISTS trade_history_tradeid_time_uniq;
DROP INDEX IF EXISTS trade_history_tradeid_time_uniq;

-- 3. Reaffirm pnl_history + funding_history UNIQUE on (accountId, marketId, time).
--    These were already migrated by 2026-04-18_unique_by_accountid.sql, but
--    Prisma's history.prisma still declares the old (walletAddr, ...) form.
--    Re-running with IF NOT EXISTS is safe — they already exist on prod.
--    The Prisma schema is updated in this same commit so future
--    `prisma migrate dev` runs don't try to recreate the wrong constraint.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS pnl_history_accountid_marketid_time_uniq
  ON pnl_history ("accountId", "marketId", "time");

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS funding_history_accountid_marketid_time_uniq
  ON funding_history ("accountId", "marketId", "time");

-- Belt-and-suspenders cleanup of the legacy walletAddr-scoped uniques in
-- case prior cleanup didn't fully run (we've seen Prisma re-create the
-- old name after dev-environment regenerations).
ALTER TABLE pnl_history     DROP CONSTRAINT IF EXISTS "pnl_history_walletAddr_marketId_time_key";
ALTER TABLE funding_history DROP CONSTRAINT IF EXISTS "funding_history_walletAddr_marketId_time_key";
DROP INDEX IF EXISTS "pnl_history_walletAddr_marketId_time_key";
DROP INDEX IF EXISTS "funding_history_walletAddr_marketId_time_key";
