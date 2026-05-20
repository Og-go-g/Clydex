import { NextRequest, NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { activateSession, deactivateSession, isSessionActive } from "@/lib/copy/session-activator";
import { CURRENT_TERMS_VERSION, hasAcceptedCurrentTerms } from "@/lib/legal";
import { NonceStoreUnavailableError } from "@/lib/auth/nonce-store";

/**
 * POST /api/copy/activate
 * Activate copy trading by storing encrypted session keypair.
 * Body: { sessionSecretKey: string } (base58-encoded 64-byte Ed25519 secret key)
 */
export async function POST(req: NextRequest) {
  const addr = await getAuthAddress();
  if (!addr) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Enforce ToS acceptance — copy trading involves additional risks (see §4
  // of Terms). User must have accepted current version before we'll store
  // their signing key. Deactivate path is intentionally not blocked so a
  // non-accepting user can still pull the plug.
  const accepted = await hasAcceptedCurrentTerms(addr);
  if (!accepted) {
    return NextResponse.json(
      {
        error: "Please accept the Terms of Service before enabling copy trading.",
        requiresTermsAcceptance: true,
        currentVersion: CURRENT_TERMS_VERSION,
      },
      { status: 403 },
    );
  }

  try {
    const body = await req.json();
    const { sessionSecretKey, sessionId, nonce, walletSignature } = body;

    if (!sessionSecretKey || typeof sessionSecretKey !== "string") {
      return NextResponse.json({ error: "sessionSecretKey is required (base58 string)" }, { status: 400 });
    }
    if (!nonce || typeof nonce !== "string" || nonce.length < 32 || nonce.length > 128) {
      return NextResponse.json({ error: "nonce is required (hex string from /api/copy/activate-challenge)" }, { status: 400 });
    }
    if (!walletSignature || typeof walletSignature !== "string" || walletSignature.length < 64) {
      return NextResponse.json({ error: "walletSignature is required (base58 string)" }, { status: 400 });
    }

    const result = await activateSession(addr, sessionSecretKey, sessionId, {
      nonce,
      walletSignatureBase58: walletSignature,
    });

    return NextResponse.json({
      success: true,
      sessionPubkey: result.sessionPubkey,
      expiresAt: result.expiresAt.toISOString(),
    });
  } catch (err) {
    // Nonce store unreachable — same reasoning as /api/auth/login: 503, not
    // 400. Lets the browser distinguish "your request is malformed" from
    // "our backend is briefly degraded, retry in a few seconds".
    if (err instanceof NonceStoreUnavailableError) {
      return NextResponse.json(
        { error: "Activation temporarily unavailable" },
        { status: 503 },
      );
    }
    const message = err instanceof Error ? err.message : "Activation failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * DELETE /api/copy/activate
 * Deactivate copy trading.
 */
export async function DELETE() {
  const addr = await getAuthAddress();
  if (!addr) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  await deactivateSession(addr);
  return NextResponse.json({ success: true });
}

/**
 * GET /api/copy/activate
 * Check if copy trading session is active.
 *
 * Wraps the DB call so a transient hiccup returns 503 instead of a
 * generic 500 / unhandled throw. Used by FollowTraderDialog on open.
 * If this endpoint flips to a fake "inactive" on a brief pool blip,
 * the dialog falsely tells the user to enable copy trading and a
 * fresh wallet sign overwrites their real 30-day session in DB —
 * same masking class as /api/copy/status had pre-2026-05-16.
 */
export async function GET() {
  const addr = await getAuthAddress();
  if (!addr) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  try {
    const status = await isSessionActive(addr);
    return NextResponse.json(status, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  } catch (err) {
    console.error("[copy/activate GET]", err);
    return NextResponse.json(
      { error: "Session check temporarily unavailable. Retry shortly." },
      { status: 503 },
    );
  }
}
