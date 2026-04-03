import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getSession } from "@/lib/auth/session";
import { parseSiwsMessage, verifySiwsSignature, isValidSolanaAddress } from "@/lib/auth/siws";
import { consumeNonce } from "@/lib/auth/nonce-store";

/** POST /api/auth/login — verify Solana signature and create a session. */
export async function POST(req: Request) {
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > 10_000) {
    return NextResponse.json({ error: "Request too large" }, { status: 413 });
  }

  try {
    const body = await req.json();
    const { message, signature } = body;

    if (typeof message !== "string" || typeof signature !== "string") {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    // Parse the SIWS message
    const fields = parseSiwsMessage(message);
    if (!fields) {
      return NextResponse.json(
        { error: "Invalid message format" },
        { status: 400 }
      );
    }

    // Validate address format (base58 Solana public key)
    if (!isValidSolanaAddress(fields.address)) {
      return NextResponse.json(
        { error: "Invalid address in message" },
        { status: 400 }
      );
    }

    // Validate domain matches this server (only use origin, not referer — referer is spoofable)
    const origin = req.headers.get("origin") || "";
    const expectedHost = origin ? new URL(origin).host : "";
    if (!expectedHost || fields.domain !== expectedHost) {
      return NextResponse.json({ error: "Authentication failed" }, { status: 401 });
    }

    // Check message expiration
    if (fields.expirationTime) {
      const exp = new Date(fields.expirationTime);
      if (isNaN(exp.getTime()) || exp < new Date()) {
        return NextResponse.json({ error: "Authentication failed" }, { status: 401 });
      }
    }

    // Check issuedAt: not in the future (30s clock skew) and not too old (60s)
    const issued = new Date(fields.issuedAt);
    if (
      isNaN(issued.getTime()) ||
      issued.getTime() > Date.now() + 30_000 ||
      Date.now() - issued.getTime() > 60_000
    ) {
      return NextResponse.json({ error: "Authentication failed" }, { status: 401 });
    }

    // CRITICAL: Verify the ed25519 signature BEFORE consuming the nonce
    const valid = verifySiwsSignature(message, signature);
    if (!valid) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    // Atomically consume nonce server-side AFTER signature is verified
    // (prevents nonce exhaustion via forged signatures)
    if (!(await consumeNonce(fields.nonce))) {
      return NextResponse.json({ error: "Authentication failed" }, { status: 401 });
    }

    // Session rotation: destroy old session, create new
    const session = await getSession();
    session.destroy();
    const newSession = await getSession();
    newSession.address = fields.address; // base58 public key (case-sensitive)
    newSession.createdAt = Date.now();
    await newSession.save();

    return NextResponse.json({ address: newSession.address });
  } catch (error) {
    Sentry.captureException(error, { tags: { endpoint: "auth-login" } });
    return NextResponse.json(
      { error: "Authentication failed" },
      { status: 500 }
    );
  }
}
