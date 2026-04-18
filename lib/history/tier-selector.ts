/**
 * Tier assignment queries for leaderboard refresh scheduling.
 *
 * Tier 1: top 500 PnL + all copy trading leaders — every 30 min
 * Tier 2: accounts interacted with (viewed/searched/followed) in last 7 days — hourly
 * Tier 3: active traders (traded in last 7 days) — every 6 hours
 * Tier 4: everyone else — nightly
 * Spot:   500 random from tier 4 — daily
 */

import { query, execute } from "@/lib/db-history";
import type { TierId } from "@/lib/queue/job-names";

export interface TierAccount extends Record<string, unknown> {
  accountId: number;
  walletAddr: string;
  reason: string;
}

/**
 * Copy trading leader addresses — loaded from main DB copy_subscriptions.
 * Passed as parameter to tier 1 query so worker can join cross-DB.
 */
export async function selectAccountsForTier(
  tier: TierId,
  copyLeaderAddrs: string[] = [],
): Promise<TierAccount[]> {
  if (tier === 1) return selectTier1(copyLeaderAddrs);
  if (tier === 2) return selectTier2();
  if (tier === 3) return selectTier3();
  if (tier === 4) return selectTier4();
  if (tier === "spot") return selectSpotCheck();
  return [];
}

async function selectTier1(copyLeaderAddrs: string[]): Promise<TierAccount[]> {
  return query<TierAccount>(
    `WITH top500 AS (
       SELECT "accountId", "walletAddr", 'top500' AS reason
       FROM pnl_totals
       WHERE "walletAddr" NOT LIKE 'account:%'
       ORDER BY "totalPnl"::numeric DESC
       LIMIT 500
     ),
     leaders AS (
       SELECT DISTINCT pt."accountId", pt."walletAddr", 'copy_leader' AS reason
       FROM pnl_totals pt
       WHERE pt."walletAddr" = ANY($1::text[])
     )
     SELECT "accountId", "walletAddr", reason FROM top500
     UNION
     SELECT "accountId", "walletAddr", reason FROM leaders`,
    [copyLeaderAddrs],
  );
}

async function selectTier2(): Promise<TierAccount[]> {
  return query<TierAccount>(
    `SELECT DISTINCT ai."accountId", ai."walletAddr",
       CASE WHEN ai.kind = 'follow' THEN 'followed'
            WHEN ai.kind = 'view'   THEN 'viewed'
            ELSE 'searched' END AS reason
     FROM account_interactions ai
     WHERE ai."at" >= NOW() - INTERVAL '7 days'
       AND ai."walletAddr" NOT LIKE 'account:%'`,
  );
}

async function selectTier3(): Promise<TierAccount[]> {
  return query<TierAccount>(
    `SELECT DISTINCT th."accountId", th."walletAddr", 'active7d' AS reason
     FROM trade_history th
     WHERE th."time" >= NOW() - INTERVAL '7 days'
       AND th."walletAddr" NOT LIKE 'account:%'`,
  );
}

async function selectTier4(): Promise<TierAccount[]> {
  return query<TierAccount>(
    `SELECT pt."accountId", pt."walletAddr", 'default' AS reason
     FROM pnl_totals pt
     WHERE pt."walletAddr" NOT LIKE 'account:%'
       AND pt."accountId" NOT IN (
         SELECT "accountId" FROM leaderboard_tiers WHERE tier < 4
       )`,
  );
}

async function selectSpotCheck(): Promise<TierAccount[]> {
  return query<TierAccount>(
    `SELECT "accountId", "walletAddr", 'default' AS reason
     FROM leaderboard_tiers
     WHERE tier = 4
     ORDER BY random()
     LIMIT 500`,
  );
}

// ─── Tier membership management ────────────────────────────────

/**
 * Batch upsert tier membership.
 */
export async function upsertTierMembership(
  accounts: TierAccount[],
  tier: number,
): Promise<void> {
  if (accounts.length === 0) return;

  const ids = accounts.map((a) => a.accountId);
  const wallets = accounts.map((a) => a.walletAddr);
  const reasons = accounts.map((a) => a.reason);
  const tiers = accounts.map(() => tier);

  await execute(
    `INSERT INTO leaderboard_tiers ("accountId", "walletAddr", tier, reason, "nextDueAt")
     SELECT u.a, u.w, u.t, u.r, NOW()
     FROM unnest($1::int[], $2::text[], $3::smallint[], $4::text[]) AS u(a, w, t, r)
     ON CONFLICT ("accountId") DO UPDATE SET
       tier = LEAST(leaderboard_tiers.tier, EXCLUDED.tier),
       reason = EXCLUDED.reason,
       "walletAddr" = EXCLUDED."walletAddr"`,
    [ids, wallets, tiers, reasons],
  );
}

/**
 * Mark tier entry as freshly refreshed. Sets lastRefresh = NOW().
 * nextDueAt is calculated based on tier frequency.
 */
export async function markTierRefreshed(accountId: number): Promise<void> {
  await execute(
    `UPDATE leaderboard_tiers
     SET "lastRefresh" = NOW(),
         "nextDueAt" = NOW() + CASE tier
           WHEN 1 THEN INTERVAL '30 minutes'
           WHEN 2 THEN INTERVAL '1 hour'
           WHEN 3 THEN INTERVAL '6 hours'
           WHEN 4 THEN INTERVAL '1 day'
           ELSE INTERVAL '1 hour'
         END
     WHERE "accountId" = $1`,
    [accountId],
  );
}

// ─── Utility: chunk accounts into batches ──────────────────────

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
