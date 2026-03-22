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
  /** Absolute session creation time (ms since epoch) for max lifetime enforcement */
  createdAt?: number;
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
    sameSite: "strict" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  },
};

/** Get the current iron-session from cookies (server-side only). */
export async function getSession() {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions);
}

/** Max absolute session lifetime: 30 days (even with sliding refresh) */
const MAX_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** Shorthand: return the authenticated address or null. Refreshes cookie TTL. */
export async function getAuthAddress(): Promise<string | null> {
  const session = await getSession();
  if (!session.address) return null;

  // Enforce absolute session lifetime
  if (session.createdAt && Date.now() - session.createdAt > MAX_SESSION_LIFETIME_MS) {
    try { session.destroy(); } catch { /* session already invalid */ }
    return null;
  }

  // Refresh cookie TTL on each authenticated request (sliding session)
  await session.save();
  return session.address;
}
