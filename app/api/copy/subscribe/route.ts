import { NextRequest, NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import {
  createSubscription,
  getSubscriptions,
  toggleSubscription,
  updateSubscriptionSettings,
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
    const { leaderAddr, allocationUsdc, leverageMult, maxPositionUsdc, maxTotalPositionUsdc, stopLossPct } = body;

    const isAccountId = typeof leaderAddr === "string" && /^account:\d+$/.test(leaderAddr);
    const isSolanaAddr = typeof leaderAddr === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(leaderAddr);
    if (!leaderAddr || (!isAccountId && !isSolanaAddr)) {
      return NextResponse.json({ error: "leaderAddr must be a valid address" }, { status: 400 });
    }
    if (!allocationUsdc || typeof allocationUsdc !== "number" || !isFinite(allocationUsdc) || allocationUsdc < 10 || allocationUsdc > 10_000_000) {
      return NextResponse.json({ error: "allocationUsdc must be between $10 and $10,000,000" }, { status: 400 });
    }
    if (leverageMult !== undefined && (typeof leverageMult !== "number" || !isFinite(leverageMult) || leverageMult < 1 || leverageMult > 5)) {
      return NextResponse.json({ error: "leverageMult must be between 1 and 5" }, { status: 400 });
    }
    if (maxPositionUsdc !== undefined && (typeof maxPositionUsdc !== "number" || !isFinite(maxPositionUsdc) || maxPositionUsdc <= 0)) {
      return NextResponse.json({ error: "maxPositionUsdc must be a positive number" }, { status: 400 });
    }
    if (maxTotalPositionUsdc !== undefined && (typeof maxTotalPositionUsdc !== "number" || !isFinite(maxTotalPositionUsdc) || maxTotalPositionUsdc <= 0)) {
      return NextResponse.json({ error: "maxTotalPositionUsdc must be a positive number" }, { status: 400 });
    }
    if (stopLossPct !== undefined && (typeof stopLossPct !== "number" || !isFinite(stopLossPct) || stopLossPct <= 0 || stopLossPct > 100)) {
      return NextResponse.json({ error: "stopLossPct must be between 1 and 100" }, { status: 400 });
    }
    if (leaderAddr === addr) {
      return NextResponse.json({ error: "Cannot follow yourself" }, { status: 400 });
    }

    // Check for existing subscription
    const existing = (await getSubscriptions(addr)).find((s) => s.leaderAddr === leaderAddr);
    if (existing) {
      return NextResponse.json({ error: "You already follow this trader. Modify settings from the Copy Trading panel." }, { status: 409 });
    }

    const id = await createSubscription({
      followerAddr: addr,
      leaderAddr,
      allocationUsdc,
      leverageMult: leverageMult ?? 1.0,
      maxPositionUsdc: maxPositionUsdc ?? undefined,
      maxTotalPositionUsdc: maxTotalPositionUsdc ?? undefined,
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
 * Update subscription settings.
 * Body: { id, active?, allocationUsdc?, leverageMult?, maxPositionUsdc?, maxTotalPositionUsdc?, stopLossPct? }
 */
export async function PATCH(req: NextRequest) {
  const addr = await getAuthAddress();
  if (!addr) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { id, active, allocationUsdc, leverageMult, maxPositionUsdc, maxTotalPositionUsdc, stopLossPct } = body;

    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    // Verify ownership
    const subs = await getSubscriptions(addr);
    const sub = subs.find((s) => s.id === id);
    if (!sub) {
      return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
    }

    // Validate fields if provided
    if (allocationUsdc !== undefined) {
      if (typeof allocationUsdc !== "number" || allocationUsdc < 10 || allocationUsdc > 10_000_000) {
        return NextResponse.json({ error: "allocationUsdc must be between $10 and $10,000,000" }, { status: 400 });
      }
    }
    if (leverageMult !== undefined) {
      if (typeof leverageMult !== "number" || leverageMult < 1 || leverageMult > 5) {
        return NextResponse.json({ error: "leverageMult must be between 1 and 5" }, { status: 400 });
      }
    }
    if (active !== undefined && typeof active !== "boolean") {
      return NextResponse.json({ error: "active must be boolean" }, { status: 400 });
    }

    // Build settings update — only toggle if that's the only field
    const hasSettings = allocationUsdc !== undefined || leverageMult !== undefined ||
      maxPositionUsdc !== undefined || maxTotalPositionUsdc !== undefined || stopLossPct !== undefined;

    if (hasSettings || active !== undefined) {
      await updateSubscriptionSettings(id, {
        ...(allocationUsdc !== undefined && { allocationUsdc }),
        ...(leverageMult !== undefined && { leverageMult }),
        ...(maxPositionUsdc !== undefined && { maxPositionUsdc: maxPositionUsdc || null }),
        ...(maxTotalPositionUsdc !== undefined && { maxTotalPositionUsdc: maxTotalPositionUsdc || null }),
        ...(stopLossPct !== undefined && { stopLossPct: stopLossPct || null }),
        ...(active !== undefined && { active }),
      });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Update failed";
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
