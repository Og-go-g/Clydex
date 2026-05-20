-- =============================================================================
--  2026-05-20 — system_flags table for the copy-engine kill switch  [Week 1 C7]
-- =============================================================================
--
--  History DB (TimescaleDB). Run with:
--    psql "$HISTORY_DATABASE_URL" -f sql/2026-05-20_system_flags.sql
--
--  Idempotent — safe to re-run.
--
--  Purpose: hold a small set of operational boolean flags that the worker
--  reads on every signing path. Initial flag is `copy_trading_paused` —
--  flipped by the admin /api/admin/copy/pause endpoint to halt all
--  signing within KILL_SWITCH_TTL_MS (2 seconds) when a compromise is
--  suspected.
--
--  Design notes:
--    - Tiny table, one row per flag. ON CONFLICT DO NOTHING so the
--      seed insert is idempotent.
--    - reason / updated_by columns are nullable for the default
--      "not paused" row but the API enforces both on actual flips.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS system_flags (
  flag_name   TEXT PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT false,
  reason      TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT
);

-- Seed the copy-trading kill-switch row in the "not paused" state.
-- If a deploy lands with the table but no row, lib/copytrade/kill-switch.ts
-- treats the absence as paused (fail closed) — that would freeze new
-- signing until an operator runs this migration, which is the correct
-- behaviour but inconvenient.
INSERT INTO system_flags (flag_name, enabled, reason, updated_by)
VALUES ('copy_trading_paused', false, NULL, 'migration:2026-05-20')
ON CONFLICT (flag_name) DO NOTHING;

COMMIT;
