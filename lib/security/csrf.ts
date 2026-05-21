/**
 * CSRF protection — double-submit cookie pattern.
 *
 * Why we need this: SameSite=Strict on the session cookie is a strong
 * baseline but isn't bullet-proof — there are edge cases (cross-site
 * subresource loads, browser-quirk timing, subdomain takeover) where
 * a forged request could still ride the session. The double-submit
 * pattern closes the gap by requiring the request to ALSO carry an
 * `x-csrf-token` header whose value matches the `clydex-csrf` cookie.
 * An attacker on a different origin can't read our cookie (Same-Origin
 * Policy + SameSite) so can't construct the matching header.
 *
 * Cookie name: `clydex-csrf`. Non-HttpOnly so the client JS can read
 * it and echo it in the header. The TOKEN itself is not a secret —
 * the security comes from the attacker not being able to read the
 * cookie to know what to send.
 *
 * Bootstrap path:
 *   1. Browser hits any page → middleware sees no CSRF cookie →
 *      DOESN'T fail (we'd lock out first-time visitors). Cookie is
 *      issued lazily on the first call to /api/auth/csrf.
 *   2. Browser calls GET /api/auth/csrf → gets back { token } and
 *      the matching cookie.
 *   3. Browser sets `x-csrf-token: <token>` on every mutating
 *      request via apiFetch.
 *   4. Middleware verifies header === cookie (timing-safe). Mismatch
 *      → 403 (strict) or Sentry breadcrumb (warn-only).
 *
 * Rollout strategy (CSRF_STRICT flag):
 *   - Default (env unset OR != "true"): warn-only. Mismatch → Sentry
 *     breadcrumb but request proceeds. Lets us verify all callers
 *     migrated before flipping to enforcement.
 *   - CSRF_STRICT=true: mismatch → 403. The enforced posture.
 *
 * Exemptions (middleware enforces these regardless of mode):
 *   - /api/auth/csrf — the bootstrap endpoint that issues the token.
 *   - /api/admin/* — bearer-CRON_SECRET protected, no browser flow.
 *   - /api/auth/login — caller has no session/cookie yet at first
 *     login, but the SIWS signature itself proves wallet ownership
 *     so CSRF is redundant. Subsequent mutating requests carry both.
 */

/** Cookie name. JS-readable so apiFetch can echo the value in the header. */
export const CSRF_COOKIE_NAME = "clydex-csrf";

/** Header name. Convention is `x-csrf-token`. */
export const CSRF_HEADER_NAME = "x-csrf-token";

/** Token lifetime. One year — token value isn't a secret; rotation
 * is via explicit /api/auth/csrf calls or session destruction. */
export const CSRF_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

/**
 * Generate a CSRF token. 256 bits of entropy, URL-safe base64.
 *
 * Uses Web Crypto so it runs unchanged in edge middleware. The token
 * itself isn't a secret (it's echoed back in plaintext on every
 * request) but high entropy prevents a remote attacker from guessing
 * it and provides per-session uniqueness.
 */
export function generateCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // Base64URL: replace + / with - _ and strip padding. Safe in headers
  // without quoting and in cookies without encoding.
  let s = btoa(String.fromCharCode(...bytes));
  s = s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return s;
}

/**
 * Constant-time string compare. Edge runtime doesn't ship Node's
 * `crypto.timingSafeEqual`, so we implement the equivalent by XORing
 * every byte and only returning at the end.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Paths exempt from CSRF enforcement. Order matters for documentation
 * clarity (most restrictive intent first); checks are by prefix match
 * via String.prototype.startsWith in the caller.
 */
export const CSRF_EXEMPT_PATHS = [
  // The bootstrap endpoint itself — can't require what it issues.
  "/api/auth/csrf",
  // SIWS signature proves wallet ownership; double-submit redundant
  // and we don't have a cookie yet at first call.
  "/api/auth/login",
  "/api/auth/nonce",
  // CRON_SECRET-bearer protected, no browser flow.
  "/api/admin/",
  // Health endpoint — uptime monitors don't carry a CSRF cookie.
  "/api/health",
] as const;

export function isCsrfExempt(pathname: string): boolean {
  for (const prefix of CSRF_EXEMPT_PATHS) {
    if (pathname === prefix || pathname.startsWith(prefix)) return true;
  }
  return false;
}

export interface CsrfCheckInputs {
  /** Value of x-csrf-token request header, or null if missing. */
  headerToken: string | null;
  /** Value of clydex-csrf request cookie, or null if missing. */
  cookieToken: string | null;
}

export type CsrfCheckResult =
  | { ok: true }
  | { ok: false; reason: "missing_header" | "missing_cookie" | "mismatch" };

/**
 * Verify the double-submit pair. Returns `{ ok: true }` when header
 * and cookie are present, non-empty, and constant-time-equal. Caller
 * (middleware) decides what to do with an `ok: false` result based
 * on the CSRF_STRICT flag.
 */
export function verifyCsrfPair(inputs: CsrfCheckInputs): CsrfCheckResult {
  const { headerToken, cookieToken } = inputs;
  if (!headerToken || headerToken.length === 0) {
    return { ok: false, reason: "missing_header" };
  }
  if (!cookieToken || cookieToken.length === 0) {
    return { ok: false, reason: "missing_cookie" };
  }
  if (!constantTimeEqual(headerToken, cookieToken)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}
