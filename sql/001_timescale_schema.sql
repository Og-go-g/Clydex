-- ============================================================
-- Clydex N1 — History Database Schema (TimescaleDB)
-- Run once on fresh PostgreSQL + TimescaleDB instance.
-- ============================================================

-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ─── Trade History ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trade_history (
  id            BIGINT GENERATED ALWAYS AS IDENTITY,
  trade_id      TEXT         NOT NULL,
  account_id    INT          NOT NULL,
  wallet_addr   TEXT         NOT NULL,
  market_id     INT          NOT NULL,
  symbol        TEXT         NOT NULL,
  side          TEXT         NOT NULL,      -- 'Long' | 'Short'
  size          NUMERIC(30,18) NOT NULL,
  price         NUMERIC(30,18) NOT NULL,
  role          TEXT         NOT NULL,      -- 'taker' | 'maker'
  fee           NUMERIC(30,18) NOT NULL DEFAULT 0,
  "time"        TIMESTAMPTZ  NOT NULL,
  UNIQUE (trade_id, "time")
);

SELECT create_hypertable('trade_history', 'time', chunk_time_interval => INTERVAL '1 week', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_trade_wallet_time ON trade_history (wallet_addr, "time" DESC);
CREATE INDEX IF NOT EXISTS idx_trade_wallet_market ON trade_history (wallet_addr, market_id);

-- ─── Order History ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS order_history (
  id              BIGINT GENERATED ALWAYS AS IDENTITY,
  order_id        TEXT         NOT NULL,
  account_id      INT          NOT NULL,
  wallet_addr     TEXT         NOT NULL,
  market_id       INT          NOT NULL,
  symbol          TEXT         NOT NULL,
  side            TEXT         NOT NULL,      -- 'Long' | 'Short'
  placed_size     NUMERIC(30,18) NOT NULL,
  filled_size     NUMERIC(30,18),             -- NULL if unfilled
  placed_price    NUMERIC(30,18) NOT NULL,
  order_value     NUMERIC(30,18) NOT NULL,
  fill_mode       TEXT         NOT NULL,
  fill_status     TEXT         NOT NULL,      -- 'Filled' | 'Unfilled'
  status          TEXT         NOT NULL,      -- 'Filled' | 'Cancelled' | 'Expired'
  is_reduce_only  BOOLEAN      NOT NULL DEFAULT false,
  added_at        TIMESTAMPTZ  NOT NULL,
  updated_at      TIMESTAMPTZ  NOT NULL,
  UNIQUE (order_id, added_at)
);

SELECT create_hypertable('order_history', 'added_at', chunk_time_interval => INTERVAL '1 week', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_order_wallet_added ON order_history (wallet_addr, added_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_wallet_market ON order_history (wallet_addr, market_id);

-- ─── PnL History ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pnl_history (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY,
  account_id          INT          NOT NULL,
  wallet_addr         TEXT         NOT NULL,
  market_id           INT          NOT NULL,
  symbol              TEXT         NOT NULL,
  trading_pnl         NUMERIC(30,18) NOT NULL,
  settled_funding_pnl NUMERIC(30,18) NOT NULL,
  position_size       NUMERIC(30,18) NOT NULL,
  "time"              TIMESTAMPTZ  NOT NULL,
  UNIQUE (wallet_addr, market_id, "time")
);

SELECT create_hypertable('pnl_history', 'time', chunk_time_interval => INTERVAL '1 month', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_pnl_wallet_time ON pnl_history (wallet_addr, "time" DESC);

-- ─── Funding History ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS funding_history (
  id              BIGINT GENERATED ALWAYS AS IDENTITY,
  account_id      INT          NOT NULL,
  wallet_addr     TEXT         NOT NULL,
  market_id       INT          NOT NULL,
  symbol          TEXT         NOT NULL,
  funding_pnl     NUMERIC(30,18) NOT NULL,
  position_size   NUMERIC(30,18) NOT NULL,
  "time"          TIMESTAMPTZ  NOT NULL,
  UNIQUE (wallet_addr, market_id, "time")
);

SELECT create_hypertable('funding_history', 'time', chunk_time_interval => INTERVAL '1 month', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_funding_wallet_time ON funding_history (wallet_addr, "time" DESC);

-- ─── Deposit History ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS deposit_history (
  id          BIGINT GENERATED ALWAYS AS IDENTITY,
  account_id  INT          NOT NULL,
  wallet_addr TEXT         NOT NULL,
  amount      NUMERIC(30,18) NOT NULL,
  balance     NUMERIC(30,18) NOT NULL,
  token_id    INT          NOT NULL,
  "time"      TIMESTAMPTZ  NOT NULL,
  UNIQUE (wallet_addr, "time", amount)
);

SELECT create_hypertable('deposit_history', 'time', chunk_time_interval => INTERVAL '1 month', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_deposit_wallet_time ON deposit_history (wallet_addr, "time" DESC);

-- ─── Withdrawal History ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS withdrawal_history (
  id          BIGINT GENERATED ALWAYS AS IDENTITY,
  account_id  INT          NOT NULL,
  wallet_addr TEXT         NOT NULL,
  amount      NUMERIC(30,18) NOT NULL,
  balance     NUMERIC(30,18) NOT NULL,
  fee         NUMERIC(30,18) NOT NULL,
  dest_pubkey TEXT         NOT NULL,
  "time"      TIMESTAMPTZ  NOT NULL,
  UNIQUE (wallet_addr, "time", amount)
);

SELECT create_hypertable('withdrawal_history', 'time', chunk_time_interval => INTERVAL '1 month', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_withdrawal_wallet_time ON withdrawal_history (wallet_addr, "time" DESC);

-- ─── Liquidation History ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS liquidation_history (
  id               BIGINT GENERATED ALWAYS AS IDENTITY,
  account_id       INT          NOT NULL,
  wallet_addr      TEXT         NOT NULL,
  fee              NUMERIC(30,18) NOT NULL,
  liquidation_kind TEXT         NOT NULL,
  margins          JSONB,
  "time"           TIMESTAMPTZ  NOT NULL,
  UNIQUE (wallet_addr, "time", fee)
);

SELECT create_hypertable('liquidation_history', 'time', chunk_time_interval => INTERVAL '1 month', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_liquidation_wallet_time ON liquidation_history (wallet_addr, "time" DESC);

-- ─── Sync Cursors (regular table, not time-series) ────────────────

CREATE TABLE IF NOT EXISTS sync_cursors (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wallet_addr TEXT         NOT NULL,
  type        TEXT         NOT NULL,
  cursor      TEXT,
  last_sync_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (wallet_addr, type)
);

-- ─── Compression Policies ─────────────────────────────────────────

ALTER TABLE trade_history SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'wallet_addr',
  timescaledb.compress_orderby = '"time" DESC'
);
SELECT add_compression_policy('trade_history', INTERVAL '2 weeks', if_not_exists => TRUE);

ALTER TABLE order_history SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'wallet_addr',
  timescaledb.compress_orderby = 'added_at DESC'
);
SELECT add_compression_policy('order_history', INTERVAL '2 weeks', if_not_exists => TRUE);

ALTER TABLE pnl_history SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'wallet_addr',
  timescaledb.compress_orderby = '"time" DESC'
);
SELECT add_compression_policy('pnl_history', INTERVAL '2 months', if_not_exists => TRUE);

ALTER TABLE funding_history SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'wallet_addr',
  timescaledb.compress_orderby = '"time" DESC'
);
SELECT add_compression_policy('funding_history', INTERVAL '2 months', if_not_exists => TRUE);

ALTER TABLE deposit_history SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'wallet_addr',
  timescaledb.compress_orderby = '"time" DESC'
);
SELECT add_compression_policy('deposit_history', INTERVAL '2 months', if_not_exists => TRUE);

ALTER TABLE withdrawal_history SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'wallet_addr',
  timescaledb.compress_orderby = '"time" DESC'
);
SELECT add_compression_policy('withdrawal_history', INTERVAL '2 months', if_not_exists => TRUE);

ALTER TABLE liquidation_history SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'wallet_addr',
  timescaledb.compress_orderby = '"time" DESC'
);
SELECT add_compression_policy('liquidation_history', INTERVAL '2 months', if_not_exists => TRUE);
