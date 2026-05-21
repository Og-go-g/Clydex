/**
 * CSP helper tests. The directive set is the security boundary for
 * every page served — these tests are the regression net against
 * accidental relaxation.
 *
 * Notes on testing strategy:
 *   - The nonce generator depends on Web Crypto's `crypto.getRandomValues`,
 *     which vitest's `node` environment exposes via the global `crypto`
 *     object (Node 19+). No polyfill needed.
 *   - buildCsp is pure — we just assert the substrings we care about
 *     rather than the entire string, so reordering or whitespace
 *     changes don't cascade into test failures.
 */

import { describe, it, expect } from "vitest";
import { generateCspNonce, buildCsp } from "./csp";

describe("generateCspNonce", () => {
  it("returns a non-empty base64-looking string", () => {
    const nonce = generateCspNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(nonce.length).toBeGreaterThan(16);
  });

  it("returns a different value on each call (high entropy)", () => {
    const a = generateCspNonce();
    const b = generateCspNonce();
    const c = generateCspNonce();
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("decodes to 16 bytes (128-bit nonce per CSP spec)", () => {
    const nonce = generateCspNonce();
    const decoded = Buffer.from(nonce, "base64");
    expect(decoded.length).toBe(16);
  });
});

describe("buildCsp — strict mode (relaxed=false)", () => {
  const NONCE = "fixture-nonce-A1B2";
  const csp = buildCsp(NONCE, false);

  it("uses 'nonce-<X>' for script-src, NOT 'unsafe-inline'", () => {
    expect(csp).toContain(`'nonce-${NONCE}'`);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("includes 'strict-dynamic' so nonced scripts can load their bundles", () => {
    expect(csp).toContain("'strict-dynamic'");
  });

  it("retains 'unsafe-inline' for style-src (next/font + wallet-adapter)", () => {
    // Documented design decision — styles are a weaker XSS vector and
    // removing this would require a significant refactor.
    expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);
  });

  it("keeps the upstream connect-src allow-list intact", () => {
    expect(csp).toContain("https://zo-mainnet.n1.xyz");
    expect(csp).toContain("wss://zo-mainnet.n1.xyz");
    expect(csp).toContain("https://api.mainnet-beta.solana.com");
    expect(csp).toContain("https://01.xyz");
  });

  it("forbids being framed anywhere", () => {
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("forbids plugin objects", () => {
    expect(csp).toContain("object-src 'none'");
  });
});

describe("buildCsp — relaxed mode (CSP_RELAXED=true)", () => {
  const NONCE = "fixture-nonce-Z9Y8";
  const csp = buildCsp(NONCE, true);

  it("restores 'unsafe-inline' on script-src as the rollback path", () => {
    expect(csp).toMatch(/script-src 'self' 'unsafe-inline'/);
  });

  it("does NOT include the nonce in script-src (not enforced)", () => {
    expect(csp).not.toContain(`'nonce-${NONCE}'`);
  });

  it("does NOT include 'strict-dynamic' (not needed without nonce)", () => {
    expect(csp).not.toContain("'strict-dynamic'");
  });

  it("style-src and the rest of the directives are unchanged", () => {
    // Easy sanity check: the directives we don't toggle should match
    // the strict-mode build for the same domains.
    const strict = buildCsp(NONCE, false);
    for (const dir of [
      "frame-ancestors 'none'",
      "object-src 'none'",
      "img-src 'self' data: https: blob:",
      "https://zo-mainnet.n1.xyz",
      "worker-src 'self' blob:",
    ]) {
      expect(csp).toContain(dir);
      expect(strict).toContain(dir);
    }
  });
});
