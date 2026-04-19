-- ============================================================================
-- TimescaleDB hypertables + compression for the three high-volume raw tables.
--
-- GOAL
-- ----
-- pnl_history (4.4 GB / 7.4M rows), trade_history (5.2 GB / 8.9M rows),
-- funding_history (196 MB / 407k rows) → 99% of history DB mass.
-- Compression on chunks older than 7 days typically yields 5-10× reduction.
-- Projected DB size 10 GB → ~2-3 GB, freeing 7+ GB permanently.
--
-- PREREQUISITES
-- -------------
-- 1. timescaledb package installed (apt), shared_preload_libraries=timescaledb.
-- 2. sync.ts already switched to target-less ON CONFLICT so unique-index
--    swaps are transparent to INSERTs.
--
-- IMPORTANT CONSTRAINT
-- --------------------
-- TimescaleDB requires the partitioning column (`time`) to be part of EVERY
-- unique constraint on a hypertable. This includes the PRIMARY KEY. We drop:
--   - trade_history UNIQUE(tradeId)            → replaced with (tradeId, time)
--   - pnl_history / funding_history / trade_history PRIMARY KEY(id)
--     We don't replace with composite PK — existing @@unique(accountId, marketId, time)
--     on pnl/funding and (tradeId, time) on trade act as the uniqueness guarantee.
--     The `id` column stays (Prisma default, still populated by INSERT) but
--     without a PK constraint. History DB is only queried via raw SQL
--     (lib/db-history.ts), never via Prisma client, so no runtime impact.
--
-- RUN ORDER
-- ---------
--   docker compose stop worker            # no writes during conversion
--   sudo -u postgres psql -d clydex_history -f <this file>
--   docker compose start worker
--
-- The full pass takes ~5-20 minutes; chunk migration holds ACCESS EXCLUSIVE.
--
-- IDEMPOTENT
-- ----------
-- Every DDL uses IF NOT EXISTS / IF EXISTS / if_not_exists=TRUE.
-- Safe to re-run: partial progress is picked up from where it stopped.
-- ============================================================================

\timing on

-- ─── 1. Extension ──────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

SELECT extname, extversion FROM pg_extension WHERE extname = 'timescaledb';

-- ─── 2. Drop constraints that TimescaleDB will reject ─────────────────────
-- (a) trade_history old unique(tradeId) — replaced by (tradeId, time)

-- Build the new composite unique FIRST so there's never a window of
-- no-uniqueness on tradeId.
CREATE UNIQUE INDEX IF NOT EXISTS trade_history_tradeid_time_uniq
  ON trade_history ("tradeId", "time");

-- Drop the old unique constraint AND the underlying index. On this
-- deployment the constraint was previously removed manually but the
-- index was left behind (pg_constraint empty, pg_indexes still has the
-- row), so ALTER TABLE DROP CONSTRAINT alone is not enough — DROP INDEX
-- catches the orphaned case.
ALTER TABLE trade_history DROP CONSTRAINT IF EXISTS "trade_history_tradeId_key";
DROP INDEX IF EXISTS "trade_history_tradeId_key";

-- (b) Primary keys on id — hypertable requires time in every unique index,
-- and `id` alone doesn't satisfy that. Drop the PK; rely on existing
-- @@unique constraints for uniqueness.

ALTER TABLE pnl_history     DROP CONSTRAINT IF EXISTS pnl_history_pkey;
ALTER TABLE funding_history DROP CONSTRAINT IF EXISTS funding_history_pkey;
ALTER TABLE trade_history   DROP CONSTRAINT IF EXISTS trade_history_pkey;

-- ─── 3. Hypertable conversion ──────────────────────────────────────────────
-- chunk_time_interval:
--   pnl_history / trade_history: 7 days (dense tables → chunks ~100-800 MB)
--   funding_history: 30 days (sparse → fewer chunks)

SELECT create_hypertable(
  'pnl_history', 'time',
  chunk_time_interval => INTERVAL '7 days',
  migrate_data        => TRUE,
  if_not_exists       => TRUE
);

