import { NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { getOpenCopyPositions } from "@/lib/copy/open-positions";

export const dynamic = "force-dynamic";

export async function GET() {
  const followerAddr = await getAuthAddress();
  if (!followerAddr) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  try {
    const positions = await getOpenCopyPositions(followerAddr);
    return NextResponse.json({ positions });
  } catch (err) {
    console.error("[copy/open-positions]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load open positions" },
      { status: 500 },
    );
  }
}
