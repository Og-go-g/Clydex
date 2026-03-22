import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getSession } from "@/lib/auth/session";
import { storeNonce } from "@/lib/auth/nonce-store";

/** GET /api/auth/nonce — generate a fresh nonce, store server-side and in session. */
export async function GET() {
  try {
    const nonce = randomBytes(16).toString("hex");
    // Store nonce server-side for atomic consumption (prevents race condition)
    storeNonce(nonce);
    // Also store in session for backwards compatibility
    const session = await getSession();
    session.nonce = nonce;
    await session.save();
    return NextResponse.json({ nonce });
  } catch {
    return NextResponse.json(
      { error: "Failed to generate nonce" },
      { status: 500 }
    );
  }
}