SELECT create_hypertable(
  'funding_history', 'time',
  chunk_time_interval => INTERVAL '30 days',
  migrate_data        => TRUE,
  if_not_exists       => TRUE
);

SELECT create_hypertable(
  'trade_history', 'time',
  chunk_time_interval => INTERVAL '7 days',
  migrate_data        => TRUE,
  if_not_exists       => TRUE
);

-- Sanity — three rows expected:
SELECT hypertable_name, num_chunks
FROM timescaledb_information.hypertables
WHERE hypertable_name IN ('pnl_history','funding_history','trade_history');

-- ─── 4. Enable compression ─────────────────────────────────────────────────

ALTER TABLE pnl_history SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = '"accountId"',
  timescaledb.compress_orderby   = '"time" DESC'
);

ALTER TABLE funding_history SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = '"accountId"',
  timescaledb.compress_orderby   = '"time" DESC'
);

ALTER TABLE trade_history SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = '"accountId"',
  timescaledb.compress_orderby   = '"time" DESC'
);

-- ─── 5. Compression policies — automatic on chunks older than 7 days ──────

SELECT add_compression_policy('pnl_history',     INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_compression_policy('funding_history', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_compression_policy('trade_history',   INTERVAL '7 days', if_not_exists => TRUE);

-- ─── 6. Compress pre-existing old chunks immediately ──────────────────────

DO $$
DECLARE
  c record;
  compressed_count int := 0;
BEGIN
  FOR c IN
    SELECT chunk_schema, chunk_name, hypertable_name
    FROM timescaledb_information.chunks
    WHERE hypertable_name IN ('pnl_history','funding_history','trade_history')
      AND NOT is_compressed
      AND range_end < NOW() - INTERVAL '7 days'
    ORDER BY range_end ASC
  LOOP
    EXECUTE format('SELECT compress_chunk(%L)', c.chunk_schema || '.' || c.chunk_name);
    compressed_count := compressed_count + 1;
    RAISE NOTICE 'Compressed % (total so far: %)', c.chunk_name, compressed_count;
  END LOOP;

  RAISE NOTICE 'Total chunks compressed: %', compressed_count;
END $$;

-- ─── 7. Verification ───────────────────────────────────────────────────────

-- Per-hypertable summary
SELECT hypertable_name,
       num_chunks,
       compression_enabled,
       pg_size_pretty(hypertable_size(format('%I.%I', hypertable_schema, hypertable_name)::regclass)) AS total_size
FROM timescaledb_information.hypertables
WHERE hypertable_name IN ('pnl_history','funding_history','trade_history')
ORDER BY hypertable_name;

-- Compression ratio per hypertable. hypertable_compression_stats() returns
-- one row per hypertable with no name column, so we prefix with a literal.
SELECT 'pnl_history' AS hypertable,
       pg_size_pretty(before_compression_total_bytes::bigint) AS before,
       pg_size_pretty(after_compression_total_bytes::bigint)  AS after,
       ROUND(
         (before_compression_total_bytes::numeric / NULLIF(after_compression_total_bytes, 0)), 1
       ) AS ratio
FROM hypertable_compression_stats('pnl_history')
UNION ALL
SELECT 'funding_history',
       pg_size_pretty(before_compression_total_bytes::bigint),
       pg_size_pretty(after_compression_total_bytes::bigint),
       ROUND((before_compression_total_bytes::numeric / NULLIF(after_compression_total_bytes, 0)), 1)
FROM hypertable_compression_stats('funding_history')
UNION ALL
SELECT 'trade_history',
       pg_size_pretty(before_compression_total_bytes::bigint),
       pg_size_pretty(after_compression_total_bytes::bigint),
       ROUND((before_compression_total_bytes::numeric / NULLIF(after_compression_total_bytes, 0)), 1)
FROM hypertable_compression_stats('trade_history');

SELECT pg_size_pretty(pg_database_size('clydex_history')) AS total_db_size;
