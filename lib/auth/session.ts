import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";

/* ------------------------------------------------------------------ */
/*  Encrypted cookie session via iron-session                         */
/* ------------------------------------------------------------------ */

export interface SessionData {
  /** Auth nonce — consumed after successful login */
  nonce?: string;
  /** Authenticated Solana public key (base58) */
  address?: string;
}

const SESSION_PASSWORD = process.env.SESSION_SECRET || process.env.SIWE_SECRET;
if (!SESSION_PASSWORD || SESSION_PASSWORD.length < 32) {
  throw new Error("SESSION_SECRET must be set and at least 32 characters");
}

const sessionOptions: SessionOptions = {
  password: SESSION_PASSWORD,
  cookieName: "clydex-session",
  cookieOptions: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24, // 24 hours
  },
};

/** Get the current iron-session from cookies (server-side only). */
export async function getSession() {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions);
}

/** Shorthand: return the authenticated address or null. */
export async function getAuthAddress(): Promise<string | null> {
  const session = await getSession();
  return session.address ?? null;
}
