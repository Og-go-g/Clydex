import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";

/** POST /api/auth/logout — destroy the session cookie. */
export async function POST() {
  try {
    const session = await getSession();
    session.destroy();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to logout" },
      { status: 500 }
    );
  }
}
