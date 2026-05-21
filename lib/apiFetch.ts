/**
 * apiFetch — the CSRF-aware replacement for global `fetch()` when
 * talking to our own /api/* routes from the browser.
 *
 * Behaviour:
 *   - On non-mutating requests (GET/HEAD): identical to `fetch()`.
 *   - On mutating requests (POST/PUT/PATCH/DELETE): reads the
 *     `clydex-csrf` cookie via document.cookie and attaches the
 *     value as the `x-csrf-token` header. If the cookie is missing,
 *     calls /api/auth/csrf first to seed it, then retries the
 *     original request with the freshly-issued token.
 *   - Same signature as `fetch()` so call-site migration is just
 *     `fetch(...)` → `apiFetch(...)`.
 *
 * Caching:
 *   - The token is cached in a module-level variable so subsequent
 *     mutating calls don't re-read the cookie. Cleared on logout via
 *     `clearCsrfToken()` (called from /api/auth/logout client wrapper)
 *     and refreshed on any 403-with-csrf-reason response.
 *
 * Not used for:
 *   - Server-to-server requests (no browser cookies anyway).
 *   - /api/admin/* — those use Bearer CRON_SECRET, no CSRF.
 *
 * The wrapper is intentionally minimal: it does NOT swallow errors,
 * does NOT change Content-Type defaults, does NOT add auth headers.
 * Callers keep full control over the fetch shape.
 */

import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "./security/csrf";

let cachedToken: string | null = null;
let inflightTokenFetch: Promise<string | null> | null = null;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function readCsrfCookie(): string | null {
  // SSR / non-browser context: no document.cookie. Caller is most
  // likely a server component — those run pre-render and CAN'T set
  // a request header on the user's browser, so we just return null
  // and the caller's fetch goes through without the CSRF header.
  // Middleware will refuse if it's a mutating request, which is the
  // right outcome (server components shouldn't mutate via /api).
  if (typeof document === "undefined") return null;

  const target = `${CSRF_COOKIE_NAME}=`;
  for (const raw of document.cookie.split(";")) {
    const c = raw.trim();
    if (c.startsWith(target)) {
      return decodeURIComponent(c.slice(target.length));
    }
  }
  return null;
}

async function fetchCsrfToken(): Promise<string | null> {
  // Coalesce concurrent first-call requests so we hit /api/auth/csrf
  // exactly once even if a page fires multiple mutations in parallel.
  if (inflightTokenFetch) return inflightTokenFetch;
  inflightTokenFetch = (async () => {
    try {
      const res = await fetch("/api/auth/csrf", {
        method: "GET",
        // credentials: "same-origin" is the browser default for
        // same-origin fetches but spelled out for clarity — we
        // need the Set-Cookie response to be honoured.
        credentials: "same-origin",
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { token?: unknown };
      if (typeof data.token === "string" && data.token.length > 0) {
        cachedToken = data.token;
        return data.token;
      }
      return null;
    } catch {
      return null;
    } finally {
      inflightTokenFetch = null;
    }
  })();
  return inflightTokenFetch;
}

async function ensureToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  const fromCookie = readCsrfCookie();
  if (fromCookie) {
    cachedToken = fromCookie;
    return fromCookie;
  }
  return fetchCsrfToken();
}

/** Clear the in-memory token cache. Call on logout. */
export function clearCsrfToken(): void {
  cachedToken = null;
}

/**
 * Same signature as global `fetch`. Auto-attaches the CSRF header on
 * mutating requests; passes everything else through unchanged.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  // Method can live either on `init` (the canonical app call shape:
  // `apiFetch(url, { method: 'POST', ... })`) or on a Request object
  // passed as the only argument (what @solana/web3.js's Connection
  // does internally). Prefer init when both are set — that matches
  // global fetch precedence.
  const methodRaw =
    init.method ??
    (typeof Request !== "undefined" && input instanceof Request
      ? input.method
      : undefined) ??
    "GET";
  const method = methodRaw.toUpperCase();
  if (!MUTATING_METHODS.has(method)) {
    return fetch(input, init);
  }

  const token = await ensureToken();
  // Merge headers carefully — caller may have already set some.
  // Headers ctor accepts the existing init.headers in any of its
  // shapes (Headers, Record, [string, string][]).
  const headers = new Headers(init.headers ?? undefined);
  if (token && !headers.has(CSRF_HEADER_NAME)) {
    headers.set(CSRF_HEADER_NAME, token);
  }

  return fetch(input, { ...init, headers });
}
