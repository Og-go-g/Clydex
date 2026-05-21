-- =============================================================================
--  2026-05-21 — sign_log: hash-chained append-only audit of copy signs  [C7 W3]
-- =============================================================================
--
--  History DB (TimescaleDB). Run with:
--    psql "$HISTORY_DATABASE_URL" -f sql/2026-05-21_sign_log.sql
--
--  Idempotent — safe to re-run.
--
--  Purpose: every time the copy engine signs an action on behalf of a
--  follower, append a row here. Each row carries a SHA-256 hash chain
--  to the previous row's hash, so an attacker who later gets full DB
--  access cannot quietly tamper with their own sign event without
--  invalidating every subsequent row's hash. The "true" chain root is
--  the latest row's `this_hash`, which we periodically pin off-box
--  (separate-provider Postgres mirror, eventually a Solana memo tx —
--  see the runbook at docs/runbooks/key-compromise.md).
--
--  Defense-in-depth posture: by itself this table is "tamper-evident"
--  but NOT "tamper-proof" — an attacker with full DB access can still
--  recompute the chain from their tampered row forward. Tamper-proof
--  requires the off-box mirror, which is operational work scheduled
--  for Week 3+ of the production-hardening roadmap.
--
--  Access pattern:
--    - Worker (clydex role): INSERT only. Computed columns enforce the
--      chain. UPDATE/DELETE revoked so even a compromised worker
--      cannot patch history.
--    - /api/copy/sign-log: SELECT scoped to the authenticated wallet.
--    - Operator (postgres role): SELECT everywhere; UPDATE/DELETE
--      possible but auditable via PostgreSQL's own log.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS sign_log (
  -- Strict ascending sequence — chain order ≡ id order.
  id              BIGSERIAL PRIMARY KEY,

  -- Who signed. follower_wallet matches `copy_sessions.wallet_addr`.
  follower_wallet TEXT NOT NULL,
  leader_wallet   TEXT,

  -- What was signed. action: 'open' | 'close' | 'increase' | 'decrease' | 'flip'
  -- Plus market metadata so the user can verify (independently of our
  -- aggregated tables) what their delegate signed.
  action          TEXT NOT NULL,
  market_id       INTEGER NOT NULL,
  symbol          TEXT NOT NULL,
  side            TEXT NOT NULL,
  size            NUMERIC(30, 18) NOT NULL,
  leverage        NUMERIC(10, 6) NOT NULL,
  slippage        NUMERIC(10, 6) NOT NULL,

  -- Reference price snapshot at sign time. Auditor can compare against
  -- 01 Exchange's historical mark to verify we didn't sign at adversarial
  -- prices (post-hoc anomaly check).
  mark_price      NUMERIC(30, 18) NOT NULL,

  -- Policy verdict captured BEFORE the SDK call.
  -- 'approved' | 'refused:<reason>' (mirrors signing-policy.ts return shape)
  policy_result   TEXT NOT NULL,

  -- Hash chain. prev_hash is the previous row's this_hash (or 32 zero
  -- bytes for row 1). this_hash = SHA256(prev_hash || serialize(this row sans hashes)).
  -- Computed in the application (lib/copytrade/sign-log.ts) so the
  -- worker can pre-commit the chain before INSERT.
  prev_hash       BYTEA NOT NULL,
  this_hash       BYTEA NOT NULL,

  -- Timestamps. signed_at is when our process invoked the SDK; created_at
  -- is when the row hit Postgres (almost the same, but differs under
  -- DB load and is useful for debugging insert lag).
  signed_at       TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Read paths: by follower (the user's own log) and by leader (audit
-- which followers got copied from a given leader).
CREATE INDEX IF NOT EXISTS sign_log_follower_idx
  ON sign_log (follower_wallet, id DESC);

CREATE INDEX IF NOT EXISTS sign_log_leader_idx
  ON sign_log (leader_wallet, id DESC);

CREATE INDEX IF NOT EXISTS sign_log_signed_at_idx
  ON sign_log (signed_at);

-- Lock the table down. The app's `clydex` role can ONLY insert; the
-- chain is the integrity primitive but revoking UPDATE/DELETE makes
-- tamper-evidence resistant to an SQL-injection / app-compromise
-- attacker who could otherwise patch a single row without touching
-- the chain machinery.
--
-- Note: `clydex` is whatever the app's DB user is named. Both
-- DATABASE_URL and HISTORY_DATABASE_URL typically use this role; if
-- your local dev uses a different name (e.g. `postgres` superuser),
-- the REVOKE below is a no-op there (superuser bypasses grants).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clydex') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON sign_log FROM clydex';
    EXECUTE 'GRANT INSERT, SELECT ON sign_log TO clydex';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE sign_log_id_seq TO clydex';
  END IF;
END
$$;

COMMIT;

-- -----------------------------------------------------------------------------
-- Post-deploy verification (run separately, not in this transaction):
--
--   -- Confirm the role grants stuck:
--   SELECT grantee, privilege_type
--   FROM information_schema.table_privileges
--   WHERE table_name = 'sign_log' AND grantee = 'clydex';
--   -- Expect rows for INSERT and SELECT, NOT for UPDATE/DELETE.
--
--   -- Sanity-check the chain after some traffic:
--   SELECT id, follower_wallet, action, encode(this_hash, 'hex') AS hash
--   FROM sign_log ORDER BY id DESC LIMIT 5;
-- -----------------------------------------------------------------------------
