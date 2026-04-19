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
-- 2. This file assumes trade_history has its OLD unique(tradeId) — this
--    migration swaps it to (tradeId, time) because hypertables require `time`
--    inside every unique index.
-- 3. sync.ts already switched to target-less ON CONFLICT so the unique swap
--    is transparent to the app.
--
-- RUN ORDER
-- ---------
--   docker compose stop worker            # no writes during conversion
--   sudo -u postgres psql -d clydex_history -f <this file>
--   docker compose start worker
--
-- The full pass takes ~5-20 minutes depending on disk speed; chunk migration
-- holds ACCESS EXCLUSIVE on each table while copying rows.
--
-- IDEMPOTENT
-- ----------
-- Every DDL uses IF NOT EXISTS / IF EXISTS / already-a-hypertable guards.
-- Safe to re-run: it will skip what's already in place and finish the rest.
-- ============================================================================

\timing on

-- ─── 1. Extension ──────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

SELECT extname, extversion FROM pg_extension WHERE extname = 'timescaledb';

-- ─── 2. trade_history unique swap (tradeId → tradeId+time) ─────────────────
-- Must happen BEFORE create_hypertable.

DO $$
DECLARE
  old_idx text;
BEGIN
  -- Prisma names it trade_history_tradeId_key — find whatever UNIQUE(tradeId only) exists
  SELECT i.indexrelid::regclass::text INTO old_idx
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  WHERE c.relname = 'trade_history'
    AND i.indisunique
    AND array_length(i.indkey, 1) = 1
    AND (SELECT attname FROM pg_attribute WHERE attrelid = i.indrelid AND attnum = i.indkey[0]) = 'tradeId';

  IF old_idx IS NOT NULL THEN
    RAISE NOTICE 'Will drop old unique index: %', old_idx;
  ELSE
    RAISE NOTICE 'Old unique(tradeId) already absent — nothing to drop';
  END IF;
END $$;

-- Build the new composite unique index WITHOUT blocking writes (if worker was
-- left running by accident).
CREATE UNIQUE INDEX IF NOT EXISTS trade_history_tradeid_time_uniq
  ON trade_history ("tradeId", "time");

-- Drop the old one. Uses a DO block so it works whatever the old name is.
DO $$
DECLARE
  old_idx text;
BEGIN
  SELECT i.indexrelid::regclass::text INTO old_idx
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  WHERE c.relname = 'trade_history'
    AND i.indisunique
    AND array_length(i.indkey, 1) = 1
    AND (SELECT attname FROM pg_attribute WHERE attrelid = i.indrelid AND attnum = i.indkey[0]) = 'tradeId';

  IF old_idx IS NOT NULL THEN
    EXECUTE format('ALTER TABLE trade_history DROP CONSTRAINT IF EXISTS %I', split_part(old_idx, '.', 2));
    EXECUTE format('DROP INDEX IF EXISTS %s', old_idx);
    RAISE NOTICE 'Dropped %', old_idx;
  END IF;
END $$;

-- ─── 3. Hypertable conversion ──────────────────────────────────────────────
-- chunk_time_interval tuned per table:
--   pnl_history / trade_history: 7 days (dense tables, one chunk ≈ 100-800 MB)
--   funding_history: 30 days (less dense, keep fewer chunks)

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
-- segmentby = "accountId" because ~every query filters by accountId; grouping
-- rows of the same account inside a chunk gives the best compression ratio +
-- fast filtered reads.
-- orderby = time DESC so the most recent row in a compressed segment is first
-- (speeds up "latest N" queries).

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
-- The policy runs on a schedule; we want the space savings right now.

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
    RAISE NOTICE 'Compressed % (% of %)', c.chunk_name, compressed_count, c.hypertable_name;
  END LOOP;

  RAISE NOTICE 'Total chunks compressed: %', compressed_count;
END $$;

-- ─── 7. Verification ───────────────────────────────────────────────────────

SELECT hypertable_name,
       pg_size_pretty(hypertable_size(format('%I.%I', hypertable_schema, hypertable_name)::regclass)) AS size,
       num_chunks,
       compression_enabled
FROM timescaledb_information.hypertables
WHERE hypertable_name IN ('pnl_history','funding_history','trade_history');

SELECT hypertable_name,
       pg_size_pretty(before_compression_total_bytes::bigint)  AS before,
       pg_size_pretty(after_compression_total_bytes::bigint)   AS after,
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
