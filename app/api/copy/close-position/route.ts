import { NextRequest, NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { getOwnership, releaseOwnership } from "@/lib/copy/queries";
import { restoreNordUserByWallet } from "@/lib/copy/norduser-restore";
import { getAccount, getUser } from "@/lib/n1/client";
import { closePosition } from "@/lib/n1/user-client";
import { ensureMarketCache, getCachedMarkets } from "@/lib/n1/constants";

/**
 * POST /api/copy/close-position
 * Body: { marketId: number }
 *
 * Closes a single copy-tracked position for the authenticated user
 * and releases its ownership row. Used by the [Close] button on
 * each row of the Open Copy Positions panel.
 *
 * Safety:
 *   - Rejects if there's no ownership row for (caller, marketId) —
 *     prevents accidentally closing manual positions through this
 *     endpoint.
 *   - Closes via SDK's `isReduceOnly: true` — exchange clamps to
 *     follower's actual position size, no overshoot.
 *
 * Always releases ownership on success even if close partial-failed —
 * keeping a stale ownership row would block other leaders from the
 * market and the user can clean up manually anyway.
 */
export const dynamic = "force-dynamic";

const DEFAULT_SLIPPAGE = 0.005;

export async function POST(req: NextRequest) {
  const followerAddr = await getAuthAddress();
  if (!followerAddr) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: { marketId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const marketId = typeof body.marketId === "number" ? body.marketId : NaN;
  if (!Number.isInteger(marketId) || marketId < 0) {
    return NextResponse.json({ error: "marketId must be a non-negative integer" }, { status: 400 });
  }

  // Verify ownership before touching the exchange.
  const ownership = await getOwnership(followerAddr, marketId);
  if (!ownership) {
    return NextResponse.json(
      { error: "No copy-tracked position in this market" },
      { status: 404 },
    );
  }

  // Resolve symbol from cached markets.
  await ensureMarketCache();
  const markets = getCachedMarkets();
  const market = markets.find((m) => m.id === marketId);
  if (!market) {
    return NextResponse.json({ error: `Unknown market ${marketId}` }, { status: 400 });
  }

  // Restore NordUser session for this follower.
  const nordUser = await restoreNordUserByWallet(followerAddr);
  if (!nordUser) {
    return NextResponse.json(
      { error: "Copy trading session is not active" },
      { status: 400 },
    );
  }

  // Read current live position to know size + side.
  let baseSize = 0;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = await getUser(followerAddr) as any;
    const accountIds: number[] = user?.accountIds ?? [];
    if (accountIds.length === 0) {
      return NextResponse.json({ error: "Follower has no exchange account" }, { status: 400 });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const account = await getAccount(accountIds[0]) as any;
    const positions = Array.isArray(account?.positions) ? account.positions : [];
    const pos = positions.find((p: { marketId: number }) => p.marketId === marketId);
    baseSize = pos?.perp?.baseSize ?? 0;
  } catch (err) {
    console.error("[copy/close-position] account fetch failed:", err);
    return NextResponse.json(
      { error: "Failed to read current position from exchange" },
      { status: 500 },
    );
  }

  if (baseSize === 0) {
    // Nothing to close on the exchange. Release the orphan ownership
    // row so it stops blocking other leaders from this market.
    await releaseOwnership(followerAddr, marketId);
    return NextResponse.json({
      success: true,
      noop: true,
      message: "No live position to close; ownership released",
    });
  }

  try {
    await closePosition(nordUser, {
      symbol: market.symbol,
      side: baseSize > 0 ? "Long" : "Short",
      size: Math.abs(baseSize),
      slippage: DEFAULT_SLIPPAGE,
    });
  } catch (err) {
    console.error("[copy/close-position] closePosition failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Close order failed" },
      { status: 500 },
    );
  }

  // Release ownership AFTER successful close. Engine's per-cycle close
  // diff will see no diff (leader unchanged, follower now empty) — and
  // even if it did, the close-without-ownership case is a noop now.
  await releaseOwnership(followerAddr, marketId);

  return NextResponse.json({ success: true });
}
