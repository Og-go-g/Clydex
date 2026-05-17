import { getAccount, getUser } from "../n1/client";
import { closePosition } from "../n1/user-client";
import { restoreNordUserByWallet } from "./norduser-restore";
import { ensureMarketCache, getCachedMarkets } from "../n1/constants";
import { getOwnedMarketIdsForLeader, releaseAllOwnership } from "./queries";

const DEFAULT_SLIPPAGE = 0.005;

interface CloseResult {
  closed: number;
  failed: number;
  errors: string[];
}

/**
 * Close ONLY positions currently OWNED by this leader.
 *
 * Reads from copy_position_ownership (authoritative current state), NOT
 * from copy_trades history. The history table includes markets the user
 * already closed manually — re-closing those would either no-op (best
 * case) or accidentally close a freshly-opened MANUAL position the user
 * placed in the same market after the prior copy was closed.
 *
 * Ownership rows are the canonical answer to "which positions does this
 * leader currently own on this follower's account?" The copy engine
 * maintains them via acquireOwnership (before open) and releaseOwnership
 * (after close), so the table is up-to-date.
 */
export async function closeFollowerPositions(
  followerAddr: string,
  leaderAddr: string,
): Promise<CloseResult> {
  const result: CloseResult = { closed: 0, failed: 0, errors: [] };

  // Markets currently owned by this leader on this follower's account
  const ownedMarkets = await getOwnedMarketIdsForLeader(followerAddr, leaderAddr);
  if (ownedMarkets.length === 0) {
    return result; // Nothing owned — nothing to close
  }
  const ownedMarketSet = new Set(ownedMarkets);

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
    if (!ownedMarketSet.has(marketId)) continue; // Not currently owned by this leader

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

  // Release ownership for ALL markets that were tied to this leader.
  // Safe even if some closes failed — those positions are user's
  // problem to clean up; ownership cleanup unblocks the markets so
  // other leaders aren't permanently locked out.
  await releaseAllOwnership(followerAddr, leaderAddr);

  return result;
}
