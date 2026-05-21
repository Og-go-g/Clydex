/**
 * Anomaly detection over the sign_log audit trail.
 *
 * Runs on a 1-minute pg-boss schedule (`anomaly-scan` handler) and
 * scans the last 5 minutes of sign_log for suspicious patterns. Each
 * detection writes a row to `anomaly_alerts` (deduped on
 * (kind, scope_key, window_minute) so a sustained burst alarms once
 * per minute, not on every scan) AND fires a Sentry event.
 *
 * Posture: alarms are INFORMATIONAL. We deliberately don't auto-pause
 * the copy engine on a fired anomaly — false positives would shut
 * down legitimate traders. The runbook
 * (docs/runbooks/key-compromise.md) tells the on-call to inspect the
 * alarm and manually flip the kill switch if warranted.
 *
 * Rules implemented:
 *
 *  1. BURST — same follower wallet emits ≥ BURST_THRESHOLD sign
 *     attempts within BURST_WINDOW_S. Approved OR refused, both
 *     count — refused-only counts under refused-spike below.
 *  2. REFUSED-SPIKE — global rate of `policy_result LIKE 'refused:%'`
 *     ≥ REFUSED_THRESHOLD over REFUSED_WINDOW_S. Typical fingerprint
 *     of an attacker who has the key but is hammering policy.
 *  3. MARK-DEVIATION — a single sign event whose markPrice is more
 *     than DEVIATION_PCT off the per-market trailing average over the
 *     last N rows in the same market.
 *  4. LEVERAGE-SPIKE — a single sign whose leverage is > LEVERAGE_MULT
 *     × the follower's median leverage over their last
 *     LEVERAGE_LOOKBACK rows. Catches a hijacked session jumping
 *     from typical 2-5× to 50×.
 *
 * Rules NOT implemented (require more context than sign_log alone):
 *   - Self-trade fingerprint (needs counterparty wallet data)
 *   - Off-hours-by-leader-profile (needs per-leader activity histogram)
 *   - Adverse-fill vs Pyth oracle (needs cross-source price check)
 * Listed in docs/runbooks/key-compromise.md as Week-4 follow-up.
 */

import { query, execute } from "../db-history";

export const BURST_THRESHOLD = 10;
export const BURST_WINDOW_S = 60;

export const REFUSED_THRESHOLD = 5;
export const REFUSED_WINDOW_S = 300;

export const DEVIATION_PCT = 0.05; // 5% from per-market trailing average
export const DEVIATION_LOOKBACK = 20;

export const LEVERAGE_MULT = 2; // anomaly if > 2× the follower's median
export const LEVERAGE_LOOKBACK = 20;
export const LEVERAGE_MIN_HISTORY = 5; // need at least 5 prior signs to compare

export type AnomalyKind =
  | "burst"
  | "refused-spike"
  | "mark-deviation"
  | "leverage-spike";

export interface AnomalyAlert {
  kind: AnomalyKind;
  scopeKey: string;
  windowMinute: Date;
  severity: "warning" | "critical";
  message: string;
  details: Record<string, unknown>;
}

/**
 * Returns the start of the current minute (rounded down). Used as the
 * dedup window for anomaly_alerts so a sustained pattern only
 * triggers once per minute.
 */
function thisMinute(): Date {
  const d = new Date();
  d.setSeconds(0, 0);
  return d;
}

/**
 * Scan for burst pattern: same follower wallet emitting ≥ N sign
 * attempts within the last BURST_WINDOW_S. Includes both approved
 * and refused signs because either pattern is anomalous (an attacker
 * blasting signs that all get refused by policy is just as worth an
 * alarm as one that's getting through).
 */
async function detectBurst(): Promise<AnomalyAlert[]> {
  const rows = await query<{ follower_wallet: string; sign_count: string }>(
    `SELECT follower_wallet, COUNT(*)::text AS sign_count
     FROM sign_log
     WHERE signed_at > NOW() - ($1 || ' seconds')::interval
     GROUP BY follower_wallet
     HAVING COUNT(*) >= $2`,
    [String(BURST_WINDOW_S), BURST_THRESHOLD],
  );
  const win = thisMinute();
  return rows.map((r) => ({
    kind: "burst" as const,
    scopeKey: r.follower_wallet,
    windowMinute: win,
    severity: "warning" as const,
    message: `Sign burst: ${r.sign_count} signs from one follower in ${BURST_WINDOW_S}s`,
    details: {
      followerWallet: r.follower_wallet,
      windowSeconds: BURST_WINDOW_S,
      threshold: BURST_THRESHOLD,
      observed: Number(r.sign_count),
    },
  }));
}

