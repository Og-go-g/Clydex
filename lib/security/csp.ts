/**
 * Content-Security-Policy header builder + nonce generator.
 *
 * Lives in lib/security so it's reachable from both edge middleware
 * (which constructs the header on each request) and unit tests (which
 * verify the directives stay intact across edits). Edge runtime
 * supports Web Crypto and `btoa`, so the implementation uses them
 * directly instead of pulling in Node `crypto`.
 *
 * The policy itself is documented at the call site
 * (proxy.ts → buildCsp comment block). Summary of decisions:
 *
 *  - script-src     : `'self' 'nonce-<x>' 'strict-dynamic'` so
 *                     Next.js hydration + its dynamically-loaded
 *                     bundles inherit trust from the nonced root
 *                     script without needing a host whitelist.
 *  - style-src      : `'self' 'unsafe-inline'` retained because
 *                     next/font (Inter) and @solana/wallet-adapter
 *                     emit inline `<style>` blocks; removing it would
 *                     require a much larger refactor and styles are
 *                     a far weaker XSS vector than scripts.
 *  - connect-src    : explicit upstream allow-list (01 Exchange WS +
 *                     REST, mainnet Solana RPC, 01.xyz frontend).
 *  - frame-ancestors: 'none' — refuse to be framed anywhere.
 *  - object/embed   : 'none' — no plugins.
 *
 * CSP_RELAXED=true (env) bypasses the nonce flow and restores the
 * pre-2026-05-21 `'unsafe-inline'` behaviour as a no-redeploy
 * rollback. Default behaviour (env unset / any other value) is
 * strict (nonce enforced).
 */

/**
 * Per-request CSP nonce. Caller must:
 *   - put the full CSP header on the FORWARDED REQUEST headers (via
 *     `NextResponse.next({ request: { headers } })`), so Next.js's app
 *     renderer parses the nonce out of it and tags every framework /
 *     page bundle script. This is the load-bearing one — without it
 *     'strict-dynamic' refuses every script (2026-05-21 black-screen).
 *   - put the same CSP header on the RESPONSE so the browser enforces it.
 *   - optionally put the raw nonce in an `x-nonce` request header so
 *     server components can read it for custom <Script nonce={...}/>
 *     tags. Next.js itself does NOT use this header — it parses the
 *     CSP header instead.
 *
 * Uses Web Crypto so it runs unchanged on the edge runtime.
 */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Returns the full CSP header value. `relaxed=true` skips the nonce
 * and restores `'unsafe-inline'` for script-src — used as a
 * feature-flag rollback path.
 */
export function buildCsp(nonce: string, relaxed: boolean): string {
  const scriptSrc = relaxed
    ? "'self' 'unsafe-inline'"
    : `'self' 'nonce-${nonce}' 'strict-dynamic'`;
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: https: blob:",
    "connect-src 'self' https://zo-mainnet.n1.xyz wss://zo-mainnet.n1.xyz https://api.mainnet-beta.solana.com https://01.xyz",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "worker-src 'self' blob:",
  ].join("; ");
}
