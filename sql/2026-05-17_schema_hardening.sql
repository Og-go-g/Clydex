-- =============================================================================
--  2026-05-17 — schema hardening pass (M3, M5, M6 from the wave-2 audit)
-- =============================================================================
--
--  History DB (TimescaleDB). Run with:
--     psql "$HISTORY_DATABASE_URL" -f sql/2026-05-17_schema_hardening.sql
--
--  All statements are idempotent (IF EXISTS / IF NOT EXISTS) so re-running
--  on a partially-applied database is safe.
--
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
--  M3 — account_pubkey.failedAttempts widened from SmallInt (max 32767) to Int.
--
--  The wallet-resolver cron runs every 15 minutes and increments on every 404
--  for any accountId it can't resolve. A permanently-deleted accountId would
--  reach 32767 in ~340 days and crash the whole batch transaction with
--  "smallint out of range", silently halting resolver progress.
-- -----------------------------------------------------------------------------

ALTER TABLE account_pubkey
  ALTER COLUMN "failedAttempts" TYPE integer;

-- -----------------------------------------------------------------------------
--  M5 — volume_calendar.date from TEXT to DATE.
--
--  String form was unsafe: a missing zero-pad (e.g. '2026-3-7') would sort
--  wrong against '2026-03-07', breaking range queries silently. Every period
--  query also paid a per-row ::date cast in SQL. Existing strings are already
--  ISO YYYY-MM-DD so the cast is lossless.
-- -----------------------------------------------------------------------------

ALTER TABLE volume_calendar
  ALTER COLUMN date TYPE date USING date::date;

-- -----------------------------------------------------------------------------
--  M6 — deposit_history / withdrawal_history / liquidation_history UNIQUE
--  swap from (walletAddr, time, amount|fee) to (accountId, time, amount|fee).
--
--  Mirrors the 2026-04-18 fix already applied to pnl_history / funding_history
--  / trade_history. accountId is stable across the placeholder→real wallet
--  rewrite that propagateWallet() does; walletAddr is not. With the old key,
--  if a per-account sync and a per-wallet sync touched the same deposit
--  through different walletAddr forms, ON CONFLICT missed and we silently
--  duplicated the row → user saw a double-counted deposit in Portfolio.
--
--  Two-step swap so we never lose the dedup guarantee:
--    1. Drop any rows that would collide on the new key (keep newest).
--    2. Add the new unique index alongside the old one (still both active).
--    3. Drop the old index.
-- -----------------------------------------------------------------------------

-- Step 1: de-duplicate on the new key, keep the most recent row per group.
DELETE FROM deposit_history dh
USING (
  SELECT "accountId", "time", amount, MAX(id) AS keep_id
  FROM deposit_history
  GROUP BY "accountId", "time", amount
  HAVING COUNT(*) > 1
) g
WHERE dh."accountId" = g."accountId"
  AND dh."time" = g."time"
  AND dh.amount = g.amount
  AND dh.id <> g.keep_id;

DELETE FROM withdrawal_history wh
USING (
  SELECT "accountId", "time", amount, MAX(id) AS keep_id
  FROM withdrawal_history
  GROUP BY "accountId", "time", amount
  HAVING COUNT(*) > 1
) g
WHERE wh."accountId" = g."accountId"
  AND wh."time" = g."time"
  AND wh.amount = g.amount
  AND wh.id <> g.keep_id;

DELETE FROM liquidation_history lh
USING (
  SELECT "accountId", "time", fee, MAX(id) AS keep_id
  FROM liquidation_history
  GROUP BY "accountId", "time", fee
  HAVING COUNT(*) > 1
) g
WHERE lh."accountId" = g."accountId"
  AND lh."time" = g."time"
  AND lh.fee = g.fee
  AND lh.id <> g.keep_id;

-- Step 2: create the new account-scoped unique indexes.
CREATE UNIQUE INDEX IF NOT EXISTS "deposit_history_accountid_time_amount_key"
  ON deposit_history ("accountId", "time", amount);

CREATE UNIQUE INDEX IF NOT EXISTS "withdrawal_history_accountid_time_amount_key"
  ON withdrawal_history ("accountId", "time", amount);

CREATE UNIQUE INDEX IF NOT EXISTS "liquidation_history_accountid_time_fee_key"
  ON liquidation_history ("accountId", "time", fee);

-- Step 3: drop the legacy walletAddr-scoped unique indexes if they exist.
DROP INDEX IF EXISTS "deposit_history_walletAddr_time_amount_key";
DROP INDEX IF EXISTS "withdrawal_history_walletAddr_time_amount_key";
DROP INDEX IF EXISTS "liquidation_history_walletAddr_time_fee_key";

COMMIT;
