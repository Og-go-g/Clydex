import { getAccount, getUser, getMarketStats } from "../n1/client";
import { placeOrder, closePosition } from "../n1/user-client";
import { ensureMarketCache, getCachedMarkets } from "../n1/constants";
import { restoreNordUser } from "./norduser-restore";
import {
  getActiveLeaders,
  getFollowersForLeader,
  getSnapshots,
  upsertSnapshot,
  deleteSnapshots,
  getSession,
  insertCopyTrade,
  updateCopyTradeStatus,
  getConsecutiveFailures,
  toggleSubscription,
} from "./queries";
import type { CopySubscription, CopySnapshot } from "./queries";

// ─── Types ───────────────────────────────────────────────────────

interface PositionDiff {
  marketId: number;
  symbol: string;
  action: "open" | "close" | "increase" | "decrease" | "flip";
  prevSize: number;
  newSize: number;
  side: "Long" | "Short";
  delta: number; // absolute change in base units
}

interface EngineResult {
  leadersProcessed: number;
  diffsDetected: number;
  ordersPlaced: number;
  ordersFailed: number;
  errors: string[];
  durationMs: number;
}

// ─── Constants ───────────────────────────────────────────────────

const MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_SLIPPAGE = 0.005; // 0.5% slippage tolerance for copy trades
const MIN_ORDER_SIZE_USD = 1; // skip orders smaller than $1

// ─── Account ID Cache (leader addr → accountId) ─────────────────

