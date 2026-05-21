-- =============================================================================
--  2026-05-21 — anomaly_alerts: detected suspicious patterns on sign_log
-- =============================================================================
--
--  History DB (TimescaleDB). Run with:
--    psql "$HISTORY_DATABASE_URL" -f sql/2026-05-21_anomaly_alerts.sql
--
--  Idempotent.
--
--  Purpose: scheduled scanner (`anomaly-scan` pg-boss job, every minute)
--  reads the last 5 minutes of `sign_log` and writes a row here for
--  each detected pattern. Sentry is notified at insert time so an
--  on-call sees the anomaly in real time. The row persists so an
--  operator can later cross-reference what alarms fired and when.
--
--  Why a table and not just Sentry: dedup. Without a unique key on
--  (kind, scope_key, window_minute) we'd fire Sentry every minute for
--  the same ongoing burst. The ON CONFLICT DO NOTHING gate ensures
--  one alarm per anomaly window.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS anomaly_alerts (
  id          BIGSERIAL PRIMARY KEY,

  -- Alarm category, e.g. 'burst' / 'refused-spike' / 'mark-deviation' /
  -- 'leverage-spike'.
  kind        TEXT NOT NULL,

  -- Scope key — typically a wallet or market id. Lets us dedup
  -- per-target instead of system-wide.
  scope_key   TEXT NOT NULL,

  -- Window bucket the alarm covers. Truncated to minute so two scans
  -- within the same minute don't double-insert.
  window_minute TIMESTAMPTZ NOT NULL,

  -- Human-readable summary + structured details for the dashboard.
  severity    TEXT NOT NULL DEFAULT 'warning',
  -- 'warning' / 'critical' — informational only, doesn't auto-pause.
  message     TEXT NOT NULL,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,

  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dedup: one row per (kind, scope_key, window_minute).
CREATE UNIQUE INDEX IF NOT EXISTS anomaly_alerts_dedup_idx
  ON anomaly_alerts (kind, scope_key, window_minute);

-- Admin view: newest-first by kind.
CREATE INDEX IF NOT EXISTS anomaly_alerts_kind_detected_idx
  ON anomaly_alerts (kind, detected_at DESC);

CREATE INDEX IF NOT EXISTS anomaly_alerts_detected_idx
  ON anomaly_alerts (detected_at DESC);

COMMIT;
