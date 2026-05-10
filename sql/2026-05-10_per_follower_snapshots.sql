-- Per-follower copy snapshots — fixes silent loss of failed copy trades.
--
-- Before: copy_snapshots(leader_addr, market_id) — single snapshot per
-- leader, shared across all their followers. The engine updated this
-- snapshot to current leader state BEFORE confirming follower orders. If
-- a follower's order failed (network blip, exchange 502, etc.), the next
-- cycle saw "leader unchanged" and never retried — the trade was lost
-- silently.
--
-- After: each follower has their own snapshot of where they last
-- successfully copied this leader. Failed trades naturally re-appear as
-- diffs on the next cycle for THAT specific follower (their snapshot
-- didn't advance for that market), while successful followers move on.
-- Snapshot itself becomes the retry queue — no separate failed-trade
-- table needed.
--
-- Truncate is safe: snapshots only store "what we last observed the
-- leader doing for this follower". Existing exchange positions are NOT
-- touched. After migration, the next engine cycle treats every
-- (follower, leader) as a fresh first-run — no diffs computed, snapshot
-- populated to current leader state. Trades that fired in the
-- ~1-minute migration window for any leader will be missed by all their
-- followers — acceptable for low-traffic leaders.

BEGIN;

-- Drop old leader-only uniqueness; we now key on (follower, leader, market).
ALTER TABLE copy_snapshots
  DROP CONSTRAINT IF EXISTS copy_snapshots_leader_addr_market_id_key;

-- Add follower_addr (nullable temporarily so we can ALTER without data).
ALTER TABLE copy_snapshots
  ADD COLUMN IF NOT EXISTS follower_addr TEXT;

-- Wipe — see header for rationale.
TRUNCATE copy_snapshots;

-- Now require follower_addr.
ALTER TABLE copy_snapshots
  ALTER COLUMN follower_addr SET NOT NULL;

-- New uniqueness key.
ALTER TABLE copy_snapshots
  ADD CONSTRAINT copy_snapshots_follower_leader_market_key
  UNIQUE (follower_addr, leader_addr, market_id);

-- Per-follower lookup index (engine reads `WHERE follower_addr = ? AND leader_addr = ?`).
CREATE INDEX IF NOT EXISTS idx_snapshots_follower_leader
  ON copy_snapshots(follower_addr, leader_addr);

-- Old leader-only index is now redundant for the engine but keep it for
-- potential admin/debug queries that group by leader.
-- (idx_copy_snapshots_leader stays as-is from copy-trading-schema.sql)

COMMIT;