/**
 * Scan for refused-spike: ≥ N refused signs system-wide in the last
 * REFUSED_WINDOW_S. Suggests a hijacked-key actor probing the policy
 * surface looking for a hole.
 */
async function detectRefusedSpike(): Promise<AnomalyAlert[]> {
  const rows = await query<{ refused_count: string }>(
    `SELECT COUNT(*)::text AS refused_count
     FROM sign_log
     WHERE signed_at > NOW() - ($1 || ' seconds')::interval
       AND policy_result LIKE 'refused:%'`,
    [String(REFUSED_WINDOW_S)],
  );
  const count = Number(rows[0]?.refused_count ?? 0);
  if (count < REFUSED_THRESHOLD) return [];
  const win = thisMinute();
  return [
    {
      kind: "refused-spike" as const,
      scopeKey: "global",
      windowMinute: win,
      severity: "critical" as const,
      message: `Policy refused ${count} signs in ${REFUSED_WINDOW_S}s — possible probe`,
      details: {
        windowSeconds: REFUSED_WINDOW_S,
        threshold: REFUSED_THRESHOLD,
        observed: count,
      },
    },
  ];
}

/**
 * Scan for mark-price deviation: any sign in the last minute whose
 * markPrice is > DEVIATION_PCT off the trailing-average markPrice for
 * the same market in the previous DEVIATION_LOOKBACK rows.
 *
 * Catches an attacker who manages to feed an adversarial price into
 * the engine before the sign — the policy gate's 5% clamp from B2
 * mostly prevents this at sign time, but a coordinated mark + sign
 * within the same cycle could slip through. Post-hoc detection
 * complements the real-time guard.
 */
async function detectMarkDeviation(): Promise<AnomalyAlert[]> {
  const rows = await query<{
    id: number;
    follower_wallet: string;
    market_id: number;
    symbol: string;
    mark_price: string;
    trailing_avg: string;
    deviation: string;
  }>(
    `WITH recent AS (
       SELECT id, follower_wallet, market_id, symbol,
              mark_price::numeric AS mark_price,
              AVG(mark_price::numeric) OVER (
                PARTITION BY market_id
                ORDER BY id
                ROWS BETWEEN $1 PRECEDING AND 1 PRECEDING
              ) AS trailing_avg
       FROM sign_log
       WHERE signed_at > NOW() - INTERVAL '15 minutes'
     )
     SELECT id, follower_wallet, market_id, symbol,
            mark_price::text AS mark_price,
            trailing_avg::text AS trailing_avg,
            ABS(mark_price - trailing_avg) / NULLIF(trailing_avg, 0) AS deviation
     FROM recent
     WHERE trailing_avg IS NOT NULL
       AND trailing_avg > 0
       AND ABS(mark_price - trailing_avg) / trailing_avg > $2
       AND id IN (
         SELECT id FROM sign_log
         WHERE signed_at > NOW() - INTERVAL '60 seconds'
       )`,
    [DEVIATION_LOOKBACK, DEVIATION_PCT],
  );
  const win = thisMinute();
  return rows.map((r) => ({
    kind: "mark-deviation" as const,
    scopeKey: `${r.symbol}:${r.id}`,
    windowMinute: win,
    severity: "critical" as const,
    message: `Mark deviation on ${r.symbol}: signed at ${Number(r.mark_price).toFixed(4)} vs trailing avg ${Number(r.trailing_avg).toFixed(4)} (${(Number(r.deviation) * 100).toFixed(2)}%)`,
    details: {
      signLogId: r.id,
      followerWallet: r.follower_wallet,
      marketId: r.market_id,
      symbol: r.symbol,
      markPrice: Number(r.mark_price),
      trailingAvg: Number(r.trailing_avg),
      deviationPct: Number(r.deviation),
      threshold: DEVIATION_PCT,
    },
  }));
}

