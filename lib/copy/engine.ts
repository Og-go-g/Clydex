import "./polyfill";
import * as Sentry from "@sentry/nextjs";
import { query as dbQuery } from "../db-history";
import { withRetry } from "../util/retry";
import { getAccount, getUser, getMarketStats } from "../n1/client";
import { placeOrder, closePosition, setTrigger } from "../n1/user-client";
import { ensureMarketCache, getCachedMarkets } from "../n1/constants";
import { restoreNordUser } from "./norduser-restore";
import {
  getActiveLeaders,
  getFollowersForLeader,
  getSnapshots,
  upsertSnapshot,
  deleteSnapshot,
  getSession,
  insertCopyTrade,
  updateCopyTradeStatus,
  getConsecutiveFailures,
  toggleSubscription,
  markSubscriptionBootstrapped,
  getOwnership,
  acquireOwnership,
  releaseOwnership,
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

// ─── Mark Price Cache (per engine cycle) ─────────────────────────
//
// Mark price moves at most a few bps within seconds. Within a single
// engine cycle (~few seconds wall-clock), it's effectively constant.
// Cache by marketId to collapse N×M `getMarketStats` calls (one per
// (follower, diff) pair) down to one call per (cycle, market).
//
// Cleared at the top of runCopyEngine, same lifecycle as nordUserCache.

const markPriceCache = new Map<number, number>();

async function getCachedMarkPrice(marketId: number): Promise<number> {
  const cached = markPriceCache.get(marketId);
  if (cached !== undefined) return cached;
  try {
    const stats = await getMarketStats(marketId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const price = (stats as any).perpStats?.mark_price ?? (stats as any).indexPrice ?? 0;
    if (typeof price === "number" && isFinite(price) && price > 0) {
      markPriceCache.set(marketId, price);
      return price;
    }
  } catch {
    // fall through — caller treats 0 as "couldn't fetch"
  }
  return 0;
}

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

// withRetry extracted to lib/util/retry.ts

// ─── Execute Copy for One Follower ───────────────────────────────

async function executeCopyForFollower(
  diff: PositionDiff,
  follower: CopySubscription,
  leaderEquity: number,
  session: CopySession,
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  // ─── Memoized follower account access ───────────────────────────
  //
  // Up to four downstream checks (manual-position, global notional
  // cap, margin pre-check, stop-loss setTrigger) need either the
  // follower's accountId or their full account snapshot. Without
  // memoization that's 3 redundant getAccount HTTP calls per
  // executeCopyForFollower for an open/increase action with both
  // maxTotal and stopLoss configured.
  //
  // `undefined` = not resolved yet. `null` = resolved, but lookup
  // failed (no account) — downstream checks degrade gracefully and
  // proceed without the corresponding safety net.
  let _accId: number | null | undefined = undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _account: any | null | undefined = undefined;

  const getFollowerAccountId = async (): Promise<number | null> => {
    if (_accId === undefined) _accId = await resolveAccountId(follower.followerAddr);
    return _accId;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getFollowerAccount = async (): Promise<any | null> => {
    if (_account !== undefined) return _account;
    const id = await getFollowerAccountId();
    if (id === null) {
      _account = null;
      return null;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _account = (await getAccount(id)) as any;
    } catch {
      _account = null;
    }
    return _account;
  };

  // ─── Ownership gate ("one leader per market") ───────────────────
  //
  // Three return shapes the engine cares about:
  //   { success: true }                    → snapshot advances, no follow-up
  //   { success: false, skipped: true }    → snapshot advances (skip is
  //                                           a deliberate decision, not a
  //                                           transient failure to retry).
  //                                           Has copy_trade row for visibility.
  //   { success: false }                   → snapshot does NOT advance →
  //                                           diff re-detected next cycle
  //                                           (real failure, retry path).

  const existing = await getOwnership(follower.followerAddr, diff.marketId);

  // Close/decrease only valid if WE currently own this market. No
  // ownership = nothing to close (bootstrap residue, prior collision,
  // or the position pre-dates ownership tracking). Foreign ownership =
  // leader closed something we never mirrored (we own this from a
  // different leader). In both cases: silent noop, advance snapshot,
  // do NOT touch the exchange. This protects against accidentally
  // closing the user's manual position with the same symbol.
  if (diff.action === "close" || diff.action === "decrease") {
    if (!existing || existing.owningLeaderAddr !== follower.leaderAddr) {
      return { success: true };
    }
  }

  // Open/increase/flip into a market owned by another leader →
  // skip with copy_trade row for visibility.
  if (existing && existing.owningLeaderAddr !== follower.leaderAddr) {
    await insertCopyTrade({
      subscriptionId: follower.id,
      followerAddr: follower.followerAddr,
      leaderAddr: follower.leaderAddr,
      marketId: diff.marketId,
      symbol: diff.symbol,
      side: diff.side,
      size: "0",
      status: "skipped",
      error: `collision: market ${diff.symbol} owned by leader ${existing.owningLeaderAddr.slice(0, 8)}…`,
    });
    return { success: false, skipped: true, error: `Market ${diff.symbol} owned by another leader` };
  }

  // Open/increase/flip with no ownership: check for a manual
  // position. If user opened the market themselves, don't pile copy
  // on top.
  if (!existing && (diff.action === "open" || diff.action === "increase" || diff.action === "flip")) {
    const followerAccount = await getFollowerAccount();
    if (followerAccount) {
      const positions = (followerAccount.positions ?? []) as Array<{ marketId: number; perp?: { baseSize?: number } }>;
      const existingInMarket = positions.find(
        (p) => p.marketId === diff.marketId && Math.abs(p.perp?.baseSize ?? 0) > 0,
      );
      if (existingInMarket) {
        await insertCopyTrade({
          subscriptionId: follower.id,
          followerAddr: follower.followerAddr,
          leaderAddr: follower.leaderAddr,
          marketId: diff.marketId,
          symbol: diff.symbol,
          side: diff.side,
          size: "0",
          status: "skipped",
          error: `manual: ${diff.symbol} has a non-copy position`,
        });
        return { success: false, skipped: true, error: `Manual position in ${diff.symbol}` };
      }
    }
  }

  // Circuit breaker — check before any work
  const failures = await getConsecutiveFailures(follower.id);
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    await toggleSubscription(follower.id, false);
    Sentry.captureMessage(
      `[copy-engine] Auto-paused subscription after ${failures} consecutive failures`,
      {
        level: "warning",
        tags: { component: "copy-engine", event: "circuit-breaker" },
        extra: {
          subscriptionId: follower.id,
          followerAddr: follower.followerAddr,
          leaderAddr: follower.leaderAddr,
          symbol: diff.symbol,
          action: diff.action,
        },
      },
    );
    return { success: false, error: `Auto-paused: ${failures} consecutive failures` };
  }

  Sentry.addBreadcrumb({
    category: "copy-engine",
    message: `attempt ${diff.action} ${diff.symbol}`,
    level: "info",
    data: {
      followerAddr: follower.followerAddr,
      leaderAddr: follower.leaderAddr,
      marketId: diff.marketId,
      symbol: diff.symbol,
      action: diff.action,
      delta: diff.delta,
      side: diff.side,
    },
  });

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

  // Get mark price (cycle-cached — collapses N×M fetches across
  // followers and diffs to one fetch per (cycle, market))
  const markPrice = await getCachedMarkPrice(diff.marketId);
  if (!isFinite(markPrice) || markPrice <= 0) {
    return { success: false, error: "Invalid mark price" };
  }

  // Cap at maxPositionUsdc (per-market)
  const maxPos = follower.maxPositionUsdc ? parseFloat(follower.maxPositionUsdc) : null;
  if (maxPos && isFinite(maxPos) && maxPos > 0) {
    followerDelta = Math.min(followerDelta, maxPos / markPrice);
  }

  // Cap at maxTotalPositionUsdc (global across all markets)
  const maxTotal = follower.maxTotalPositionUsdc ? parseFloat(follower.maxTotalPositionUsdc) : null;
  if (maxTotal && isFinite(maxTotal) && maxTotal > 0 && diff.action !== "close" && diff.action !== "decrease") {
    const followerAccount = await getFollowerAccount();
    if (followerAccount) {
      const positions = (followerAccount.positions ?? []) as Array<{ perp?: { baseSize?: number; price?: number } }>;
      const existingNotional = positions.reduce((sum, p) => {
        const bs = Math.abs(p.perp?.baseSize ?? 0);
        const pr = p.perp?.price ?? 0;
        return sum + bs * pr;
      }, 0);
      const remainingBudget = maxTotal - existingNotional;
      if (remainingBudget <= 0) {
        return { success: false, error: `Global cap reached: $${existingNotional.toFixed(0)}/$${maxTotal.toFixed(0)}` };
      }
      followerDelta = Math.min(followerDelta, remainingBudget / markPrice);
    }
  }

  // Skip tiny orders
  const orderValueUsd = followerDelta * markPrice;
  if (!isFinite(orderValueUsd) || orderValueUsd < MIN_ORDER_SIZE_USD) {
    return { success: false, error: `Too small: $${orderValueUsd.toFixed(2)}` };
  }

  // Round size (SDK requires min 0.1 granularity)
  const roundedSize = Math.round(followerDelta * 1_000_000) / 1_000_000;
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

  // Margin check via REST API (SDK fetchInfo unreliable server-side).
  //
  // Available margin for opening NEW orders = omf - imf, where:
  //   omf = USD-denominated equity (collateral + open positive PnL - debt)
  //   imf = USD-denominated initial margin already required by existing
  //         orders/positions to remain open
  //
  // Threshold is intentionally permissive (0.5x of needed) — this is a
  // sanity-pre-check, not strict enforcement. The exchange does the
  // authoritative margin enforcement; we just want to avoid obvious
  // "no chance" submits that would burn an HTTP roundtrip and a failed
  // copy_trade row in the DB.
  //
  // Pre-2026-05-10: this check used `margins.omf` directly as available,
  // which is total equity (NOT free buffer). On a follower with $100
  // equity already 100% used by other positions, omf=$100 looked
  // available and let the order through, only to fail at the exchange.
  if (diff.action !== "close" && diff.action !== "decrease") {
    const followerAccount = await getFollowerAccount();
    if (followerAccount) {
      const m = followerAccount.margins ?? {};
      const equity = typeof m.omf === "number" && isFinite(m.omf) ? m.omf : 0;
      const initialMargin = typeof m.imf === "number" && isFinite(m.imf) ? m.imf : 0;
      const availableMargin = Math.max(0, equity - initialMargin);
      const marginNeeded = orderValueUsd / leverageMult;
      if (availableMargin < marginNeeded * 0.5) {
        return { success: false, error: `Insufficient margin: need ~$${marginNeeded.toFixed(0)}, have $${availableMargin.toFixed(0)} (equity $${equity.toFixed(0)} − used $${initialMargin.toFixed(0)})` };
      }
    }
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
          markPrice, // skip closePosition's internal getMarketStats
        }),
        ORDER_RETRY_COUNT,
        ORDER_RETRY_DELAY_MS,
        `close ${diff.symbol}`,
      );
    } else if (diff.action === "flip") {
      // Step 1: close old position
      const oldSide = diff.prevSide ?? (diff.side === "Long" ? "Short" : "Long");
      const oldProportionalSize = Math.round(diff.prevSize * ratio * leverageMult * 1_000_000) / 1_000_000;
      if (oldProportionalSize > 0) {
        try {
          await withRetry(
            () => closePosition(nordUser, {
              symbol: diff.symbol,
              side: oldSide,
              size: oldProportionalSize,
              slippage: DEFAULT_SLIPPAGE,
              markPrice, // skip closePosition's internal getMarketStats
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

    // Update ownership: claim on open/increase/flip, release on full
    // close. For decrease the position is still open from this leader,
    // so ownership stays.
    if (diff.action === "close") {
      await releaseOwnership(follower.followerAddr, diff.marketId);
    } else if (diff.action !== "decrease") {
      const acquired = await acquireOwnership(
        follower.followerAddr,
        diff.marketId,
        follower.leaderAddr,
        follower.id,
      );
      if (!acquired) {
        // Another concurrent cycle claimed this market for a different
        // leader between our pre-check and now. Order already filled
        // on the exchange — log a warning. This race is bounded by the
        // per-leader advisory lock; only happens if two engine workers
        // race on different leaders for the same follower simultaneously.
        Sentry.captureMessage(
          "[copy-engine] ownership lost-race after order filled",
          {
            level: "warning",
            tags: { component: "copy-engine", event: "ownership-race" },
            extra: {
              tradeId,
              followerAddr: follower.followerAddr,
              leaderAddr: follower.leaderAddr,
              marketId: diff.marketId,
            },
          },
        );
      }
    }

    // Set stop-loss trigger on exchange if configured (only for open/increase/flip-open)
    const stopLossPct = follower.stopLossPct ? parseFloat(follower.stopLossPct) : null;
    if (stopLossPct && isFinite(stopLossPct) && stopLossPct > 0 && stopLossPct <= 100 &&
        diff.action !== "close" && diff.action !== "decrease") {
      try {
        const followerAccountId = await getFollowerAccountId();
        if (followerAccountId === null) {
          // Without an accountId, the SDK can't disambiguate which
          // sub-account to attach the trigger to. Skip rather than
          // pass undefined and risk attaching it to the wrong place.
          console.warn(`[copy-engine] stop-loss skipped (no accountId) for ${follower.followerAddr} ${diff.symbol}`);
        } else {
          const stopPrice = diff.side === "Long"
            ? markPrice * (1 - stopLossPct / 100)
            : markPrice * (1 + stopLossPct / 100);

          if (stopPrice > 0 && isFinite(stopPrice)) {
            await setTrigger(nordUser, {
              symbol: diff.symbol,
              side: diff.side as "Long" | "Short",
              kind: "StopLoss",
              triggerPrice: Math.round(stopPrice * 1e6) / 1e6,
              accountId: followerAccountId,
            });
          }
        }
      } catch (err) {
        // Stop-loss is best-effort — don't fail the trade if trigger fails
        console.warn(`[copy-engine] stop-loss trigger failed for ${follower.followerAddr} ${diff.symbol}:`, err);
      }
    }

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
    Sentry.captureException(err, {
      tags: { component: "copy-engine", event: "order-failed" },
      extra: {
        tradeId,
        subscriptionId: follower.id,
        followerAddr: follower.followerAddr,
        leaderAddr: follower.leaderAddr,
        marketId: diff.marketId,
        symbol: diff.symbol,
        action: diff.action,
        side: diff.side,
        size: roundedSize,
        markPrice,
        orderValueUsd,
        leverageMult,
        allocation,
      },
    });
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
    // Clear caches each cycle — NordUser forces fresh refreshSession,
    // markPrice keeps each cycle's prices fresh-ish (within seconds).
    nordUserCache.clear();
    markPriceCache.clear();

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

        // Per-leader advisory lock — prevents two engine cycles from
        // racing on the SAME leader's snapshot/order processing. Uses
        // the leader's accountId (already an int) instead of a 32-bit
        // string-hash to eliminate collision risk.
        const lockKey = accountId;
        const lockResult = await dbQuery<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock($1) AS locked`, [lockKey],
        );
        if (!lockResult[0]?.locked) {
          addError(result, `${leaderAddr}: skipped (locked by another cycle)`);
          continue;
        }

        try {
          result.leadersProcessed++;

          const followers = await getFollowersForLeader(leaderAddr);
          if (followers.length === 0) continue;

          // Pre-load all sessions in one pass — failed restores cascade
          // into per-cycle errors otherwise.
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

          // Per-follower processing: each follower has their own snapshot
          // of where they last successfully copied this leader. Compute
          // diffs against THAT follower's snapshot, not a shared one.
          // This means a failed order leaves that follower's snapshot
          // unchanged → diff re-appears next cycle → automatic retry.
          for (const follower of followers) {
            const session = followerSessions.get(follower.followerAddr);
            if (!session) continue;

            // First-run is tracked via the subscription's bootstrapped_at
            // column, NOT via "snapshots empty". The empty-snapshots
            // proxy was buggy when leader had zero positions at sub-time:
            // first-run loop wrote no rows, snapshots stayed empty, the
            // next cycle treated it as first-run AGAIN, and the very
            // first position the leader subsequently opened was silently
            // baselined instead of copied. The flag is set to NOW() at
            // the END of the first-run branch — see
            // sql/2026-05-15_subscription_bootstrap_flag.sql.
            const isFirstRun = !follower.bootstrappedAt;
            const snapshots = isFirstRun
              ? []
              : await getSnapshots(follower.followerAddr, leaderAddr);

            // First run = no diffs (don't bootstrap to current leader
            // state); just populate the baseline and let the next cycle
            // pick up new trades. Documented behavior — see
            // copytrade_engine_audit_2026_05_10 memory issue #2.
            if (isFirstRun) {
              for (const p of positions) {
                const baseSize = p.perp?.baseSize ?? 0;
                if (baseSize === 0) continue;
                await upsertSnapshot(
                  follower.followerAddr,
                  leaderAddr,
                  p.marketId,
                  Math.abs(baseSize).toString(),
                  baseSize > 0 ? "Long" : "Short",
                );
              }
              // Mark AFTER the baseline upserts. If we crash mid-loop,
              // bootstrapped_at stays NULL → next cycle re-attempts the
              // whole baseline (upsert is idempotent → safe).
              await markSubscriptionBootstrapped(follower.id);
              continue;
            }

            const diffs = computePositionDiffs(snapshots, positions, marketSymbols);
            if (diffs.length === 0) continue;
            result.diffsDetected += diffs.length;

            for (const diff of diffs) {
              const res = await executeCopyForFollower(diff, follower, leaderEquity, session);

              // Snapshot advances on both success AND deliberate skips
              // (collision/manual). Deliberate skips are NOT failures —
              // re-applying the same diff next cycle would loop forever.
              // Real failures (success=false, skipped=undefined) leave
              // snapshot untouched so the diff re-fires for retry.
              if (res.success || res.skipped) {
                if (diff.action === "close") {
                  await deleteSnapshot(follower.followerAddr, leaderAddr, diff.marketId);
                } else {
                  await upsertSnapshot(
                    follower.followerAddr,
                    leaderAddr,
                    diff.marketId,
                    diff.newSize.toString(),
                    diff.side,
                  );
                }
              }

              if (res.success) {
                result.ordersPlaced++;
              } else if (res.skipped) {
                result.skipped++;
              } else {
                result.ordersFailed++;
              }
              if (!res.success && res.error) {
                addError(result, `${follower.followerAddr}→${diff.symbol}: ${res.error}`);
              }
            }
          }
        } finally {
          await dbQuery(`SELECT pg_advisory_unlock($1)`, [lockKey]);
        }
      } catch (err) {
        addError(result, `${leaderAddr}: ${err instanceof Error ? err.message : "Unknown"}`);
      }
    }
  } catch (err) {
    addError(result, `Engine fatal: ${err instanceof Error ? err.message : "Unknown"}`);
    Sentry.captureException(err, {
      level: "fatal",
      tags: { component: "copy-engine", event: "cycle-fatal" },
    });
  } finally {
    engineRunning = false;
    nordUserCache.clear(); // clean up restored sessions
    markPriceCache.clear();
    result.durationMs = Date.now() - start;
  }

  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────

function addError(result: EngineResult, msg: string): void {
  if (result.errors.length < MAX_ERRORS) result.errors.push(msg);
}
