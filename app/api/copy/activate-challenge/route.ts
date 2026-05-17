import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getAuthAddress } from "@/lib/auth/session";
import { storeNonce } from "@/lib/auth/nonce-store";

/**
 * GET /api/copy/activate-challenge
 *
 * Issues a short-lived nonce that the caller must include in the activation
 * payload, alongside a wallet signature over the canonical activation
 * message. This is the proof-of-ownership step that prevents an XSS or a
 * compromised client from rebinding a victim's account to an attacker-
 * controlled session keypair — the wallet that owns the address must
 * actively sign the activation, including the specific session pubkey.
 *
 * Reuses the existing PG-backed nonce store (single-use, 5min TTL). The
 * caller's wallet address is also returned so clients can build the
 * canonical message without ambiguity.
 */
export async function GET() {
  const addr = await getAuthAddress();
  if (!addr) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const nonce = randomBytes(32).toString("hex");
  await storeNonce(nonce);

  return NextResponse.json(
    {
      nonce,
      walletAddr: addr,
      expiresInSeconds: 300,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Build the canonical activation message. Must match exactly between
 * client (which signs) and server (which verifies).
 */
export function buildActivationMessage(params: {
  walletAddr: string;
  sessionPubkey: string;
  nonce: string;
}): string {
  return [
    "Clydex N1 — Enable copy trading",
    "",
    `Wallet: ${params.walletAddr}`,
    `Session: ${params.sessionPubkey}`,
    `Nonce: ${params.nonce}`,
  ].join("\n");
}
