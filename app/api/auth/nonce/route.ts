import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { storeNonce } from "@/lib/auth/nonce-store";

/** GET /api/auth/nonce — generate a fresh nonce, store server-side (Redis/mem). */
export async function GET() {
  try {
    const nonce = randomBytes(16).toString("hex");
    // Store nonce server-side for atomic consumption (prevents race condition)
    await storeNonce(nonce);
    return NextResponse.json({ nonce });
  } catch {
    return NextResponse.json(
      { error: "Failed to generate nonce" },
      { status: 500 }
    );
  }
}
