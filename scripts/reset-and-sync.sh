#!/bin/bash
# ============================================================
# Reset history DB and run full sync
# Run on server: bash scripts/reset-and-sync.sh
# ============================================================
set -e

echo "=== Step 1: Drop all history tables ==="
sudo -u postgres psql -d clydex_history -c "
DROP TABLE IF EXISTS trade_history CASCADE;
DROP TABLE IF EXISTS order_history CASCADE;
DROP TABLE IF EXISTS pnl_history CASCADE;
DROP TABLE IF EXISTS funding_history CASCADE;
DROP TABLE IF EXISTS deposit_history CASCADE;
DROP TABLE IF EXISTS withdrawal_history CASCADE;
DROP TABLE IF EXISTS liquidation_history CASCADE;
DROP TABLE IF EXISTS sync_cursors CASCADE;
DROP TABLE IF EXISTS volume_calendar CASCADE;
DROP TABLE IF EXISTS pnl_totals CASCADE;
DROP TABLE IF EXISTS _prisma_migrations CASCADE;
"
echo "   Tables dropped."

echo ""
echo "=== Step 2: Recreate tables with snake_case columns ==="
sudo -u postgres psql -d clydex_history -c "
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE trade_history (
  id            BIGINT GENERATED ALWAYS AS IDENTITY,
  trade_id      TEXT         NOT NULL,
  account_id    INT          NOT NULL,
  wallet_addr   TEXT         NOT NULL,
  market_id     INT          NOT NULL,
  symbol        TEXT         NOT NULL,
  side          TEXT         NOT NULL,
  size          NUMERIC(30,18) NOT NULL,
  price         NUMERIC(30,18) NOT NULL,
  role          TEXT         NOT NULL,
  fee           NUMERIC(30,18) NOT NULL DEFAULT 0,
  \"time\"        TIMESTAMPTZ  NOT NULL,
  UNIQUE (trade_id, \"time\")
);
SELECT create_hypertable('trade_history', 'time', chunk_time_interval => INTERVAL '1 week', if_not_exists => TRUE);
CREATE INDEX idx_trade_wallet_time ON trade_history (wallet_addr, \"time\" DESC);
CREATE INDEX idx_trade_wallet_market ON trade_history (wallet_addr, market_id);

CREATE TABLE order_history (
  id              BIGINT GENERATED ALWAYS AS IDENTITY,
  order_id        TEXT         NOT NULL,
  account_id      INT          NOT NULL,
  wallet_addr     TEXT         NOT NULL,
  market_id       INT          NOT NULL,
  symbol          TEXT         NOT NULL,
  side            TEXT         NOT NULL,
  placed_size     NUMERIC(30,18) NOT NULL,
  filled_size     NUMERIC(30,18),
  placed_price    NUMERIC(30,18) NOT NULL,
  order_value     NUMERIC(30,18) NOT NULL,
  fill_mode       TEXT         NOT NULL,
  fill_status     TEXT         NOT NULL,
  status          TEXT         NOT NULL,
  is_reduce_only  BOOLEAN      NOT NULL DEFAULT false,
  added_at        TIMESTAMPTZ  NOT NULL,
  updated_at      TIMESTAMPTZ  NOT NULL,
  UNIQUE (order_id, added_at)
);
SELECT create_hypertable('order_history', 'added_at', chunk_time_interval => INTERVAL '1 week', if_not_exists => TRUE);
CREATE INDEX idx_order_wallet_added ON order_history (wallet_addr, added_at DESC);

CREATE TABLE pnl_history (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY,
  account_id          INT          NOT NULL,
  wallet_addr         TEXT         NOT NULL,
  market_id           INT          NOT NULL,
  symbol              TEXT         NOT NULL,
  trading_pnl         NUMERIC(30,18) NOT NULL,
  settled_funding_pnl NUMERIC(30,18) NOT NULL,
  position_size       NUMERIC(30,18) NOT NULL,
  \"time\"              TIMESTAMPTZ  NOT NULL,
  UNIQUE (wallet_addr, market_id, \"time\")
);
SELECT create_hypertable('pnl_history', 'time', chunk_time_interval => INTERVAL '1 month', if_not_exists => TRUE);
CREATE INDEX idx_pnl_wallet_time ON pnl_history (wallet_addr, \"time\" DESC);

CREATE TABLE funding_history (
  id              BIGINT GENERATED ALWAYS AS IDENTITY,
  account_id      INT          NOT NULL,
  wallet_addr     TEXT         NOT NULL,
  market_id       INT          NOT NULL,
  symbol          TEXT         NOT NULL,
  funding_pnl     NUMERIC(30,18) NOT NULL,
  position_size   NUMERIC(30,18) NOT NULL,
  \"time\"          TIMESTAMPTZ  NOT NULL,
  UNIQUE (wallet_addr, market_id, \"time\")
);
SELECT create_hypertable('funding_history', 'time', chunk_time_interval => INTERVAL '1 month', if_not_exists => TRUE);

CREATE TABLE deposit_history (
  id          BIGINT GENERATED ALWAYS AS IDENTITY,
  account_id  INT          NOT NULL,
  wallet_addr TEXT         NOT NULL,
  amount      NUMERIC(30,18) NOT NULL,
  balance     NUMERIC(30,18) NOT NULL,
  token_id    INT          NOT NULL,
  \"time\"      TIMESTAMPTZ  NOT NULL,
  UNIQUE (wallet_addr, \"time\", amount)
);
SELECT create_hypertable('deposit_history', 'time', chunk_time_interval => INTERVAL '1 month', if_not_exists => TRUE);

CREATE TABLE withdrawal_history (
  id          BIGINT GENERATED ALWAYS AS IDENTITY,
  account_id  INT          NOT NULL,
  wallet_addr TEXT         NOT NULL,
  amount      NUMERIC(30,18) NOT NULL,
  balance     NUMERIC(30,18) NOT NULL,
  fee         NUMERIC(30,18) NOT NULL,
  dest_pubkey TEXT         NOT NULL,
  \"time\"      TIMESTAMPTZ  NOT NULL,
  UNIQUE (wallet_addr, \"time\", amount)
);
SELECT create_hypertable('withdrawal_history', 'time', chunk_time_interval => INTERVAL '1 month', if_not_exists => TRUE);

CREATE TABLE liquidation_history (
  id               BIGINT GENERATED ALWAYS AS IDENTITY,
  account_id       INT          NOT NULL,
  wallet_addr      TEXT         NOT NULL,
  fee              NUMERIC(30,18) NOT NULL,
  liquidation_kind TEXT         NOT NULL,
  margins          JSONB,
  \"time\"           TIMESTAMPTZ  NOT NULL,
  UNIQUE (wallet_addr, \"time\", fee)
);
SELECT create_hypertable('liquidation_history', 'time', chunk_time_interval => INTERVAL '1 month', if_not_exists => TRUE);

CREATE TABLE sync_cursors (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wallet_addr TEXT         NOT NULL,
  type        TEXT         NOT NULL,
  cursor      TEXT,
  last_sync_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (wallet_addr, type)
);

CREATE TABLE volume_calendar (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    INT          NOT NULL,
  wallet_addr   TEXT         NOT NULL,
  date          TEXT         NOT NULL,
  volume        NUMERIC(30,18) NOT NULL DEFAULT 0,
  maker_volume  NUMERIC(30,18) NOT NULL DEFAULT 0,
  taker_volume  NUMERIC(30,18) NOT NULL DEFAULT 0,
  maker_fees    NUMERIC(30,18) NOT NULL DEFAULT 0,
  taker_fees    NUMERIC(30,18) NOT NULL DEFAULT 0,
  total_fees    NUMERIC(30,18) NOT NULL DEFAULT 0,
  UNIQUE (wallet_addr, date)
);

CREATE TABLE pnl_totals (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id        INT          NOT NULL,
  wallet_addr       TEXT         NOT NULL UNIQUE,
  total_pnl         NUMERIC(30,18) NOT NULL DEFAULT 0,
  total_trading_pnl NUMERIC(30,18) NOT NULL DEFAULT 0,
  total_funding_pnl NUMERIC(30,18) NOT NULL DEFAULT 0,
  fetched_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

GRANT ALL ON ALL TABLES IN SCHEMA public TO clydex;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO clydex;
"
echo "   Tables created with snake_case columns."

echo ""
echo "=== Step 3: Verify columns ==="
sudo -u postgres psql -d clydex_history -c "
SELECT column_name FROM information_schema.columns
WHERE table_name = 'trade_history'
ORDER BY ordinal_position;
"

echo ""
echo "=== Done! Ready to sync ==="
