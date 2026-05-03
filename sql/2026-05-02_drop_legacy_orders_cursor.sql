-- ============================================================================
-- Cleanup: drop legacy `orders` rows from sync_cursors.
--
-- Context: orders sync was retired on 2026-04-19 (see
-- sql/2026-04-19_orders_from_trades.sql) — Order History is now derived
-- from trade_history GROUP BY orderId. The cursor type "orders" no
-- longer corresponds to any active sync function (see SYNC_FNS in
-- lib/history/sync.ts), so the rows just sit in the table forever
-- with stale lastSyncAt = 2026-04-19.
--
-- Verified harmless before drop:
--   - No code path reads cursor rows of type 'orders' (grep confirms).
--   - SYNC_FNS["orders"] doesn't exist — getCursor would never look it up.
--   - pgbouncer/Prisma never returns these to anyone.
--
-- This is pure noise reduction. Idempotent — re-runs are no-ops once
-- the rows are gone.
-- ============================================================================

DELETE FROM sync_cursors WHERE type = 'orders';
