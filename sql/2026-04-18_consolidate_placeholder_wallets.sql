-- ============================================================================
-- Consolidate placeholder walletAddr rows into real-wallet rows.
--
-- PROBLEM
-- -------
-- History tables accumulated duplicate rows per event because the sync
-- pipeline inserted under placeholder walletAddr 'account:<id>' the first
-- time it saw an account (no real wallet resolved yet), then inserted again
-- under the real wallet after resolution. The unique constraint was on
-- (walletAddr, marketId, time) — different walletAddr values bypassed it.
-- Each sync_cursors entry is also keyed by walletAddr, so the second sync
-- started from scratch and reinserted everything.
--
-- Result: ~2× storage and 2× SUMs in aggregate queries.
--
-- STRATEGY
-- --------
-- 1. Build accountId → real_wallet mapping from existing rows (pnl_history
--    and trade_history, whichever has it).
-- 2. For tables with event-level natural key (pnl_history, funding_history):
--      a. DELETE placeholder rows where a real-wallet twin exists for the
--         same (accountId, marketId, time) — the real copy has identical
--         numbers and won a later sync. Duplicate removed, no data lost.
--      b. UPDATE remaining placeholder rows (no real twin) → set walletAddr
--         to the mapped real wallet. These represent events only the
--         placeholder-scoped sync captured.
-- 3. For trade_history (globally unique on tradeId): no physical duplicates
--    across walletAddr values possible. Just UPDATE placeholder → real.
-- 4. For derived tables (pnl_totals, volume_calendar): delete+update by
--    the table's natural key (walletAddr alone for totals; walletAddr+date
--    for calendar).
-- 5. sync_cursors: drop all placeholder cursors. Next real-wallet sync
--    writes fresh cursor under real walletAddr.
--
-- Rows belonging to accounts we never resolved to a real wallet (i.e. no
-- real row exists anywhere for that accountId) stay under placeholder
-- walletAddr. They will be consolidated on first successful sync once the
-- schema fix (step 6 below) is in place.
--
-- SCHEMA FIX (separate migration, see 2026-04-18_unique_by_accountid.sql)
-- --------
-- Change unique constraint on pnl_history / funding_history to
-- (accountId, marketId, time) and change sync_cursors key to accountId.
-- This prevents future duplicates even if placeholder syncs happen again.
--
-- RUN ORDER
-- ---------
-- 1. docker compose stop worker        # no writes during migration
-- 2. psql -f this-file                 # transactional cleanup
-- 3. VACUUM FULL per table (offline)   # reclaim disk
-- 4. apply 2026-04-18_unique_by_accountid.sql
-- 5. docker compose start worker
-- ============================================================================

\timing on

BEGIN;

-- ─── 1. Authoritative accountId → real walletAddr mapping ──────────────────

CREATE TEMP TABLE account_wallet_map ON COMMIT DROP AS
WITH from_pnl AS (
  SELECT "accountId", "walletAddr", COUNT(*) AS n
  FROM pnl_history
  WHERE "walletAddr" NOT LIKE 'account:%'
  GROUP BY "accountId", "walletAddr"
),
from_trade AS (
  SELECT "accountId", "walletAddr", COUNT(*) AS n
  FROM trade_history
  WHERE "walletAddr" NOT LIKE 'account:%'
  GROUP BY "accountId", "walletAddr"
),
from_fund AS (
  SELECT "accountId", "walletAddr", COUNT(*) AS n
  FROM funding_history
  WHERE "walletAddr" NOT LIKE 'account:%'
  GROUP BY "accountId", "walletAddr"
),
unified AS (
  SELECT * FROM from_pnl
  UNION ALL SELECT * FROM from_trade
  UNION ALL SELECT * FROM from_fund
),
ranked AS (
  -- For each accountId pick the walletAddr with the most rows across tables.
  -- In practice one accountId maps to one real wallet; this is a safety net
  -- against accidental historical misrouting.
  SELECT "accountId", "walletAddr",
         ROW_NUMBER() OVER (
           PARTITION BY "accountId" ORDER BY SUM(n) DESC, "walletAddr"
         ) AS rn
  FROM unified
  GROUP BY "accountId", "walletAddr"
)
SELECT "accountId", "walletAddr" AS real_wallet
FROM ranked WHERE rn = 1;

CREATE INDEX ON account_wallet_map ("accountId");

-- Count of accounts we can consolidate vs stuck-on-placeholder-only
SELECT
  (SELECT COUNT(*) FROM account_wallet_map)                                  AS accounts_with_real_wallet,
  (SELECT COUNT(DISTINCT "accountId") FROM pnl_history
     WHERE "accountId" NOT IN (SELECT "accountId" FROM account_wallet_map))  AS placeholder_only_accounts;

