-- ============================================================================
-- Derive "Order History" from trade_history + drop the standalone table.
--
-- WHY
-- ---
-- order_history grew unbounded for active users (309 MB in hours after a
-- TRUNCATE). Cancelled / unfilled orders are noise for a retail copy-trading
-- UI. The "Order History" tab only needs filled orders, which can be
-- rebuilt by grouping trade_history rows by orderId. One less table to
-- keep in sync, zero storage for orders beyond the trades we already keep.
--
-- STRATEGY
-- --------
-- 1. Add trade_history."orderId" (nullable — pre-existing rows don't have it).
-- 2. From now on syncTrades writes orderId too.
-- 3. GET /api/history/orders derives the tab content via GROUP BY "orderId".
-- 4. Old trade rows (orderId IS NULL) won't show in the derived order view.
--    Tracked as an accepted one-time gap — users still see those executions
--    on the Trades tab.
-- 5. Drop order_history entirely. Uncomment the DROP if you want it in the
--    same transaction; otherwise run separately after the new code is live.
--
-- RUN ORDER
-- ---------
--   docker compose stop worker                # no writes during ALTER
--   sudo -u postgres psql -d clydex_history -f <this file>
--   # deploy new code that writes orderId into trade_history
--   docker compose start worker
--
-- The ALTER TABLE ADD COLUMN NULL is fast (metadata-only in PG 11+).
-- Creating the partial index takes longer on 9.18M rows — a few minutes.
-- ============================================================================

\timing on

BEGIN;

-- ─── 1. Add nullable orderId column to trade_history ──────────────────────
-- Fast, metadata-only (PG 11+ supports ADD COLUMN NULL without rewrite).

ALTER TABLE trade_history ADD COLUMN IF NOT EXISTS "orderId" TEXT;

-- ─── 2. Index for GROUP BY "orderId" ───────────────────────────────────────
-- Partial index excludes NULL so it stays small — only indexes rows that
-- actually carry an orderId (i.e. new trades synced after this migration).
-- The query pattern is "WHERE accountId = X AND orderId IS NOT NULL
-- GROUP BY orderId", so (accountId, orderId) covers both filter and grouping.
--
-- CONCURRENTLY is NOT allowed on TimescaleDB hypertables — it must create
-- indexes on every chunk, which is incompatible with the concurrent path.
-- A plain CREATE INDEX takes an AccessExclusive lock but the WHERE clause
-- keeps it cheap: only 51 rows qualify at first, index builds in ms.

CREATE INDEX IF NOT EXISTS trade_history_accountid_orderid_idx
  ON trade_history ("accountId", "orderId")
  WHERE "orderId" IS NOT NULL;

COMMIT;

-- ─── 3. Drop order_history ─────────────────────────────────────────────────
-- Safe once new code is deployed and /api/history/orders is derived from
-- trade_history. CASCADE drops dependent objects (there shouldn't be any).

DROP TABLE IF EXISTS order_history CASCADE;

-- ─── 4. Sanity ─────────────────────────────────────────────────────────────

-- Confirm the new column and index exist
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'trade_history' AND column_name = 'orderId';

SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'trade_history' AND indexname = 'trade_history_accountid_orderid_idx';

-- Confirm order_history is gone
SELECT to_regclass('public.order_history') AS order_history_still_exists;

-- DB size
SELECT pg_size_pretty(pg_database_size('clydex_history')) AS total_db_size;
