import "./polyfill";
import * as Sentry from "@sentry/nextjs";
import { acquireAdvisoryLock } from "../db-history";
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
// Per-process flag prevents overlapping cycles inside one Node process.
// The DB advisory lock (acquired inside runCopyEngine) prevents two
// processes — different containers, an accidental second worker, the
// cron tick racing a manual /api/copy/engine call — from running in
// parallel. Without the DB lock, a deploy with 2 replicas would double-
// trade every leader.

let engineRunning = false;

// Stable, arbitrary 32-bit integer used as the global advisory-lock key
// for the copy engine. Must not collide with the per-leader lock keys
// which are accountIds (1..millions). 0x636F7079 = 'copy' in ASCII.
const GLOBAL_ENGINE_LOCK_KEY = 0x636f7079;

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

  // Claim ownership BEFORE sending the order to the exchange. Without
  // this, two cycles for different leaders on the same follower-market
  // both pass the pre-check (no existing ownership), both placeOrder,
  // both fire on chain — and only one wins the post-place acquire row.
  // The loser's on-chain position is orphaned: it has no ownership row,
  // never gets re-detected as "owned", and will never be closed by us
  // when its leader closes. By claiming first we serialize on the
  // ownership row; the loser bails out before any wallet/exchange call.
  // Only relevant for open/increase/flip — close/decrease leaves
  // ownership as-is (released later on full close).
  const isOpening = diff.action === "open" || diff.action === "increase" || diff.action === "flip";
  if (isOpening) {
    const claimed = await acquireOwnership(
      follower.followerAddr,
      diff.marketId,
      follower.leaderAddr,
      follower.id,
    );
    if (!claimed) {
      await insertCopyTrade({
        subscriptionId: follower.id,
        followerAddr: follower.followerAddr,
        leaderAddr: follower.leaderAddr,
        marketId: diff.marketId,
        symbol: diff.symbol,
        side: diff.side,
        size: "0",
        status: "skipped",
        error: `claim-race: ${diff.symbol} claimed by another leader`,
      });
      return { success: false, skipped: true, error: `Market ${diff.symbol} claimed by another cycle` };
    }
  }
  let exchangeOrderResult: { fills?: { price: number; size: number }[] } | undefined;
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
      // open or increase — capture result to extract fill price for SL
      exchangeOrderResult = await withRetry(
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

    // Prefer the actual fill price for downstream display + SL anchor.
    // Falls back to markPrice when fills are unavailable (e.g. close
    // path doesn't capture result).
    const fillPrice = computeAverageFillPrice(exchangeOrderResult?.fills) ?? markPrice;
    await updateCopyTradeStatus(tradeId, "filled", { price: fillPrice.toString() });

    // Release ownership on full close. For open/increase/flip we already
    // claimed ownership BEFORE the order (see top of try block) — nothing
    // more to do here. Decrease leaves both position and ownership.
    if (diff.action === "close") {
      await releaseOwnership(follower.followerAddr, diff.marketId);
    }

    // Set stop-loss trigger on exchange if configured (only for open/increase/flip-open).
    // Anchored to the actual fill price, not the pre-trade markPrice — the
    // cycle's cached markPrice can be seconds-old, and on volatile pairs
    // even small drift puts the SL on the wrong side of the entry.
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
          Sentry.captureMessage("[copy-engine] SL skipped: no accountId", {
            level: "warning",
            tags: { component: "copy-engine", event: "sl-no-account" },
            extra: { tradeId, followerAddr: follower.followerAddr, symbol: diff.symbol },
          });
        } else {
          const slAnchor = fillPrice;
          const stopPrice = diff.side === "Long"
            ? slAnchor * (1 - stopLossPct / 100)
            : slAnchor * (1 + stopLossPct / 100);

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
        // Stop-loss is best-effort — don't fail the trade if trigger fails,
        // but DO ship a Sentry event so we can see if SL failures are
        // chronic for any follower (they were previously console-only).
        console.warn(`[copy-engine] stop-loss trigger failed for ${follower.followerAddr} ${diff.symbol}:`, err);
        Sentry.captureException(err, {
          level: "warning",
          tags: { component: "copy-engine", event: "sl-set-failed" },
          extra: {
            tradeId, followerAddr: follower.followerAddr, symbol: diff.symbol,
            stopLossPct, fillPrice, markPrice,
          },
        });
      }
    }

    return { success: true };
  } catch (err) {
    // Order itself failed (network, exchange rejection, etc). Release
    // the ownership we optimistically claimed BEFORE the order — the
    // exchange has no record of the trade, so leaving ownership claimed
    // would block all future copies on this market from this follower.
    if (isOpening) {
      try {
        await releaseOwnership(follower.followerAddr, diff.marketId);
      } catch (releaseErr) {
        console.warn("[copy-engine] failed to release ownership after order error:", releaseErr);
      }
    }
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
  // In-process lock — skip if previous cycle still running in THIS process.
  if (engineRunning) {
    return {
      leadersProcessed: 0, diffsDetected: 0, ordersPlaced: 0,
      ordersFailed: 0, skipped: 0, errors: ["Skipped: previous cycle still running"],
      durationMs: 0,
    };
  }

  // Cross-process global lock — refuses if another container, an
  // accidental second worker, or a manual /api/copy/engine call is
  // running the engine right now. Without this, scaling out to 2+
  // app replicas double-trades every leader. acquireAdvisoryLock pins
  // a dedicated client for the whole cycle so the lock is reliably
  // released even across multiple unrelated PG queries during the run.
  let releaseGlobalLock: (() => Promise<void>) | null = null;
  try {
    releaseGlobalLock = await acquireAdvisoryLock(GLOBAL_ENGINE_LOCK_KEY);
  } catch (lockErr) {
    // PG outage — refuse to run rather than risk double-trading. The
    // engine resumes on the next tick when PG is back.
    console.warn("[copy-engine] could not acquire global lock:", lockErr);
    return {
      leadersProcessed: 0, diffsDetected: 0, ordersPlaced: 0,
      ordersFailed: 0, skipped: 0, errors: ["Skipped: global lock unavailable (DB error)"],
      durationMs: 0,
    };
  }
  if (!releaseGlobalLock) {
    return {
      leadersProcessed: 0, diffsDetected: 0, ordersPlaced: 0,
      ordersFailed: 0, skipped: 0, errors: ["Skipped: another instance is running the engine"],
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
        //
        // Goes through acquireAdvisoryLock so lock + unlock run on the
        // same dedicated PG client. The previous version used
        // pool.query() for both, which checks out a different client
        // each call — pg advisory locks are session-scoped, so the
        // unlock could land on a connection that never held the lock
        // and leave the original session holding it until idle-timeout
        // (~10 minutes). Mirrors the global-lock pattern above.
        let releasePerLeaderLock: (() => Promise<void>) | null = null;
        try {
          releasePerLeaderLock = await acquireAdvisoryLock(accountId);
        } catch (lockErr) {
          addError(
            result,
            `${leaderAddr}: skipped (DB error acquiring lock: ${
              lockErr instanceof Error ? lockErr.message : "unknown"
            })`,
          );
          continue;
        }
        if (!releasePerLeaderLock) {
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

              // Snapshot advances on real success only. Earlier the
              // condition included res.skipped, which collapsed two
              // distinct cases into one bad outcome: a collision-skip
              // (another leader currently owns this market) marked the
              // diff "done" — even though when the other leader later
              // releases the market, we'd still skip because our
              // snapshot says we already caught up. Leader's open never
              // got mirrored. Now skips re-fire each cycle (one cheap
              // DB read for the ownership check) until either the
              // collision clears or the leader's own state changes
              // again. Real failures (success=false, !skipped) also
              // leave snapshot untouched so the next cycle retries.
              if (res.success) {
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
          // Same-client release, returns the dedicated PG client to the
          // pool. Swallow release errors — the lock will time out on
          // idle anyway and the next cycle re-tries via the same gate.
          try {
            await releasePerLeaderLock();
          } catch (releaseErr) {
            console.warn(
              `[copy-engine] per-leader unlock failed for ${leaderAddr}:`,
              releaseErr,
            );
          }
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
    // Release the global cross-process lock — also returns the dedicated
    // client back to the pool.
    if (releaseGlobalLock) {
      try {
        await releaseGlobalLock();
      } catch (releaseErr) {
        console.warn("[copy-engine] could not release global lock:", releaseErr);
      }
    }
    result.durationMs = Date.now() - start;
  }

  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────

function addError(result: EngineResult, msg: string): void {
  if (result.errors.length < MAX_ERRORS) result.errors.push(msg);
}

/**
 * Size-weighted average fill price across the exchange's reported fills
 * for a single placeOrder call. Returns null when fills is missing or
 * empty so callers can fall back to markPrice.
 */
function computeAverageFillPrice(
  fills: { price: number; size: number }[] | undefined,
): number | null {
  if (!fills || fills.length === 0) return null;
  let weightSum = 0;
  let valueSum = 0;
  for (const f of fills) {
    const p = Number(f.price);
    const s = Number(f.size);
    if (!isFinite(p) || !isFinite(s) || s <= 0) continue;
    valueSum += p * s;
    weightSum += s;
  }
  if (weightSum === 0) return null;
  return valueSum / weightSum;
}
