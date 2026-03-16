import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { parseSiwsMessage, verifySiwsSignature, isValidSolanaAddress } from "@/lib/auth/siws";

/** POST /api/auth/login — verify Solana signature and create a session. */
export async function POST(req: Request) {
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

    // Validate domain matches this server
    const origin = req.headers.get("origin") || req.headers.get("referer") || "";
    const expectedHost = origin ? new URL(origin).host : "";
    if (!expectedHost || fields.domain !== expectedHost) {
      return NextResponse.json({ error: "Authentication failed" }, { status: 401 });
    }

    // Verify nonce matches the one stored in the session
    const session = await getSession();
    if (!session.nonce || fields.nonce !== session.nonce) {
      return NextResponse.json({ error: "Authentication failed" }, { status: 401 });
    }

    // Check message expiration
    if (fields.expirationTime) {
      const exp = new Date(fields.expirationTime);
      if (isNaN(exp.getTime()) || exp < new Date()) {
        return NextResponse.json({ error: "Authentication failed" }, { status: 401 });
      }
    }

    // Check issuedAt: not in the future (1 min clock skew) and not too old (5 min)
    const issued = new Date(fields.issuedAt);
    if (
      isNaN(issued.getTime()) ||
      issued.getTime() > Date.now() + 60_000 ||
      Date.now() - issued.getTime() > 5 * 60 * 1000
    ) {
      return NextResponse.json({ error: "Authentication failed" }, { status: 401 });
    }

    // CRITICAL: Verify the ed25519 signature
    const valid = verifySiwsSignature(message, signature);
    if (!valid) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    // Session rotation: destroy old session, create new
    session.destroy();
    const newSession = await getSession();
    newSession.address = fields.address; // base58 public key (case-sensitive)
    await newSession.save();

    return NextResponse.json({ address: newSession.address });
  } catch (error) {
    console.error("[api/auth/login] error:", error);
    return NextResponse.json(
      { error: "Authentication failed" },
      { status: 500 }
    );
  }
}
