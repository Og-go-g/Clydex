import { NextResponse } from "next/server";
import { getSession, revokeAllSessionsFor } from "@/lib/auth/session";

/**
 * POST /api/auth/logout — destroy the session cookie AND revoke any other
 * cookies issued for this wallet before this moment.
 *
 * Destroying the cookie only logs THIS device out (because iron-session
 * keeps all state in the encrypted cookie). A previously-stolen cookie
 * would still work. revokeAllSessionsFor() writes a per-wallet
 * "minimum valid createdAt"; getAuthAddress refuses any session whose
 * createdAt is older. So after logout, every existing cookie that
 * carries this address becomes invalid within the revocation-cache
 * TTL (60s).
 */
export async function POST() {
  try {
    const session = await getSession();
    const address = session.address;
    session.destroy();
    if (address) {
      await revokeAllSessionsFor(address);
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to logout" },
      { status: 500 }
    );
  }
}
