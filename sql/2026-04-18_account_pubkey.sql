-- ============================================================================
-- account_pubkey — canonical accountId → solana pubkey mapping.
--
-- Source of truth populated by:
--   1. One-off backfill script (scripts/resolve-all-wallets.ts) — dumps all
--      accounts from GET /account/{id}/pubkey on 01.xyz mainnet backend.
--   2. pg-boss `resolve-wallets` cron — every 15 min, picks up newly created
--      accounts (delta against /accounts/count) and retries 404-marked rows.
--
-- Why separate table instead of reusing walletAddr scattered across raw tables
-- ---------------------------------------------------------------------------
-- - walletAddr is denormalized across 9 tables; propagation was lossy.
-- - Brand-new accounts have pubkey resolved BEFORE any history exists.
-- - 404 accounts need remembering so we don't re-hit the API each cron tick.
--
-- notFound semantics
-- ------------------
--   notFound=false, pubkey NOT NULL  → resolved, canonical mapping.
--   notFound=true,  pubkey IS NULL   → API returned 404; retry after 24h.
--   notFound=false, pubkey IS NULL   → transient failure; retry each tick.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS account_pubkey (
  "accountId"      INT         PRIMARY KEY,
  pubkey           TEXT,
  "notFound"       BOOLEAN     NOT NULL DEFAULT FALSE,
  "failedAttempts" SMALLINT    NOT NULL DEFAULT 0,
  "resolvedAt"     TIMESTAMPTZ,
  "lastCheckedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS account_pubkey_pubkey_idx
  ON account_pubkey (pubkey)
  WHERE pubkey IS NOT NULL;

CREATE INDEX IF NOT EXISTS account_pubkey_retry_idx
  ON account_pubkey ("lastCheckedAt")
  WHERE "notFound" = TRUE OR pubkey IS NULL;

-- Seed from already-resolved real wallets in pnl_totals / trade_history.
-- This gives us the 5 known accounts without any API calls.
INSERT INTO account_pubkey ("accountId", pubkey, "resolvedAt", "lastCheckedAt")
SELECT sub."accountId", sub.wallet, NOW(), NOW()
FROM (
  SELECT DISTINCT ON ("accountId") "accountId", "walletAddr" AS wallet
  FROM pnl_totals
  WHERE "walletAddr" NOT LIKE 'account:%'
  ORDER BY "accountId", "walletAddr"
) sub
ON CONFLICT ("accountId") DO NOTHING;

INSERT INTO account_pubkey ("accountId", pubkey, "resolvedAt", "lastCheckedAt")
SELECT sub."accountId", sub.wallet, NOW(), NOW()
FROM (
  SELECT DISTINCT ON ("accountId") "accountId", "walletAddr" AS wallet
  FROM trade_history
  WHERE "walletAddr" NOT LIKE 'account:%'
  ORDER BY "accountId", "walletAddr"
) sub
ON CONFLICT ("accountId") DO NOTHING;

SELECT COUNT(*) AS seeded_rows FROM account_pubkey;

COMMIT;
