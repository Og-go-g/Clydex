/**
 * Job name constants + typed payload map.
 * Single source of truth for all queue types.
 */

export const JOB = {
  refreshTier:       "refresh-leaderboard-tier",
  leaderboardBatch:  "leaderboard-batch",
  syncUserHistory:   "sync-user-history",
  onDemandRefresh:   "on-demand-refresh",
  syncUsersEnqueuer: "sync-users-enqueuer",
} as const;

export type JobName = (typeof JOB)[keyof typeof JOB];

export type TierId = 1 | 2 | 3 | 4 | "spot";

export interface Payloads {
  [JOB.refreshTier]:       { tier: TierId };
  [JOB.leaderboardBatch]:  { accountIds: number[]; wallets: string[]; tier: number };
  [JOB.syncUserHistory]:   { walletAddr: string; accountId: number };
  [JOB.onDemandRefresh]:   { accountId: number; walletAddr: string; requestedBy?: string };
  [JOB.syncUsersEnqueuer]: Record<string, never>;
}

// Priority ordering — higher runs first
export function tierPriority(tier: TierId): number {
  if (tier === 1) return 5;
  if (tier === 2) return 4;
  if (tier === 3) return 3;
  if (tier === 4) return 2;
  return 1; // spot
}
