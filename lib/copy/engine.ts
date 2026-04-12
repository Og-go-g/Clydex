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
import type { CopySubscription, CopySnapshot, CopySession } from "./queries";
import type { NordUser } from "@n1xyz/nord-ts";

// ─── Types ───────────────────────────────────────────────────────

interface PositionDiff {
  marketId: number;
  symbol: string;
  action: "open" | "close" | "increase" | "decrease" | "flip";
  prevSize: number;
  newSize: number;
  side: "Long" | "Short";
  prevSide?: "Long" | "Short"; // only for flip
  delta: number;
}

interface EngineResult {
  leadersProcessed: number;
  diffsDetected: number;
  ordersPlaced: number;
  ordersFailed: number;
  skipped: number;
  errors: string[];
  durationMs: number;
}

// ─── Constants ───────────────────────────────────────────────────

const MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_SLIPPAGE = 0.005;
const MIN_ORDER_SIZE_USD = 1;
const MAX_ALLOCATION_USD = 10_000_000;
const MAX_ORDER_SIZE_BASE = 100_000;
const MAX_ERRORS = 100;
const ORDER_RETRY_COUNT = 2;
const ORDER_RETRY_DELAY_MS = 1000;

// ─── Concurrency Lock ───────────────────────────────────────────
// Prevents overlapping engine cycles (curl fires every 15s, engine may take longer)

let engineRunning = false;

// ─── Account ID Cache ───────────────────────────────────────────

const accountIdCache = new Map<string, { id: number; ts: number }>();
const ACCOUNT_CACHE_TTL = 10 * 60 * 1000;

