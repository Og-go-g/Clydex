import { NextRequest, NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { getMarketsBlockedForFollower } from "@/lib/copy/queries";
import { getUser, getAccount } from "@/lib/n1/client";
import { ensureMarketCache, getCachedMarkets } from "@/lib/n1/constants";

/**
 * GET /api/copy/markets-overlap?leaderAddr=...
 *
 * Powers the FollowTraderDialog overlap warning. Returns the markets
 * the candidate leader currently trades that are ALREADY owned by
 * another leader for this follower under the "one leader per market"
 * rule (see copytrade_engine_audit_2026_05_10).
 *
 * Frontend uses this to show: "These markets won't be mirrored from
 * this leader because they're already copied by [other leader]."
 *
 * NOT a strict gate — engine enforces the rule at trade-time. This is
 * just a heads-up so the user understands what they're getting.
 *
 * Public response, but auth required (we read the caller's ownership
 * rows).
 */
export const dynamic = "force-dynamic";

const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(req: NextRequest) {
  const followerAddr = await getAuthAddress();
  if (!followerAddr) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const leaderAddr = req.nextUrl.searchParams.get("leaderAddr") ?? "";
  const isAccountId = leaderAddr.startsWith("account:") && /^\d+$/.test(leaderAddr.slice(8));
  if (!leaderAddr || (!isAccountId && !SOLANA_ADDR_RE.test(leaderAddr))) {
    return NextResponse.json({ error: "Invalid leaderAddr" }, { status: 400 });
  }

  try {
    // Resolve leader accountId
    let leaderAccountId: number;
    if (isAccountId) {
      leaderAccountId = parseInt(leaderAddr.slice(8), 10);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const user = await getUser(leaderAddr) as any;
      const ids = user?.accountIds ?? [];
      if (ids.length === 0) {
        return NextResponse.json({ error: "Leader has no account on exchange" }, { status: 404 });
      }
      leaderAccountId = ids[0];
    }

    // Pull the leader's currently-open markets
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const leaderAccount = await getAccount(leaderAccountId) as any;
    const leaderPositions = Array.isArray(leaderAccount?.positions) ? leaderAccount.positions : [];
    const leaderMarketIds = new Set<number>();
    for (const p of leaderPositions) {
      const baseSize = p.perp?.baseSize ?? 0;
      if (baseSize === 0) continue;
      leaderMarketIds.add(p.marketId);
    }

    // Pull follower's blocked markets (owned by other leaders)
    const blocked = await getMarketsBlockedForFollower(followerAddr, leaderAddr);

    // Symbol mapping
    await ensureMarketCache();
    const markets = getCachedMarkets();
    const symbolByMarket = new Map<number, string>();
    for (const m of markets) symbolByMarket.set(m.id, m.symbol);

    // Intersection: leader trades these but they're locked
    const overlap = blocked
      .filter((b) => leaderMarketIds.has(b.marketId))
      .map((b) => ({
        marketId: b.marketId,
        symbol: symbolByMarket.get(b.marketId) ?? `M${b.marketId}`,
        owningLeaderAddr: b.owningLeaderAddr,
      }));

    return NextResponse.json({ overlap });
  } catch (err) {
    console.error("[copy/markets-overlap]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "overlap query failed" },
      { status: 500 },
    );
  }
}
