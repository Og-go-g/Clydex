import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuthAddress } from "@/lib/auth/session";
import { getOrCreateUser } from "@/lib/db/helpers";

const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const VALID_PROVIDERS = new Set(["OpenOcean", "ParaSwap"]);
const VALID_STATUSES = new Set(["pending", "confirmed", "failed"]);

// Valid state transitions — confirmed and failed are terminal
const VALID_TRANSITIONS: Record<string, Set<string>> = {
  pending: new Set(["confirmed", "failed"]),
  confirmed: new Set([]),
  failed: new Set([]),
};

function str(v: unknown, maxLen: number): string | null {
  if (typeof v !== "string" || !v || v.length > maxLen) return null;
  return v;
}

export async function GET() {
  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ swaps: [] });
  }

  try {
    const user = await getOrCreateUser(address);
    const swaps = await prisma.swap.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return NextResponse.json({ swaps });
  } catch (error) {
    console.error("[api/history/swaps] GET error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const fromToken = str(body.fromToken, 20);
  const toToken = str(body.toToken, 20);
  const fromAmount = str(body.fromAmount, 50);
  const toAmount = str(body.toAmount, 50);
  const provider = str(body.provider, 30);
  const fromAddress = str(body.fromAddress, 42) ?? "";
  const toAddress = str(body.toAddress, 42) ?? "";
  const txHash = typeof body.txHash === "string" && TX_HASH_RE.test(body.txHash) ? body.txHash : null;

  if (!fromToken || !toToken || !fromAmount || !toAmount || !provider) {
    return NextResponse.json({ error: "Missing or invalid swap fields" }, { status: 400 });
  }

  if (!VALID_PROVIDERS.has(provider)) {
    return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
  }

  try {
    const user = await getOrCreateUser(address);
    const swap = await prisma.swap.create({
      data: {
        fromToken, fromAddress, toToken, toAddress,
        fromAmount, toAmount, provider,
        txHash,
        status: txHash ? "pending" : "failed",
        userId: user.id,
      },
    });
    return NextResponse.json({ swap });
  } catch (error) {
    console.error("[api/history/swaps] POST error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let patchBody;
  try {
    patchBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { id, txHash, status } = patchBody;
  if (typeof id !== "string" || !id || id.length > 50) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  if (typeof status !== "string" || !VALID_STATUSES.has(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }
  const safeTxHash = typeof txHash === "string" && TX_HASH_RE.test(txHash) ? txHash : undefined;

  try {
    const user = await getOrCreateUser(address);

    // Enforce valid state transitions (confirmed/failed are terminal)
    const existing = await prisma.swap.findFirst({ where: { id, userId: user.id } });
    if (!existing) {
      return NextResponse.json({ error: "Swap not found" }, { status: 404 });
    }
    const allowed = VALID_TRANSITIONS[existing.status];
    if (allowed && !allowed.has(status)) {
      return NextResponse.json({ error: "Invalid status transition" }, { status: 400 });
    }

    await prisma.swap.updateMany({
      where: { id, userId: user.id },
      data: { status, ...(safeTxHash ? { txHash: safeTxHash } : {}) },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[api/history/swaps] PATCH error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
