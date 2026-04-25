/**
 * Job name constants + typed payload map.
 * Single source of truth for all queue types.
 */

export const JOB = {
  refreshTier:         "refresh-leaderboard-tier",
  leaderboardBatch:    "leaderboard-batch",
  syncUserHistory:     "sync-user-history",
  onDemandRefresh:     "on-demand-refresh",
  syncUsersEnqueuer:   "sync-users-enqueuer",
  resolveWallets:      "resolve-wallets",
  resolveWalletsBatch: "resolve-wallets-batch",
  copyEngineTick:      "copy-engine-tick",
} as const;

export type JobName = (typeof JOB)[keyof typeof JOB];

export type TierId = 1 | 2 | 3 | 4 | "spot";

// All tiers in registration order — single source of truth for both
// `lib/queue/schedules.ts` and `lib/queue/handlers/index.ts`.
export const TIER_IDS: readonly TierId[] = [1, 2, 3, 4, "spot"] as const;

/**
 * Per-tier queue name for pg-boss. Each tier needs a distinct queue name
 * because pg-boss v12 keys `pgboss.schedule` rows by name (PK) — so a
 * single queue can have only one schedule. Routing every tier through
 * `JOB.refreshTier` (as the original 2026-04-18 deploy did) silently
 * overwrote 4 of the 5 schedules and only the last call (`spot`) ever
 * fired in production.
 */
export function tierScheduleName(tier: TierId): string {
  return `${JOB.refreshTier}-${tier}`;
}

export interface Payloads {
  [JOB.refreshTier]:         { tier: TierId };
  [JOB.leaderboardBatch]:    { accountIds: number[]; wallets: string[]; tier: number };
  [JOB.syncUserHistory]:     { walletAddr: string; accountId: number };
  [JOB.onDemandRefresh]:     { accountId: number; walletAddr: string; requestedBy?: string };
  [JOB.syncUsersEnqueuer]:   Record<string, never>;
  [JOB.resolveWallets]:      Record<string, never>;
  [JOB.resolveWalletsBatch]: { accountIds: number[] };
  [JOB.copyEngineTick]:      Record<string, never>;
}

// Priority ordering — higher runs first
export function tierPriority(tier: TierId): number {
  if (tier === 1) return 5;
  if (tier === 2) return 4;
  if (tier === 3) return 3;
  if (tier === 4) return 2;
  return 1; // spot
}
