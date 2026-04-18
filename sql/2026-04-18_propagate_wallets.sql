-- ============================================================================
-- Propagate resolved walletAddr from account_pubkey across history tables.
--
-- This is Phase 2 of the wallet-resolver rollout. Phase 1 populates the
-- account_pubkey table via scripts/resolve-all-wallets.ts (the fetch half).
-- Running the propagation half inside the worker container deadlocked with
-- concurrent pg-boss jobs (leaderboard-batch / sync-user-history hold locks
-- on the same rows). This file runs straight under psql, with the worker
-- stopped, so there are no concurrent writers.
--
-- RUN ORDER
-- ---------
--   docker compose stop worker                       # no concurrent writers
--   sudo -u postgres psql -d clydex_history -f <this>
--   docker compose start worker
--
-- The transaction takes seconds to minutes (single-scan JOINs per table).
--
-- IDEMPOTENT
-- ----------
-- Re-running is safe: all statements match on `walletAddr = 'account:' || id`,
-- so rows already rewritten are invisible to the second pass. Only true
-- leftovers get touched.
-- ============================================================================

\timing on

BEGIN;

-- Guard rails: must have resolved pubkeys to propagate from. Abort loudly
-- if account_pubkey is empty so we don't silently no-op.
DO $$
DECLARE eligible int;
BEGIN
  SELECT COUNT(*) INTO eligible FROM account_pubkey WHERE pubkey IS NOT NULL;
  IF eligible = 0 THEN
    RAISE EXCEPTION 'account_pubkey has 0 resolved rows — run Phase 1 first';
  END IF;
  RAISE NOTICE 'eligible accounts: %', eligible;
END $$;

-- ─── 1. pnl_history — unique(accountId, marketId, time), plain UPDATE ──────

UPDATE pnl_history p
SET "walletAddr" = ap.pubkey
FROM account_pubkey ap
WHERE p."accountId" = ap."accountId"
  AND p."walletAddr" = 'account:' || ap."accountId"
  AND ap.pubkey IS NOT NULL;

-- ─── 2. funding_history — unique(accountId, marketId, time), plain UPDATE ─

UPDATE funding_history p
SET "walletAddr" = ap.pubkey
FROM account_pubkey ap
WHERE p."accountId" = ap."accountId"
  AND p."walletAddr" = 'account:' || ap."accountId"
  AND ap.pubkey IS NOT NULL;

-- ─── 3. trade_history — unique(tradeId), plain UPDATE ──────────────────────

UPDATE trade_history p
SET "walletAddr" = ap.pubkey
FROM account_pubkey ap
WHERE p."accountId" = ap."accountId"
  AND p."walletAddr" = 'account:' || ap."accountId"
  AND ap.pubkey IS NOT NULL;

-- ─── 4. order_history — unique(orderId), plain UPDATE ──────────────────────

UPDATE order_history p
SET "walletAddr" = ap.pubkey
FROM account_pubkey ap
WHERE p."accountId" = ap."accountId"
  AND p."walletAddr" = 'account:' || ap."accountId"
  AND ap.pubkey IS NOT NULL;

-- ─── 5. deposit_history — unique(walletAddr, time, amount), dedup + update ─

DELETE FROM deposit_history p
USING deposit_history r, account_pubkey ap
WHERE ap.pubkey IS NOT NULL
  AND p."accountId"  = ap."accountId"
  AND p."walletAddr" = 'account:' || ap."accountId"
  AND r."accountId"  = p."accountId"
  AND r."time"       = p."time"
  AND r."amount"     = p."amount"
  AND r."walletAddr" = ap.pubkey;

UPDATE deposit_history p
SET "walletAddr" = ap.pubkey
FROM account_pubkey ap
WHERE p."accountId" = ap."accountId"
  AND p."walletAddr" = 'account:' || ap."accountId"
  AND ap.pubkey IS NOT NULL;

-- ─── 6. withdrawal_history — unique(walletAddr, time, amount) ──────────────

DELETE FROM withdrawal_history p
USING withdrawal_history r, account_pubkey ap
WHERE ap.pubkey IS NOT NULL
  AND p."accountId"  = ap."accountId"
  AND p."walletAddr" = 'account:' || ap."accountId"
  AND r."accountId"  = p."accountId"
  AND r."time"       = p."time"
  AND r."amount"     = p."amount"
  AND r."walletAddr" = ap.pubkey;

