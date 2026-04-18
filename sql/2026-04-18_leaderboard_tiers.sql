-- Migration for pg-boss worker architecture
-- Tables: leaderboard_tiers, account_interactions, worker_heartbeat
-- Run on HISTORY_DATABASE_URL

BEGIN;

-- Per-account tier assignment for refresh scheduling
CREATE TABLE IF NOT EXISTS leaderboard_tiers (
  "accountId"    INT PRIMARY KEY,
  "walletAddr"   TEXT NOT NULL,
  tier           SMALLINT NOT NULL CHECK (tier BETWEEN 1 AND 4),
  reason         TEXT NOT NULL,
  "lastRefresh"  TIMESTAMPTZ,
  "nextDueAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "assignedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tiers_tier_due ON leaderboard_tiers(tier, "nextDueAt");
CREATE INDEX IF NOT EXISTS idx_tiers_wallet   ON leaderboard_tiers("walletAddr");

-- Lightweight interaction log for Tier 2 assignment
-- Records when users view/search/follow a trader
CREATE TABLE IF NOT EXISTS account_interactions (
  id             BIGSERIAL PRIMARY KEY,
  "accountId"    INT NOT NULL,
  "walletAddr"   TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('view', 'search', 'follow')),
  "userId"       TEXT,
  "at"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_interactions_at   ON account_interactions("at" DESC);
CREATE INDEX IF NOT EXISTS idx_interactions_acct ON account_interactions("accountId", "at" DESC);

-- Worker heartbeat (written by worker every 15s)
-- Used for monitoring and alerts
CREATE TABLE IF NOT EXISTS worker_heartbeat (
  id             INT PRIMARY KEY DEFAULT 1,
  "lastBeat"     TIMESTAMPTZ NOT NULL,
  pid            INT,
  host           TEXT,
  version        TEXT
);

COMMIT;
