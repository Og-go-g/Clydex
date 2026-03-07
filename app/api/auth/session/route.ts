import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";

/** GET /api/auth/session — return current authenticated address (or null). */
export async function GET() {
  try {
    const session = await getSession();
    return NextResponse.json({
      address: session.address ?? null,
      chainId: session.chainId ?? null,
    });
  } catch {
    return NextResponse.json({ address: null, chainId: null });
  }
}