/**
 * Scan for leverage-spike: any sign in the last minute whose leverage
 * is > LEVERAGE_MULT × the follower's median leverage over their last
 * LEVERAGE_LOOKBACK signs.
 *
 * Catches a session that suddenly jumps from typical 2-5× to 50×,
 * which is the fingerprint of an attacker maximising loss-per-sign
 * before the kill switch fires.
 */
async function detectLeverageSpike(): Promise<AnomalyAlert[]> {
  const rows = await query<{
    id: number;
    follower_wallet: string;
    symbol: string;
    market_id: number;
    leverage: string;
    median_leverage: string;
  }>(
    `WITH new_signs AS (
       SELECT id, follower_wallet, market_id, symbol,
              leverage::numeric AS leverage
       FROM sign_log
       WHERE signed_at > NOW() - INTERVAL '60 seconds'
     ),
     history AS (
       SELECT follower_wallet,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY leverage::numeric) AS median_leverage,
              COUNT(*) AS history_count
       FROM (
         SELECT s.follower_wallet, s.leverage,
                ROW_NUMBER() OVER (PARTITION BY s.follower_wallet ORDER BY s.id DESC) AS rn
         FROM sign_log s
         WHERE s.follower_wallet IN (SELECT follower_wallet FROM new_signs)
       ) ranked
       WHERE rn BETWEEN 2 AND ($1::int + 1)
       GROUP BY follower_wallet
       HAVING COUNT(*) >= $2
     )
     SELECT n.id, n.follower_wallet, n.market_id, n.symbol,
            n.leverage::text AS leverage,
            h.median_leverage::text AS median_leverage
     FROM new_signs n
     JOIN history h ON h.follower_wallet = n.follower_wallet
     WHERE n.leverage > h.median_leverage * $3`,
    [LEVERAGE_LOOKBACK, LEVERAGE_MIN_HISTORY, LEVERAGE_MULT],
  );
  const win = thisMinute();
  return rows.map((r) => ({
    kind: "leverage-spike" as const,
    scopeKey: `${r.follower_wallet}:${r.id}`,
    windowMinute: win,
    severity: "critical" as const,
    message: `Leverage spike: ${Number(r.leverage).toFixed(1)}× on ${r.symbol} vs follower's median ${Number(r.median_leverage).toFixed(1)}×`,
    details: {
      signLogId: r.id,
      followerWallet: r.follower_wallet,
      marketId: r.market_id,
      symbol: r.symbol,
      observedLeverage: Number(r.leverage),
      medianLeverage: Number(r.median_leverage),
      multiplier: LEVERAGE_MULT,
      lookback: LEVERAGE_LOOKBACK,
    },
  }));
}

/**
 * Run every rule, return the union of detected alerts. Each rule
 * scopes to "last minute or so" so a single scan-cycle catches every
 * pattern. The dedup unique index on anomaly_alerts handles repeated
 * scans within the same windowMinute.
 */
export async function scanForAnomalies(): Promise<AnomalyAlert[]> {
  const [burst, refused, deviation, leverage] = await Promise.all([
    detectBurst(),
    detectRefusedSpike(),
    detectMarkDeviation(),
    detectLeverageSpike(),
  ]);
  return [...burst, ...refused, ...deviation, ...leverage];
}

/**
 * Insert an alert into anomaly_alerts. Returns true if the row was
 * inserted (new alarm), false if it was a duplicate (existing alarm
 * for this kind+scope+windowMinute). The caller fires Sentry only on
 * fresh insertions.
 */
export async function persistAlert(alert: AnomalyAlert): Promise<boolean> {
  const rows = await query<{ id: number }>(
    `INSERT INTO anomaly_alerts
       (kind, scope_key, window_minute, severity, message, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (kind, scope_key, window_minute) DO NOTHING
     RETURNING id`,
    [
      alert.kind,
      alert.scopeKey,
      alert.windowMinute,
      alert.severity,
      alert.message,
      JSON.stringify(alert.details),
    ],
  );
  return rows.length > 0;
}

/** Exposed for tests — never call in production. */
export async function __resetAnomalyTableForTests(): Promise<void> {
  await execute(`TRUNCATE anomaly_alerts RESTART IDENTITY`);
}
