import { NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { CURRENT_TERMS_VERSION, hasAcceptedCurrentTerms } from "@/lib/legal";

/**
 * GET /api/terms/status
 *
 * Returns whether the authenticated wallet has accepted the CURRENT version
 * of the Terms of Service / Privacy Policy. Clients use this to decide
 * whether to show the acceptance checkbox before mutating actions
 * (deposit, copy-trading enable).
 */
export async function GET() {
  const addr = await getAuthAddress();
  if (!addr) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const accepted = await hasAcceptedCurrentTerms(addr);
  return NextResponse.json(
    { accepted, currentVersion: CURRENT_TERMS_VERSION },
    { headers: { "Cache-Control": "no-store" } },
  );
}