-- ─── 2. pnl_history ────────────────────────────────────────────────────────

-- (a) drop placeholder rows that have a real-wallet twin (same event)
DELETE FROM pnl_history p
USING pnl_history r
WHERE p."walletAddr" LIKE 'account:%'
  AND r."accountId"  = p."accountId"
  AND r."marketId"   = p."marketId"
  AND r."time"       = p."time"
  AND r."walletAddr" NOT LIKE 'account:%';

-- (b) promote orphan placeholder rows to the real walletAddr
UPDATE pnl_history p
SET "walletAddr" = m.real_wallet
FROM account_wallet_map m
WHERE p."walletAddr" LIKE 'account:%'
  AND p."accountId" = m."accountId";

-- ─── 3. funding_history ────────────────────────────────────────────────────

DELETE FROM funding_history p
USING funding_history r
WHERE p."walletAddr" LIKE 'account:%'
  AND r."accountId"  = p."accountId"
  AND r."marketId"   = p."marketId"
  AND r."time"       = p."time"
  AND r."walletAddr" NOT LIKE 'account:%';

UPDATE funding_history p
SET "walletAddr" = m.real_wallet
FROM account_wallet_map m
WHERE p."walletAddr" LIKE 'account:%'
  AND p."accountId" = m."accountId";

-- ─── 4. trade_history ──────────────────────────────────────────────────────
-- Unique on tradeId alone. Different walletAddr values can't share a tradeId
-- (ON CONFLICT in sync.ts drops the 2nd insert). So no physical dedup needed.
-- Just align walletAddr for rows that were bucketed to placeholder.

UPDATE trade_history p
SET "walletAddr" = m.real_wallet
FROM account_wallet_map m
WHERE p."walletAddr" LIKE 'account:%'
  AND p."accountId" = m."accountId";

-- ─── 5. pnl_totals ─────────────────────────────────────────────────────────

DELETE FROM pnl_totals p
USING pnl_totals r
WHERE p."walletAddr" LIKE 'account:%'
  AND r."accountId"  = p."accountId"
  AND r."walletAddr" NOT LIKE 'account:%';

UPDATE pnl_totals p
SET "walletAddr" = m.real_wallet
FROM account_wallet_map m
WHERE p."walletAddr" LIKE 'account:%'
  AND p."accountId" = m."accountId";

-- ─── 6. volume_calendar ────────────────────────────────────────────────────

DELETE FROM volume_calendar p
USING volume_calendar r
WHERE p."walletAddr" LIKE 'account:%'
  AND r."accountId"  = p."accountId"
  AND r.date         = p.date
  AND r."walletAddr" NOT LIKE 'account:%';

UPDATE volume_calendar p
SET "walletAddr" = m.real_wallet
FROM account_wallet_map m
WHERE p."walletAddr" LIKE 'account:%'
  AND p."accountId" = m."accountId";

-- ─── 7. sync_cursors ───────────────────────────────────────────────────────
-- Drop placeholder cursors entirely. Next sync under real walletAddr writes
-- a fresh cursor. No data lost — sync_cursors is just a lastSyncAt marker.

DELETE FROM sync_cursors WHERE "walletAddr" LIKE 'account:%';

-- ─── 8. Final placeholder-row count (sanity) ───────────────────────────────
-- Expected: non-zero only for accounts whose real wallet was never observed
-- anywhere in the raw tables. Those stay as placeholder until first real sync.

SELECT 'pnl_history'      AS table_name, COUNT(*) AS remaining_placeholder FROM pnl_history      WHERE "walletAddr" LIKE 'account:%'
UNION ALL
SELECT 'funding_history',                COUNT(*)                         FROM funding_history WHERE "walletAddr" LIKE 'account:%'
UNION ALL
SELECT 'trade_history',                  COUNT(*)                         FROM trade_history   WHERE "walletAddr" LIKE 'account:%'
UNION ALL
SELECT 'pnl_totals',                     COUNT(*)                         FROM pnl_totals      WHERE "walletAddr" LIKE 'account:%'
UNION ALL
SELECT 'volume_calendar',                COUNT(*)                         FROM volume_calendar WHERE "walletAddr" LIKE 'account:%';

-- REVIEW COUNTS ABOVE.
-- If anything looks wrong: ROLLBACK;
-- If everything as expected: COMMIT;

-- Uncomment to auto-commit (script mode). Recommended to run interactive.
COMMIT;
