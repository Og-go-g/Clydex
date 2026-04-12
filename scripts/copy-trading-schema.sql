-- Copy Trading Schema
-- Run on history DB (clydex_history): psql -U clydex -d clydex_history -f scripts/copy-trading-schema.sql

BEGIN;

-- Encrypted session keypairs for autonomous trading
CREATE TABLE IF NOT EXISTS copy_sessions (
  id                TEXT PRIMARY KEY,
  wallet_addr       TEXT UNIQUE NOT NULL,
  encrypted_key     TEXT NOT NULL,
  iv                TEXT NOT NULL,
  auth_tag          TEXT NOT NULL,
  session_pubkey    TEXT NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_copy_sessions_wallet ON copy_sessions (wallet_addr);
CREATE INDEX IF NOT EXISTS idx_copy_sessions_expires ON copy_sessions (expires_at);

-- Trader subscriptions (who follows whom)
CREATE TABLE IF NOT EXISTS copy_subscriptions (
  id                TEXT PRIMARY KEY,
  follower_addr     TEXT NOT NULL,
  leader_addr       TEXT NOT NULL,
  allocation_usdc   NUMERIC(30,18) NOT NULL,
  leverage_mult     NUMERIC(10,4) DEFAULT 1.0,
  max_position_usdc NUMERIC(30,18),
  stop_loss_pct     NUMERIC(10,4),
  active            BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(follower_addr, leader_addr)
);

CREATE INDEX IF NOT EXISTS idx_copy_subs_follower ON copy_subscriptions (follower_addr);
CREATE INDEX IF NOT EXISTS idx_copy_subs_leader ON copy_subscriptions (leader_addr);
CREATE INDEX IF NOT EXISTS idx_copy_subs_active ON copy_subscriptions (active) WHERE active = TRUE;

-- Snapshot of trader positions (for diff detection by copy engine)
CREATE TABLE IF NOT EXISTS copy_snapshots (
  id                TEXT PRIMARY KEY,
  leader_addr       TEXT NOT NULL,
  market_id         INT NOT NULL,
  size              NUMERIC(30,18) NOT NULL,
  side              TEXT NOT NULL,
  captured_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(leader_addr, market_id)
);

CREATE INDEX IF NOT EXISTS idx_copy_snapshots_leader ON copy_snapshots (leader_addr);

-- Executed copy trades
CREATE TABLE IF NOT EXISTS copy_trades (
  id                TEXT PRIMARY KEY,
  subscription_id   TEXT REFERENCES copy_subscriptions(id) ON DELETE SET NULL,
  follower_addr     TEXT NOT NULL,
  leader_addr       TEXT NOT NULL,
  market_id         INT NOT NULL,
  symbol            TEXT NOT NULL,
  side              TEXT NOT NULL,
  size              NUMERIC(30,18) NOT NULL,
  price             NUMERIC(30,18),
  status            TEXT DEFAULT 'pending',
  error             TEXT,
  orig_trade_id     TEXT,
  order_id          TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  filled_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_copy_trades_sub ON copy_trades (subscription_id);
CREATE INDEX IF NOT EXISTS idx_copy_trades_follower ON copy_trades (follower_addr, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_copy_trades_leader ON copy_trades (leader_addr, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_copy_trades_status ON copy_trades (status) WHERE status = 'pending';

-- Migration: add max_total_position_usdc (global cap across all markets)
ALTER TABLE copy_subscriptions ADD COLUMN IF NOT EXISTS max_total_position_usdc NUMERIC(30,18);

COMMIT;
