-- =============================================================================
--  2026-05-21 — audit-table lockdown: take ownership away from `clydex`
-- =============================================================================
--
--  MUST run as the `postgres` superuser, NOT as `clydex`. Run with:
--    sudo -u postgres psql -d clydex_history \
--      -f sql/2026-05-21_audit_table_lockdown.sql
--
--  Why a separate file from the original sign_log / anomaly_alerts
--  migrations:
--
--   Postgres grants UPDATE/DELETE separately from ownership. The
--   original migration ran as `clydex` (whoever owns the connection
--   URL), so `clydex` became the table owner — and an OWNER has every
--   privilege implicitly, including TRUNCATE and DROP. The
--   `REVOKE UPDATE, DELETE` in the original migration is a no-op
--   against the owner.
--
--   For the audit invariant to hold ("a compromised app role cannot
--   wipe history") we have to take ownership AWAY from `clydex` and
--   grant only the explicit privileges back. That requires superuser
--   (only superuser can ALTER TABLE OWNER on a table the calling
--   role doesn't own).
--
--  Effect after this runs:
--   - Owner becomes `postgres`. Future schema migrations on these
--     tables must run under `postgres` — list maintained at the
--     bottom of this file.
--   - `clydex` has only INSERT + SELECT on sign_log + anomaly_alerts
--     (UPDATE/DELETE/TRUNCATE/DROP all refused).
--   - Sequence is also transferred so `clydex` can't reset the
--     BIGSERIAL counter (which would let an attacker rewrite ids
--     and re-arrange the apparent chain order).
--
--  This is the "tamper-PROOF at the app role" pillar of the audit
--  trail. The other pillar — surviving compromise of the postgres
--  role itself — needs the off-box mirror (Week 4 ops work).
-- =============================================================================

BEGIN;

-- ─── sign_log ────────────────────────────────────────────────

ALTER TABLE sign_log OWNER TO postgres;
ALTER SEQUENCE sign_log_id_seq OWNER TO postgres;

-- Re-issue the only privileges the app needs. Append-only audit:
-- the engine writes new rows; users + admin SELECT to verify.
GRANT INSERT, SELECT ON sign_log TO clydex;
GRANT USAGE, SELECT ON SEQUENCE sign_log_id_seq TO clydex;

-- Belt-and-suspenders: explicit REVOKE of every dangerous privilege
-- (REVOKE on a non-owner actually has effect now).
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON sign_log FROM clydex;

-- ─── anomaly_alerts ──────────────────────────────────────────

ALTER TABLE anomaly_alerts OWNER TO postgres;
ALTER SEQUENCE anomaly_alerts_id_seq OWNER TO postgres;

-- Anomaly scanner needs to write detections (INSERT, with ON CONFLICT
-- DO NOTHING for dedup) and read recent rows for the admin endpoint.
-- It does NOT need to UPDATE — once an alarm fires, the row is the
-- historical record. DELETE is reserved for explicit operator
-- cleanup via direct psql.
GRANT INSERT, SELECT ON anomaly_alerts TO clydex;
GRANT USAGE, SELECT ON SEQUENCE anomaly_alerts_id_seq TO clydex;

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON anomaly_alerts FROM clydex;

COMMIT;

-- -----------------------------------------------------------------------------
-- Post-deploy verification (run separately, NOT in this transaction):
--
--   -- Should show INSERT + SELECT only — NO UPDATE/DELETE/TRUNCATE:
--   SELECT privilege_type
--   FROM information_schema.table_privileges
--   WHERE table_name IN ('sign_log', 'anomaly_alerts')
--     AND grantee = 'clydex'
--   ORDER BY table_name, privilege_type;
--
--   -- Owner should now be `postgres`:
--   SELECT schemaname, tablename, tableowner
--   FROM pg_tables
--   WHERE tablename IN ('sign_log', 'anomaly_alerts');
--
--   -- App-level smoke: insert via clydex should still succeed,
--   -- TRUNCATE should refuse. From the worker container:
--   --   psql "$HISTORY_DATABASE_URL" -c 'TRUNCATE sign_log;'
--   --   → ERROR: permission denied for table sign_log
-- -----------------------------------------------------------------------------
--
-- Future-maintenance note: any schema change to sign_log or
-- anomaly_alerts (add column, rename, drop index, etc.) MUST run as
-- postgres now. Pattern:
--
--   sudo -u postgres psql -d clydex_history -f sql/<future_migration>.sql
--
-- If we ever want to add a column WITHOUT superuser access, we'd
-- need to either pre-grant ALTER on the table to clydex (rare in
-- prod-grade Postgres) or transfer ownership back temporarily. The
-- superuser path is the standard pattern for locked-down audit
-- tables — keep it.
-- -----------------------------------------------------------------------------
