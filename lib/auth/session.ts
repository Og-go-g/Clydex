import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";

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

/* ------------------------------------------------------------------ */
/*  Per-wallet session revocation                                     */
/* ------------------------------------------------------------------ */
//
// Iron-session keeps all state in an encrypted cookie. A cookie that
// leaks (XSS, malware, shoulder-surf) stays valid until natural
// expiry — even after the user clicks "Log out". This module adds a
// server-side "minimum valid session createdAt" per wallet: logout
// upserts revokedAt = NOW(); getAuthAddress refuses any session whose
// createdAt is older than that. Cached in-process for 60s so the hot
// auth path doesn't take a DB hit on every request.

const REVOCATION_TTL_MS = 60_000;
const revocationCache = new Map<string, { revokedAt: number; cachedAt: number }>();

async function loadRevocation(walletAddr: string): Promise<number | null> {
  const cached = revocationCache.get(walletAddr);
  if (cached && Date.now() - cached.cachedAt < REVOCATION_TTL_MS) {
    return cached.revokedAt > 0 ? cached.revokedAt : null;
  }
  try {
    const row = await prisma.sessionRevocation.findUnique({
      where: { walletAddr },
      select: { revokedAt: true },
    });
    const revokedAt = row ? row.revokedAt.getTime() : 0;
    revocationCache.set(walletAddr, { revokedAt, cachedAt: Date.now() });
    return revokedAt > 0 ? revokedAt : null;
  } catch {
    // DB outage: don't lock out users. Return cached value if any,
    // otherwise treat as no revocation. Cookies still expire naturally.
    return cached ? (cached.revokedAt > 0 ? cached.revokedAt : null) : null;
  }
}

/**
 * Mark every session for `walletAddr` issued before now as revoked.
 * Bypasses the in-process cache so the change is observed by the next
 * getAuthAddress() within REVOCATION_TTL_MS at the latest.
 */
export async function revokeAllSessionsFor(walletAddr: string): Promise<void> {
  const now = new Date();
  try {
    await prisma.sessionRevocation.upsert({
      where: { walletAddr },
      create: { walletAddr, revokedAt: now },
      update: { revokedAt: now },
    });
    revocationCache.set(walletAddr, { revokedAt: now.getTime(), cachedAt: Date.now() });
  } catch (err) {
    console.warn("[auth] revokeAllSessionsFor failed:", err);
  }
}

/** Shorthand: return the authenticated address or null. Refreshes cookie TTL. */
export async function getAuthAddress(): Promise<string | null> {
  const session = await getSession();
  if (!session.address) return null;

  // Enforce absolute session lifetime
  if (session.createdAt && Date.now() - session.createdAt > MAX_SESSION_LIFETIME_MS) {
    try { session.destroy(); } catch { /* session already invalid */ }
    return null;
  }

  // Per-wallet revocation: refuse sessions issued before the last logout.
  const revokedAt = await loadRevocation(session.address);
  if (revokedAt !== null) {
    const createdAt = session.createdAt ?? 0;
    if (createdAt <= revokedAt) {
      try { session.destroy(); } catch { /* session already invalid */ }
      return null;
    }
  }

  // Refresh cookie TTL on each authenticated request (sliding session)
  await session.save();
  return session.address;
}
