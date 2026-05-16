import { getOwnershipForFollower } from "@/lib/copy/queries";
import { getAccount, getUser } from "@/lib/n1/client";
import { ensureMarketCache, getCachedMarkets } from "@/lib/n1/constants";

/**
 * One row of the Open Copy Positions view — the join of
 * `copy_position_ownership` × the follower's live exchange positions.
 *
 * Orphan ownership rows (subscription dropped but exchange position
 * still open) are kept so the panel can still close them.
 */
export interface OpenCopyPosition {
  marketId: number;
  symbol: string;
  side: "Long" | "Short";
  size: number;
  entryPrice: number;
  tradingPnl: number;
  fundingPnl: number;
  owningLeaderAddr: string;
  openedAt: string;
}

/**
 * Build the Open Copy Positions list for one follower. Shared
 * between the REST endpoint and the AI assistant's `getOpenCopyPositions`
 * tool so both stay in lockstep.
 */
export async function getOpenCopyPositions(followerAddr: string): Promise<OpenCopyPosition[]> {
  const ownership = await getOwnershipForFollower(followerAddr);
  if (ownership.length === 0) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user = (await getUser(followerAddr)) as any;
  const accountIds: number[] = user?.accountIds ?? [];
  if (accountIds.length === 0) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const account = (await getAccount(accountIds[0])) as any;
  const livePositions = Array.isArray(account?.positions) ? account.positions : [];

  const liveByMarket = new Map<
    number,
    { baseSize: number; entryPrice: number; tradingPnl: number; fundingPnl: number }
  >();
  for (const p of livePositions) {
    const baseSize = p.perp?.baseSize ?? 0;
    if (baseSize === 0) continue;
    liveByMarket.set(p.marketId, {
      baseSize,
      entryPrice: p.perp?.price ?? 0,
      tradingPnl: p.perp?.tradingPnl ?? 0,
      fundingPnl: p.perp?.fundingPaymentPnl ?? 0,
    });
  }

  await ensureMarketCache();
  const symbolByMarket = new Map<number, string>();
  for (const m of getCachedMarkets()) symbolByMarket.set(m.id, m.symbol);

  const out: OpenCopyPosition[] = [];
  for (const own of ownership) {
    const live = liveByMarket.get(own.marketId);
    if (!live) continue;
    out.push({
      marketId: own.marketId,
      symbol: symbolByMarket.get(own.marketId) ?? `M${own.marketId}`,
      side: live.baseSize > 0 ? "Long" : "Short",
      size: Math.abs(live.baseSize),
      entryPrice: live.entryPrice,
      tradingPnl: live.tradingPnl,
      fundingPnl: live.fundingPnl,
      owningLeaderAddr: own.owningLeaderAddr,
      openedAt: own.openedAt instanceof Date ? own.openedAt.toISOString() : String(own.openedAt),
    });
  }
  return out;
}
