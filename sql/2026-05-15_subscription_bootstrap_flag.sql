-- Explicit bootstrap flag for copy_subscriptions.
--
-- Before: engine used `copy_snapshots(follower, leader).length === 0`
-- as the "is this the first cycle for this follower×leader pair"
-- signal. This only worked when leader had positions at first-run —
-- the engine'd populate one row per market, snapshots became
-- non-empty, isFirstRun went false, normal diff flow took over.
--
-- The bug: when leader had ZERO positions at first-run, no snapshot
-- rows were written → isFirstRun stayed true forever. Every NEW
-- position the leader subsequently opened was treated as "bootstrap
-- baseline" (snapshot upserted, no copy executed). Only positions
-- AFTER the first leader trade got mirrored. The very first one,
-- silently lost.
--
-- After: `bootstrapped_at TIMESTAMPTZ` in copy_subscriptions. NULL
-- means "haven't run first-cycle yet". Engine sets it to NOW() at
-- the END of the first-run block, regardless of whether positions
-- existed. Subsequent cycles see it set → treat as not-first-run →
-- normal diff flow, including detecting "leader opened first
-- position" as an open diff against the empty snapshot.
--
-- Backfill: existing subscriptions that already have ≥1 snapshot
-- row are marked bootstrapped at migration time — engine has clearly
-- already run first-run for them. Subscriptions with no snapshots
-- (zero-position leaders, or never-cycled new subs) stay NULL → will
-- bootstrap on the next engine cycle.

BEGIN;

ALTER TABLE copy_subscriptions
  ADD COLUMN IF NOT EXISTS bootstrapped_at TIMESTAMPTZ;

UPDATE copy_subscriptions cs
SET bootstrapped_at = NOW()
WHERE bootstrapped_at IS NULL
  AND EXISTS (
    SELECT 1 FROM copy_snapshots sn
    WHERE sn.follower_addr = cs.follower_addr
      AND sn.leader_addr = cs.leader_addr
  );

COMMIT;
