/**
 * GET /api/auth/csrf — issue (or re-issue) the CSRF double-submit token.
 *
 * Behaviour:
 *   - If the request already has a `clydex-csrf` cookie, returns
 *     the existing token (same one in body) — idempotent for clients
 *     that just want to refresh their in-memory copy.
 *   - If the cookie is missing or empty, generates a new one and
 *     sets it via Set-Cookie.
 *
 * Anonymous endpoint. No auth required — the bootstrap precedes
 * login. Rate-limited by the IP-keyed middleware bucket so an
 * attacker can't farm tokens to exhaust entropy logging.
 *
 * Token attributes:
 *   - 256-bit URL-safe base64, generated via Web Crypto.
 *   - Cookie: SameSite=Strict, Path=/, HttpOnly=false (must be
 *     JS-readable for the apiFetch wrapper to echo it in the
 *     x-csrf-token header), Secure in production, MaxAge 1 year.
 *
 * Response shape:
 *   { token: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  CSRF_COOKIE_NAME,
  CSRF_COOKIE_MAX_AGE_S,
  generateCsrfToken,
} from "@/lib/security/csrf";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  const cookieStore = await cookies();
  const existing = cookieStore.get(CSRF_COOKIE_NAME)?.value;
  const token = existing && existing.length > 0 ? existing : generateCsrfToken();

  const res = NextResponse.json({ token });

  // Always re-set the cookie (idempotent if value matches; refreshes
  // expiry on every call). NOT HttpOnly — apiFetch needs to read it.
  res.cookies.set({
    name: CSRF_COOKIE_NAME,
    value: token,
    path: "/",
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    httpOnly: false,
    maxAge: CSRF_COOKIE_MAX_AGE_S,
  });

  return res;
}
