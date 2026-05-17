import { NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { CURRENT_TERMS_VERSION, recordTermsAcceptance } from "@/lib/legal";

/**
 * POST /api/terms/accept
 *
 * Records that the authenticated wallet has accepted the current ToS
 * version. Body is intentionally empty — the version comes from the
 * server (CURRENT_TERMS_VERSION) so a malicious client cannot pin
 * acceptance to a stale version.
 *
 * Server-side enforcement of acceptance lives in the deposit and
 * copy-trading-activate endpoints; this route just stores the row.
 */
export async function POST() {
  const addr = await getAuthAddress();
  if (!addr) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  try {
    await recordTermsAcceptance(addr);
    return NextResponse.json({ accepted: true, version: CURRENT_TERMS_VERSION });
  } catch (err) {
    console.error("[terms/accept]", err);
    return NextResponse.json(
      { error: "Could not record acceptance. Please try again." },
      { status: 500 },
    );
  }
}
