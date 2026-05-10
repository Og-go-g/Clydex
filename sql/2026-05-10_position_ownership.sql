-- Position ownership table — implements "one leader per market" rule.
--
-- Each (follower, market) at most one owning leader at a time.
-- Ownership held while the follower has an open copy-position from
-- that leader. Engine writes the row on a successful open/increase
-- (action=open|increase|flip) and deletes it on full close (action=close
-- with newSize=0).
--
-- See memory/copytrade_engine_audit_2026_05_10.md for the agreed design.
--
-- Edge cases:
--   - Race on same cycle (A,B both trade BTC): processed by
--     subscription.created_at ASC; older sub wins ownership.
--   - Manual user position in market with no ownership row: engine
--     treats as locked-by-manual, skips.
--   - Unfollow with "keep positions": ON DELETE SET NULL on
--     subscription_id leaves orphan ownership; market stays blocked
--     until follower closes manually.
--   - Unfollow with "close positions": close_positions logic deletes
--     ownership rows for that (follower, leader).
--
-- Backfill for existing followers: for each (follower, market) where
-- the follower has an open copy-position (latest filled copy_trade
-- per market with non-zero net size), owner = leader of that latest
-- filled trade. Run after table create.

BEGIN;

CREATE TABLE IF NOT EXISTS copy_position_ownership (
  follower_addr      TEXT NOT NULL,
  market_id          INT  NOT NULL,
  owning_leader_addr TEXT NOT NULL,
  subscription_id    TEXT REFERENCES copy_subscriptions(id) ON DELETE SET NULL,
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_addr, market_id)
);

CREATE INDEX IF NOT EXISTS idx_ownership_leader
  ON copy_position_ownership(owning_leader_addr);

CREATE INDEX IF NOT EXISTS idx_ownership_subscription
  ON copy_position_ownership(subscription_id)
  WHERE subscription_id IS NOT NULL;

-- Backfill is best-effort. We don't have access to the exchange from
-- a SQL migration, so we can't tell which (follower, market) pairs
-- ACTUALLY have an open position right now vs were closed weeks ago.
--
-- Heuristic: take the latest filled copy_trade per (follower, market)
-- where the trade is recent (last 30d) AND the subscription is still
-- active. This minimizes false-positive ownership rows that would
-- block other leaders from a market the follower already closed.
--
-- False-positive case that survives: follower had BTC from leader A,
-- closed BTC last week, subscription to A still active. Backfill marks
-- A as BTC owner. If user later subscribes to leader B who also trades
-- BTC, B is blocked. Mitigation: unfollow A → ownership row's
-- subscription_id becomes NULL via FK SET NULL → still blocks (orphan
-- lock). Cleanup path: future admin endpoint OR auto-prune orphans
-- older than 7d. Acceptable for current scale; revisit if real users
-- hit this.
INSERT INTO copy_position_ownership (follower_addr, market_id, owning_leader_addr, subscription_id, opened_at)
SELECT DISTINCT ON (ct.follower_addr, ct.market_id)
  ct.follower_addr,
  ct.market_id,
  ct.leader_addr,
  ct.subscription_id,
  ct.created_at
FROM copy_trades ct
JOIN copy_subscriptions cs
  ON cs.follower_addr = ct.follower_addr
  AND cs.leader_addr = ct.leader_addr
  AND cs.active = TRUE
WHERE ct.status = 'filled'
  AND ct.created_at > NOW() - INTERVAL '30 days'
ORDER BY ct.follower_addr, ct.market_id, ct.created_at DESC
ON CONFLICT (follower_addr, market_id) DO NOTHING;

COMMIT;