async function resolveAccountId(addr: string): Promise<number | null> {
  const cached = accountIdCache.get(addr);
  if (cached && Date.now() - cached.ts < ACCOUNT_CACHE_TTL) return cached.id;

  try {
    if (addr.startsWith("account:")) {
      const id = parseInt(addr.slice(8), 10);
      if (!isNaN(id) && id >= 0) {
        accountIdCache.set(addr, { id, ts: Date.now() });
        return id;
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = await getUser(addr) as any;
    const ids = user?.accountIds ?? [];
    if (ids.length === 0) return null;
    accountIdCache.set(addr, { id: ids[0], ts: Date.now() });
    return ids[0];
  } catch {
    return null;
  }
}

// ─── NordUser Cache (per engine cycle) ───────────────────────────
// Restore once per follower per cycle, not once per diff

const nordUserCache = new Map<string, NordUser>();

async function getOrRestoreNordUser(session: CopySession): Promise<NordUser> {
  const cached = nordUserCache.get(session.walletAddr);
  if (cached) return cached;

  const user = await restoreNordUser(session);
  nordUserCache.set(session.walletAddr, user);
  return user;
}

// ─── Position Diff ───────────────────────────────────────────────

function computePositionDiffs(
  snapshots: CopySnapshot[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  currentPositions: any[],
  marketSymbols: Record<number, string>,
): PositionDiff[] {
  const diffs: PositionDiff[] = [];

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

  for (const [marketId, curr] of currMap) {
    const snap = snapMap.get(marketId);
    const symbol = marketSymbols[marketId] ?? `M${marketId}`;

    if (!snap) {
      diffs.push({
        marketId, symbol, action: "open",
        prevSize: 0, newSize: curr.size, side: curr.side,
        delta: curr.size,
      });
    } else if (snap.side !== curr.side) {
      diffs.push({
        marketId, symbol, action: "flip",
        prevSize: parseFloat(snap.size), newSize: curr.size,
        side: curr.side, prevSide: snap.side as "Long" | "Short",
        delta: curr.size,
      });
    } else {
      const prevSize = parseFloat(snap.size);
      const diff = curr.size - prevSize;
      if (Math.abs(diff) < 0.0001) continue;

      diffs.push({
        marketId, symbol,
        action: diff > 0 ? "increase" : "decrease",
        prevSize, newSize: curr.size, side: curr.side,
        delta: Math.abs(diff),
      });
    }
  }

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

// ─── Retry Helper ────────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  delayMs: number,
  label: string,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Don't retry on user errors (insufficient balance, invalid params)
      if (msg.includes("insufficient") || msg.includes("Invalid") || msg.includes("too small")) {
        throw err;
      }
      if (attempt < retries) {
        console.warn(`[copy-engine] ${label} attempt ${attempt + 1} failed, retrying in ${delayMs}ms: ${msg}`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

// ─── Execute Copy for One Follower ───────────────────────────────

async function executeCopyForFollower(
  diff: PositionDiff,
  follower: CopySubscription,
  leaderEquity: number,
  session: CopySession,
): Promise<{ success: boolean; error?: string }> {
  // Circuit breaker — check before any work
  const failures = await getConsecutiveFailures(follower.id);
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    await toggleSubscription(follower.id, false);
    return { success: false, error: `Auto-paused: ${failures} consecutive failures` };
  }

  // Validate numeric inputs
  const allocation = parseFloat(follower.allocationUsdc);
  const leverageMult = parseFloat(follower.leverageMult);
  if (!isFinite(allocation) || allocation <= 0 || allocation > MAX_ALLOCATION_USD) {
    return { success: false, error: "Invalid allocation" };
  }
  if (!isFinite(leverageMult) || leverageMult < 1 || leverageMult > 5) {
    return { success: false, error: "Invalid leverage" };
  }
  if (!isFinite(leaderEquity) || leaderEquity <= 0) {
    return { success: false, error: "Leader zero equity" };
  }

  // Calculate proportional size
  const ratio = allocation / leaderEquity;
  let followerDelta = diff.delta * ratio * leverageMult;

  if (!isFinite(followerDelta) || followerDelta <= 0) {
    return { success: false, error: "Invalid size calculation" };
  }
  followerDelta = Math.min(followerDelta, MAX_ORDER_SIZE_BASE);

  // Get mark price
  let markPrice = 0;
  try {
    const stats = await getMarketStats(diff.marketId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    markPrice = (stats as any).perpStats?.mark_price ?? (stats as any).indexPrice ?? 0;
  } catch {
    return { success: false, error: "Failed to get mark price" };
  }
  if (!isFinite(markPrice) || markPrice <= 0) {
    return { success: false, error: "Invalid mark price" };
  }

  // Cap at maxPositionUsdc
  const maxPos = follower.maxPositionUsdc ? parseFloat(follower.maxPositionUsdc) : null;
  if (maxPos && isFinite(maxPos) && maxPos > 0) {
    followerDelta = Math.min(followerDelta, maxPos / markPrice);
  }

  // Skip tiny orders
  const orderValueUsd = followerDelta * markPrice;
  if (!isFinite(orderValueUsd) || orderValueUsd < MIN_ORDER_SIZE_USD) {
    return { success: false, error: `Too small: $${orderValueUsd.toFixed(2)}` };
  }

  // Round size (SDK requires min 0.1 granularity)
  const roundedSize = Math.round(followerDelta * 10) / 10;
  if (roundedSize <= 0) {
    return { success: false, error: "Rounded size is 0" };
  }

  // Restore NordUser (cached per cycle)
  let nordUser: NordUser;
  try {
    nordUser = await getOrRestoreNordUser(session);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    console.error(`[copy-engine] restore failed ${follower.followerAddr}:`, err);
    return { success: false, error: `Session restore: ${msg}` };
  }

  // Check follower has margin before placing
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = (nordUser as any).info ?? {};
    const availableMargin = info.margins?.omf ?? 0;
    const marginNeeded = orderValueUsd / leverageMult;
    if (diff.action !== "close" && diff.action !== "decrease" && availableMargin < marginNeeded * 0.5) {
      return { success: false, error: `Insufficient margin: need ~$${marginNeeded.toFixed(0)}, have $${availableMargin.toFixed(0)}` };
    }
  } catch {
    // If margin check fails, continue — SDK will reject if truly insufficient
  }

  // Log trade intent BEFORE attempting
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
      await withRetry(
        () => closePosition(nordUser, {
          symbol: diff.symbol,
          side: diff.side, // closePosition internally flips to opposite
          size: roundedSize,
          slippage: DEFAULT_SLIPPAGE,
        }),
        ORDER_RETRY_COUNT,
        ORDER_RETRY_DELAY_MS,
        `close ${diff.symbol}`,
      );
    } else if (diff.action === "flip") {
      // Step 1: close old position
      const oldSide = diff.prevSide ?? (diff.side === "Long" ? "Short" : "Long");
      const oldProportionalSize = Math.round(diff.prevSize * ratio * leverageMult * 10) / 10;
      if (oldProportionalSize > 0) {
        try {
          await withRetry(
            () => closePosition(nordUser, {
              symbol: diff.symbol,
              side: oldSide,
              size: oldProportionalSize,
              slippage: DEFAULT_SLIPPAGE,
            }),
            ORDER_RETRY_COUNT,
            ORDER_RETRY_DELAY_MS,
            `flip-close ${diff.symbol}`,
          );
        } catch (err) {
          // Log close failure but still try to open new direction
          console.warn(`[copy-engine] flip close failed for ${diff.symbol}, continuing to open:`, err);
        }
      }

      // Step 2: open new direction
      await withRetry(
        () => placeOrder(nordUser, {
          symbol: diff.symbol,
          side: diff.side,
          size: roundedSize,
          leverage: leverageMult,
          orderType: "market",
          slippage: DEFAULT_SLIPPAGE,
        }),
        ORDER_RETRY_COUNT,
        ORDER_RETRY_DELAY_MS,
        `flip-open ${diff.symbol}`,
      );
    } else {
      // open or increase
      await withRetry(
        () => placeOrder(nordUser, {
          symbol: diff.symbol,
          side: diff.side,
          size: roundedSize,
          leverage: leverageMult,
          orderType: "market",
          slippage: DEFAULT_SLIPPAGE,
        }),
        ORDER_RETRY_COUNT,
        ORDER_RETRY_DELAY_MS,
        `${diff.action} ${diff.symbol}`,
      );
    }

    await updateCopyTradeStatus(tradeId, "filled", { price: markPrice.toString() });
    return { success: true };
  } catch (err) {
    let errorMsg: string;
    if (err instanceof Error) {
      errorMsg = err.message;
      if (err.cause instanceof Error) errorMsg += ` | ${err.cause.message}`;
    } else {
      errorMsg = typeof err === "string" ? err : "Unknown error";
    }
    console.error(`[copy-engine] FAILED ${follower.followerAddr} ${diff.action} ${diff.symbol}:`, err);
    await updateCopyTradeStatus(tradeId, "failed", { error: errorMsg.slice(0, 500) });
    return { success: false, error: errorMsg };
  }
}

// ─── Main Engine Cycle ───────────────────────────────────────────

export async function runCopyEngine(): Promise<EngineResult> {
  // Concurrency lock — skip if previous cycle still running
  if (engineRunning) {
    return {
      leadersProcessed: 0, diffsDetected: 0, ordersPlaced: 0,
      ordersFailed: 0, skipped: 0, errors: ["Skipped: previous cycle still running"],
      durationMs: 0,
    };
  }

  engineRunning = true;
  const start = Date.now();
  const result: EngineResult = {
    leadersProcessed: 0, diffsDetected: 0, ordersPlaced: 0,
    ordersFailed: 0, skipped: 0, errors: [], durationMs: 0,
  };

  try {
    // Clear NordUser cache each cycle (forces fresh refreshSession)
    nordUserCache.clear();

    await ensureMarketCache();
    const markets = getCachedMarkets();
    const marketSymbols: Record<number, string> = {};
    for (const m of markets) marketSymbols[m.id] = m.symbol;

    const leaders = await getActiveLeaders();
    if (leaders.length === 0) {
      result.durationMs = Date.now() - start;
      return result;
    }

    for (const leaderAddr of leaders) {
      try {
        const accountId = await resolveAccountId(leaderAddr);
        if (accountId === null) {
          addError(result, `${leaderAddr}: cannot resolve accountId`);
          continue;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawAccount = await getAccount(accountId) as any;
        if (!rawAccount || typeof rawAccount !== "object") {
          addError(result, `${leaderAddr}: invalid account response`);
          continue;
        }

        const positions = Array.isArray(rawAccount.positions) ? rawAccount.positions : [];
        const margins = rawAccount.margins && typeof rawAccount.margins === "object" ? rawAccount.margins : {};
        const leaderEquity = typeof margins.omf === "number" && isFinite(margins.omf) ? margins.omf : 0;

        if (leaderEquity <= 0) {
          result.leadersProcessed++;
          result.skipped++;
          continue;
        }

        const snapshots = await getSnapshots(leaderAddr);
        const isFirstRun = snapshots.length === 0;

        // Update snapshots BEFORE processing (idempotent — UNIQUE constraint handles conflicts)
        await deleteSnapshots(leaderAddr);
        for (const p of positions) {
          const baseSize = p.perp?.baseSize ?? 0;
          if (baseSize === 0) continue;
          await upsertSnapshot(
            leaderAddr, p.marketId,
            Math.abs(baseSize).toString(),
            baseSize > 0 ? "Long" : "Short",
          );
        }

        if (isFirstRun) {
          result.leadersProcessed++;
          continue;
        }

        const diffs = computePositionDiffs(snapshots, positions, marketSymbols);
        result.leadersProcessed++;

        if (diffs.length === 0) continue;
        result.diffsDetected += diffs.length;

        const followers = await getFollowersForLeader(leaderAddr);

        // Pre-validate follower sessions to avoid repeated restore failures
        const followerSessions = new Map<string, CopySession>();
        for (const f of followers) {
          const session = await getSession(f.followerAddr);
          if (session) {
            followerSessions.set(f.followerAddr, session);
          } else {
            result.skipped++;
            addError(result, `${f.followerAddr}: no active session`);
          }
        }

        for (const diff of diffs) {
          for (const follower of followers) {
            const session = followerSessions.get(follower.followerAddr);
            if (!session) continue; // already logged above

            const res = await executeCopyForFollower(diff, follower, leaderEquity, session);
            if (res.success) {
              result.ordersPlaced++;
            } else {
              result.ordersFailed++;
              if (res.error) addError(result, `${follower.followerAddr}→${diff.symbol}: ${res.error}`);
            }
          }
        }
      } catch (err) {
        addError(result, `${leaderAddr}: ${err instanceof Error ? err.message : "Unknown"}`);
      }
    }
  } catch (err) {
    addError(result, `Engine fatal: ${err instanceof Error ? err.message : "Unknown"}`);
  } finally {
    engineRunning = false;
    nordUserCache.clear(); // clean up restored sessions
    result.durationMs = Date.now() - start;
  }

  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────

function addError(result: EngineResult, msg: string): void {
  if (result.errors.length < MAX_ERRORS) result.errors.push(msg);
}
