import { NextRequest, NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import {
  createSubscription,
  getSubscriptions,
  toggleSubscription,
  deleteSubscription,
} from "@/lib/copy/queries";
import { closeFollowerPositions } from "@/lib/copy/close-positions";

/**
 * POST /api/copy/subscribe
 * Follow a trader with risk parameters.
 * Body: { leaderAddr, allocationUsdc, leverageMult?, maxPositionUsdc?, stopLossPct? }
 */
export async function POST(req: NextRequest) {
  const addr = await getAuthAddress();
  if (!addr) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { leaderAddr, allocationUsdc, leverageMult, maxPositionUsdc, stopLossPct } = body;

    const isAccountId = typeof leaderAddr === "string" && leaderAddr.startsWith("account:");
    const isSolanaAddr = typeof leaderAddr === "string" && leaderAddr.length >= 32 && leaderAddr.length <= 44;
    if (!leaderAddr || (!isAccountId && !isSolanaAddr)) {
      return NextResponse.json({ error: "leaderAddr must be a valid address" }, { status: 400 });
    }
    if (!allocationUsdc || typeof allocationUsdc !== "number" || allocationUsdc < 10 || allocationUsdc > 10_000_000) {
      return NextResponse.json({ error: "allocationUsdc must be between $10 and $10,000,000" }, { status: 400 });
    }
    if (leverageMult !== undefined && (typeof leverageMult !== "number" || leverageMult < 1 || leverageMult > 5)) {
      return NextResponse.json({ error: "leverageMult must be between 1 and 5" }, { status: 400 });
    }
    if (leaderAddr === addr) {
      return NextResponse.json({ error: "Cannot follow yourself" }, { status: 400 });
    }

    const id = await createSubscription({
      followerAddr: addr,
      leaderAddr,
      allocationUsdc,
      leverageMult: leverageMult ?? 1.0,
      maxPositionUsdc: maxPositionUsdc ?? undefined,
      stopLossPct: stopLossPct ?? undefined,
    });

    return NextResponse.json({ success: true, id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Subscription failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * GET /api/copy/subscribe
 * List current user's subscriptions.
 */
export async function GET() {
  const addr = await getAuthAddress();
  if (!addr) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const subscriptions = await getSubscriptions(addr);
  return NextResponse.json({ data: subscriptions });
}

/**
 * PATCH /api/copy/subscribe
 * Toggle a subscription active/paused.
 * Body: { id, active }
 */
export async function PATCH(req: NextRequest) {
  const addr = await getAuthAddress();
  if (!addr) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { id, active } = body;

    if (!id || typeof active !== "boolean") {
      return NextResponse.json({ error: "id and active (boolean) are required" }, { status: 400 });
    }

    // Verify ownership: fetch subscription and check followerAddr
    const subs = await getSubscriptions(addr);
    const sub = subs.find((s) => s.id === id);
    if (!sub) {
      return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
    }

    await toggleSubscription(id, active);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Toggle failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * DELETE /api/copy/subscribe?leader=<address>
 * Unfollow a trader.
 */
export async function DELETE(req: NextRequest) {
  const addr = await getAuthAddress();
  if (!addr) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const leaderAddr = req.nextUrl.searchParams.get("leader");
  if (!leaderAddr) {
    return NextResponse.json({ error: "leader query param is required" }, { status: 400 });
  }

  const closePos = req.nextUrl.searchParams.get("closePositions") === "true";

  // Close copied positions first if requested
  let closeResult = null;
  if (closePos) {
    try {
      closeResult = await closeFollowerPositions(addr, leaderAddr);
    } catch (err) {
      // Don't block unfollow if close fails — log and continue
      console.error("[copy/subscribe] closePositions error:", err);
      closeResult = { closed: 0, failed: 0, errors: ["Failed to close positions"] };
    }
  }

  const deleted = await deleteSubscription(addr, leaderAddr);
  if (deleted === 0) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true, closeResult });
}
