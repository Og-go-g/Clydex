import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getSession } from "@/lib/auth/session";

/** GET /api/auth/nonce — generate a fresh nonce and store it in the session. */
export async function GET() {
  try {
    const session = await getSession();
    const nonce = randomBytes(16).toString("hex");
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