UPDATE withdrawal_history p
SET "walletAddr" = ap.pubkey
FROM account_pubkey ap
WHERE p."accountId" = ap."accountId"
  AND p."walletAddr" = 'account:' || ap."accountId"
  AND ap.pubkey IS NOT NULL;

-- ─── 7. liquidation_history — unique(walletAddr, time, fee) ────────────────

DELETE FROM liquidation_history p
USING liquidation_history r, account_pubkey ap
WHERE ap.pubkey IS NOT NULL
  AND p."accountId"  = ap."accountId"
  AND p."walletAddr" = 'account:' || ap."accountId"
  AND r."accountId"  = p."accountId"
  AND r."time"       = p."time"
  AND r."fee"        = p."fee"
  AND r."walletAddr" = ap.pubkey;

UPDATE liquidation_history p
SET "walletAddr" = ap.pubkey
FROM account_pubkey ap
WHERE p."accountId" = ap."accountId"
  AND p."walletAddr" = 'account:' || ap."accountId"
  AND ap.pubkey IS NOT NULL;

-- ─── 8. pnl_totals — walletAddr unique ─────────────────────────────────────

DELETE FROM pnl_totals p
USING pnl_totals r, account_pubkey ap
WHERE ap.pubkey IS NOT NULL
  AND p."accountId"  = ap."accountId"
  AND p."walletAddr" = 'account:' || ap."accountId"
  AND r."accountId"  = p."accountId"
  AND r."walletAddr" = ap.pubkey;

UPDATE pnl_totals p
SET "walletAddr" = ap.pubkey
FROM account_pubkey ap
WHERE p."accountId" = ap."accountId"
  AND p."walletAddr" = 'account:' || ap."accountId"
  AND ap.pubkey IS NOT NULL;

-- ─── 9. volume_calendar — unique(walletAddr, date) ─────────────────────────

DELETE FROM volume_calendar p
USING volume_calendar r, account_pubkey ap
WHERE ap.pubkey IS NOT NULL
  AND p."accountId"  = ap."accountId"
  AND p."walletAddr" = 'account:' || ap."accountId"
  AND r."accountId"  = p."accountId"
  AND r."date"       = p."date"
  AND r."walletAddr" = ap.pubkey;

UPDATE volume_calendar p
SET "walletAddr" = ap.pubkey
FROM account_pubkey ap
WHERE p."accountId" = ap."accountId"
  AND p."walletAddr" = 'account:' || ap."accountId"
  AND ap.pubkey IS NOT NULL;

-- ─── 10. sync_cursors — placeholders are dead after schema fix ─────────────

DELETE FROM sync_cursors sc
USING account_pubkey ap
WHERE ap.pubkey IS NOT NULL
  AND sc."walletAddr" = 'account:' || ap."accountId";

-- ─── 11. leaderboard_tiers — walletAddr denormalized, keep fresh ───────────

UPDATE leaderboard_tiers lt
SET "walletAddr" = ap.pubkey
FROM account_pubkey ap
WHERE lt."accountId" = ap."accountId"
  AND lt."walletAddr" = 'account:' || ap."accountId"
  AND ap.pubkey IS NOT NULL;

-- ─── Sanity: placeholder rows remaining should equal notFound count ────────

SELECT 'pnl_history'      AS t, COUNT(*)::int AS remaining FROM pnl_history      WHERE "walletAddr" LIKE 'account:%'
UNION ALL SELECT 'funding_history',    COUNT(*)::int FROM funding_history    WHERE "walletAddr" LIKE 'account:%'
UNION ALL SELECT 'trade_history',      COUNT(*)::int FROM trade_history      WHERE "walletAddr" LIKE 'account:%'
UNION ALL SELECT 'order_history',      COUNT(*)::int FROM order_history      WHERE "walletAddr" LIKE 'account:%'
UNION ALL SELECT 'deposit_history',    COUNT(*)::int FROM deposit_history    WHERE "walletAddr" LIKE 'account:%'
UNION ALL SELECT 'withdrawal_history', COUNT(*)::int FROM withdrawal_history WHERE "walletAddr" LIKE 'account:%'
UNION ALL SELECT 'liquidation_history',COUNT(*)::int FROM liquidation_history WHERE "walletAddr" LIKE 'account:%'
UNION ALL SELECT 'pnl_totals',         COUNT(*)::int FROM pnl_totals         WHERE "walletAddr" LIKE 'account:%'
UNION ALL SELECT 'volume_calendar',    COUNT(*)::int FROM volume_calendar    WHERE "walletAddr" LIKE 'account:%';

COMMIT;
