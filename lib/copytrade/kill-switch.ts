/**
 * Copy-trading kill switch.
 *
 * One row in `system_flags` (`flag_name='copy_trading_paused'`) that the
 * copy engine consults before signing. Hit by the
 * /api/admin/copy/pause and /api/admin/copy/resume admin endpoints.
 *
 * The signing loop reads through a small in-memory TTL cache so a peak-
 * load cycle doesn't issue 100s of identical DB queries; the trade-off
 * is at most KILL_SWITCH_TTL_MS of staleness between a pause toggle
 * and the next tick refusing to sign. 2 seconds is the documented
 * upper bound — tested against the worst case of "alert fires, admin
 * hits pause, engine still signs the in-flight tick" — and is short
 * enough that an attacker's signing burst is bounded to a single
 * cycle (15s tick × at most one mid-cycle batch).
 *
 * Schema (sql/2026-05-20_system_flags.sql):
 *
 *   CREATE TABLE system_flags (
 *     flag_name   TEXT PRIMARY KEY,
 *     enabled     BOOLEAN NOT NULL DEFAULT false,
 *     reason      TEXT,
 *     updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     updated_by  TEXT
 *   );
 *   INSERT INTO system_flags (flag_name) VALUES ('copy_trading_paused');
 */

import { query, execute } from "../db-history";

const KILL_SWITCH_FLAG = "copy_trading_paused";
const KILL_SWITCH_TTL_MS = 2_000;

interface CachedFlag {
  value: boolean;
  reason: string | null;
  fetchedAt: number;
}

let cache: CachedFlag | null = null;

/**
 * Returns the current pause state. Caches for KILL_SWITCH_TTL_MS to
 * absorb the per-sign call burst at peak.
 *
 * On DB error: FAIL CLOSED — if we cannot verify the flag, treat as
 * "paused" so the engine refuses to sign. Catastrophic outage is
 * preferable to silently bypassing the kill switch.
 */
export async function isCopyTradingPaused(): Promise<{
  paused: boolean;
  reason: string | null;
}> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < KILL_SWITCH_TTL_MS) {
    return { paused: cache.value, reason: cache.reason };
  }

  try {
    const rows = await query<{ enabled: boolean; reason: string | null }>(
      `SELECT enabled, reason FROM system_flags WHERE flag_name = $1`,
      [KILL_SWITCH_FLAG],
    );
    const row = rows[0];
    if (!row) {
      // Row missing — treat as paused (fail closed). The seed migration
      // adds the row; absence implies a misdeployed instance.
      cache = { value: true, reason: "system_flags row missing", fetchedAt: now };
      return { paused: true, reason: "system_flags row missing" };
    }
    cache = { value: row.enabled, reason: row.reason ?? null, fetchedAt: now };
    return { paused: row.enabled, reason: row.reason ?? null };
  } catch (err) {
    // DB unreachable → fail closed. Better to stop signing than to
    // sign while the pause flag is undetermined.
    console.warn("[kill-switch] DB read failed, treating as paused:", err);
    return { paused: true, reason: "kill-switch DB read failed" };
  }
}

/**
 * Admin-only: flip the pause flag. Caller must already have
 * authenticated against CRON_SECRET (see app/api/admin/copy/pause).
 */
export async function setCopyTradingPaused(
  paused: boolean,
  reason: string | null,
  updatedBy: string,
): Promise<void> {
  await execute(
    `UPDATE system_flags
     SET enabled = $1, reason = $2, updated_at = NOW(), updated_by = $3
     WHERE flag_name = $4`,
    [paused, reason, updatedBy, KILL_SWITCH_FLAG],
  );
  // Invalidate cache so the next call to isCopyTradingPaused sees the
  // new value immediately rather than waiting for the TTL to elapse.
  cache = null;
}

/** Reset cache — for tests only. */
export function __resetKillSwitchCacheForTests(): void {
  cache = null;
}
