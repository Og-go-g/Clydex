import { NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";

/** GET /api/auth/session — return current authenticated address (or null). */
export async function GET() {
  try {
    // Use getAuthAddress() to enforce max-lifetime check + refresh cookie TTL
    const address = await getAuthAddress();
    return NextResponse.json({ address });
  } catch {
    return NextResponse.json({ address: null });
  }
}