const accountIdCache = new Map<string, { id: number; ts: number }>();
const ACCOUNT_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function resolveAccountId(addr: string): Promise<number | null> {
  const cached = accountIdCache.get(addr);
  if (cached && Date.now() - cached.ts < ACCOUNT_CACHE_TTL) return cached.id;

  try {
    // account:N format → extract N directly
    if (addr.startsWith("account:")) {
      const id = parseInt(addr.slice(8));
      if (!isNaN(id)) {
        accountIdCache.set(addr, { id, ts: Date.now() });
        return id;
      }
    }

    // Solana address → lookup via API
    const user = await getUser(addr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids = (user as any)?.accountIds ?? [];
    if (ids.length === 0) return null;
    const id = ids[0];
    accountIdCache.set(addr, { id, ts: Date.now() });
    return id;
  } catch {
    return null;
  }
}

// ─── Position Diff ───────────────────────────────────────────────

function computePositionDiffs(
  snapshots: CopySnapshot[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  currentPositions: any[],
  marketSymbols: Record<number, string>,
): PositionDiff[] {
  const diffs: PositionDiff[] = [];

  // Build maps
  const snapMap = new Map<number, CopySnapshot>();
  for (const s of snapshots) snapMap.set(s.marketId, s);

  const currMap = new Map<number, { size: number; side: "Long" | "Short" }>();
  for (const p of currentPositions) {
    const baseSize = p.perp?.baseSize ?? 0;
    if (baseSize === 0) continue;
    currMap.set(p.marketId, {
      size: Math.abs(baseSize),
      side: baseSize > 0 ? "Long" : "Short",
    });
  }

  // Check current vs snapshot
  for (const [marketId, curr] of currMap) {
    const snap = snapMap.get(marketId);
    const symbol = marketSymbols[marketId] ?? `M${marketId}`;

    if (!snap) {
      // New position
      diffs.push({
        marketId, symbol, action: "open",
        prevSize: 0, newSize: curr.size, side: curr.side,
        delta: curr.size,
      });
    } else if (snap.side !== curr.side) {
      // Flipped direction
      diffs.push({
        marketId, symbol, action: "flip",
        prevSize: parseFloat(snap.size), newSize: curr.size, side: curr.side,
        delta: curr.size + parseFloat(snap.size), // close old + open new
      });
    } else {
      const prevSize = parseFloat(snap.size);
      const diff = curr.size - prevSize;
      if (Math.abs(diff) < 0.0001) continue; // no meaningful change

      diffs.push({
        marketId, symbol,
        action: diff > 0 ? "increase" : "decrease",
        prevSize, newSize: curr.size, side: curr.side,
        delta: Math.abs(diff),
      });
    }
  }

  // Check closed positions (in snapshot but not current)
  for (const [marketId, snap] of snapMap) {
    if (!currMap.has(marketId)) {
      diffs.push({
        marketId,
        symbol: marketSymbols[marketId] ?? `M${marketId}`,
        action: "close",
        prevSize: parseFloat(snap.size), newSize: 0,
        side: snap.side as "Long" | "Short",
        delta: parseFloat(snap.size),
      });
    }
  }

  return diffs;
}

// ─── Copy Single Diff for One Follower ───────────────────────────

async function executeCopyForFollower(
  diff: PositionDiff,
  follower: CopySubscription,
  leaderEquity: number,
): Promise<{ success: boolean; error?: string }> {
  // Validate session
  const session = await getSession(follower.followerAddr);
  if (!session) {
    return { success: false, error: "No active session" };
  }

  // Circuit breaker
  const failures = await getConsecutiveFailures(follower.id);
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    await toggleSubscription(follower.id, false);
    return { success: false, error: `Paused: ${failures} consecutive failures` };
  }

  // Calculate proportional size
  const allocation = parseFloat(follower.allocationUsdc);
  const leverageMult = parseFloat(follower.leverageMult);
  if (leaderEquity <= 0 || allocation <= 0) {
    return { success: false, error: "Invalid equity or allocation" };
  }

  const ratio = allocation / leaderEquity;
  let followerDelta = diff.delta * ratio * leverageMult;

  // Get mark price for USD value check
  let markPrice = 0;
  try {
    const stats = await getMarketStats(diff.marketId);
    markPrice = stats.perpStats?.mark_price ?? stats.indexPrice ?? 0;
  } catch {
    return { success: false, error: "Failed to get market price" };
  }

  if (markPrice <= 0) {
    return { success: false, error: "Invalid mark price" };
  }

  // Cap at maxPositionUsdc
  const maxPos = follower.maxPositionUsdc ? parseFloat(follower.maxPositionUsdc) : null;
  if (maxPos && maxPos > 0) {
    const maxSize = maxPos / markPrice;
    followerDelta = Math.min(followerDelta, maxSize);
  }

  // Skip tiny orders
  const orderValueUsd = followerDelta * markPrice;
  if (orderValueUsd < MIN_ORDER_SIZE_USD) {
    return { success: false, error: `Order too small: $${orderValueUsd.toFixed(2)}` };
  }

  // Round size to avoid SDK precision errors
  const roundedSize = Math.round(followerDelta * 10) / 10;
  if (roundedSize <= 0) {
    return { success: false, error: "Rounded size is 0" };
  }

  // Restore NordUser
  let nordUser;
  try {
    nordUser = await restoreNordUser(session);
  } catch (err) {
    return { success: false, error: `Session restore failed: ${err instanceof Error ? err.message : "unknown"}` };
  }

  // Log trade intent
  const tradeId = await insertCopyTrade({
    subscriptionId: follower.id,
    followerAddr: follower.followerAddr,
    leaderAddr: follower.leaderAddr,
    marketId: diff.marketId,
    symbol: diff.symbol,
    side: diff.action === "close" ? (diff.side === "Long" ? "Short" : "Long") : diff.side,
    size: roundedSize.toString(),
  });

  try {
    if (diff.action === "close" || diff.action === "decrease") {
      // Close or reduce — opposite side, reduce-only
      await closePosition(nordUser, {
        symbol: diff.symbol,
        side: diff.side, // closePosition handles opposite side internally
        size: roundedSize,
        slippage: DEFAULT_SLIPPAGE,
      });
    } else {
      // Open, increase, or flip — place order
      await placeOrder(nordUser, {
        symbol: diff.symbol,
        side: diff.side,
        size: roundedSize,
        leverage: leverageMult,
        orderType: "market",
        slippage: DEFAULT_SLIPPAGE,
      });
    }

    await updateCopyTradeStatus(tradeId, "filled", {
      price: markPrice.toString(),
    });

    return { success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Order failed";
    await updateCopyTradeStatus(tradeId, "failed", { error: errorMsg });
    return { success: false, error: errorMsg };
  }
}

// ─── Main Engine Cycle ───────────────────────────────────────────

export async function runCopyEngine(): Promise<EngineResult> {
  const start = Date.now();
  const result: EngineResult = {
    leadersProcessed: 0,
    diffsDetected: 0,
    ordersPlaced: 0,
    ordersFailed: 0,
    errors: [],
    durationMs: 0,
  };

  try {
    // Ensure market cache is loaded
    await ensureMarketCache();
    const markets = getCachedMarkets();
    const marketSymbols: Record<number, string> = {};
    for (const m of markets) marketSymbols[m.id] = m.symbol;

    // Get all leaders with active followers
    const leaders = await getActiveLeaders();
    if (leaders.length === 0) {
      result.durationMs = Date.now() - start;
      return result;
    }

    for (const leaderAddr of leaders) {
      try {
        // Resolve account ID
        const accountId = await resolveAccountId(leaderAddr);
        if (accountId === null) {
          result.errors.push(`${leaderAddr}: cannot resolve accountId`);
          continue;
        }

        // Get current positions
        const account = await getAccount(accountId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const positions = (account as any)?.positions ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const margins = (account as any)?.margins ?? {};
        const leaderEquity = margins.omf ?? 0;

        // Load snapshots
        const snapshots = await getSnapshots(leaderAddr);

        // Compute diffs
        const diffs = computePositionDiffs(snapshots, positions, marketSymbols);
        result.leadersProcessed++;

        if (diffs.length === 0) continue;
        result.diffsDetected += diffs.length;

        // Get followers
        const followers = await getFollowersForLeader(leaderAddr);

        // Process each diff for each follower
        for (const diff of diffs) {
          for (const follower of followers) {
            const res = await executeCopyForFollower(diff, follower, leaderEquity);
            if (res.success) {
              result.ordersPlaced++;
            } else {
              result.ordersFailed++;
              if (res.error) {
                result.errors.push(`${follower.followerAddr}→${diff.symbol}: ${res.error}`);
              }
            }
          }
        }

        // Update snapshots with current positions
        // First clear old snapshots for this leader
        await deleteSnapshots(leaderAddr);

        // Write new snapshots
        for (const p of positions) {
          const baseSize = p.perp?.baseSize ?? 0;
          if (baseSize === 0) continue;
          await upsertSnapshot(
            leaderAddr,
            p.marketId,
            Math.abs(baseSize).toString(),
            baseSize > 0 ? "Long" : "Short",
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        result.errors.push(`${leaderAddr}: ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Engine failed";
    result.errors.push(msg);
  }

  result.durationMs = Date.now() - start;
  return result;
}
