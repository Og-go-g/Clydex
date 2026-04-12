import { getAccount, getUser } from "../n1/client";
import { closePosition } from "../n1/user-client";
import { restoreNordUserByWallet } from "./norduser-restore";
import { ensureMarketCache, getCachedMarkets } from "../n1/constants";
import { getCopiedMarketIds } from "./queries";

const DEFAULT_SLIPPAGE = 0.005;

interface CloseResult {
  closed: number;
  failed: number;
  errors: string[];
}

/**
 * Close ONLY positions that were actually copied from a specific leader.
 * Uses copy_trades history to determine which markets had filled copy trades,
 * then closes the follower's positions in those markets only.
 *
 * This ensures we don't accidentally close positions the user opened manually.
 */
export async function closeFollowerPositions(
  followerAddr: string,
  leaderAddr: string,
): Promise<CloseResult> {
  const result: CloseResult = { closed: 0, failed: 0, errors: [] };

  // Get markets where we actually executed copy trades for this leader
  const copiedMarkets = await getCopiedMarketIds(followerAddr, leaderAddr);
  if (copiedMarkets.length === 0) {
    return result; // No copy trades were ever executed — nothing to close
  }
  const copiedMarketSet = new Set(copiedMarkets);

  // Restore follower's NordUser
  const nordUser = await restoreNordUserByWallet(followerAddr);
  if (!nordUser) {
    return { closed: 0, failed: 0, errors: ["No active copy trading session"] };
  }

  // Get follower's account to find their current positions
  let followerAccountId: number;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = await getUser(followerAddr) as any;
    const ids = user?.accountIds ?? [];
    if (ids.length === 0) {
      return { closed: 0, failed: 0, errors: ["Cannot resolve follower account"] };
    }
    followerAccountId = ids[0];
  } catch {
    return { closed: 0, failed: 0, errors: ["Failed to lookup follower account"] };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const account = await getAccount(followerAccountId) as any;
  const positions = Array.isArray(account?.positions) ? account.positions : [];

  // Load market symbols
  await ensureMarketCache();
  const markets = getCachedMarkets();
  const marketSymbols: Record<number, string> = {};
  for (const m of markets) marketSymbols[m.id] = m.symbol;

  // Close ONLY positions in markets that had actual copy trades from this leader
  for (const p of positions) {
    const marketId = p.marketId as number;
    const baseSize = p.perp?.baseSize ?? 0;
    if (baseSize === 0) continue;
    if (!copiedMarketSet.has(marketId)) continue; // Not from this leader

    const symbol = marketSymbols[marketId];
    if (!symbol) {
      result.errors.push(`Unknown market ${marketId}`);
      result.failed++;
      continue;
    }

    try {
      await closePosition(nordUser, {
        symbol,
        side: (baseSize > 0 ? "Long" : "Short") as "Long" | "Short",
        size: Math.abs(baseSize),
        slippage: DEFAULT_SLIPPAGE,
      });
      result.closed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Close failed";
      result.errors.push(`${symbol}: ${msg}`);
      result.failed++;
    }
  }

  return result;
}
