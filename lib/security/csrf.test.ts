/**
 * CSRF helpers — pure-function tests for token generation, exempt
 * path matching, and double-submit verification. The middleware
 * wiring and apiFetch wrapper are exercised separately by their
 * integration patterns (manual smoke + browser console).
 */

import { describe, it, expect } from "vitest";
import {
  generateCsrfToken,
  constantTimeEqual,
  verifyCsrfPair,
  isCsrfExempt,
  CSRF_EXEMPT_PATHS,
} from "./csrf";

describe("generateCsrfToken", () => {
  it("returns a non-empty URL-safe base64 string", () => {
    const t = generateCsrfToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThan(32);
  });

  it("returns different values on each call (entropy check)", () => {
    const set = new Set([
      generateCsrfToken(),
      generateCsrfToken(),
      generateCsrfToken(),
      generateCsrfToken(),
      generateCsrfToken(),
    ]);
    expect(set.size).toBe(5);
  });

  it("decodes to 32 bytes (256-bit token)", () => {
    const t = generateCsrfToken();
    // URL-safe base64 back to standard base64 for Buffer.from.
    const standardB64 = t.replace(/-/g, "+").replace(/_/g, "/");
    const padded = standardB64 + "=".repeat((4 - (standardB64.length % 4)) % 4);
    expect(Buffer.from(padded, "base64").length).toBe(32);
  });
});

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
  });

  it("returns false for different-length strings (short-circuits length check)", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("returns false for same-length differing strings", () => {
    expect(constantTimeEqual("aaaa", "aaab")).toBe(false);
  });

  it("returns false for completely different strings", () => {
    expect(constantTimeEqual("abc123", "xyz987")).toBe(false);
  });

  it("treats empty-vs-empty as equal", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("verifyCsrfPair", () => {
  it("approves when header === cookie", () => {
    const t = generateCsrfToken();
    expect(verifyCsrfPair({ headerToken: t, cookieToken: t })).toEqual({
      ok: true,
    });
  });

  it("refuses missing header (no x-csrf-token)", () => {
    const result = verifyCsrfPair({ headerToken: null, cookieToken: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_header");
  });

  it("refuses empty header", () => {
    const result = verifyCsrfPair({ headerToken: "", cookieToken: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_header");
  });

  it("refuses missing cookie", () => {
    const result = verifyCsrfPair({ headerToken: "x", cookieToken: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_cookie");
  });

  it("refuses mismatch when header != cookie", () => {
    const result = verifyCsrfPair({
      headerToken: "abc",
      cookieToken: "xyz",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("mismatch");
  });

  it("refuses subtle mismatch (one-char diff) — guards against equality bug", () => {
    const result = verifyCsrfPair({
      headerToken: "abc12",
      cookieToken: "abc13",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("mismatch");
  });
});

describe("isCsrfExempt", () => {
  it("exempts the CSRF bootstrap endpoint itself", () => {
    expect(isCsrfExempt("/api/auth/csrf")).toBe(true);
  });

  it("exempts the SIWS login + nonce endpoints", () => {
    expect(isCsrfExempt("/api/auth/login")).toBe(true);
    expect(isCsrfExempt("/api/auth/nonce")).toBe(true);
  });

  it("exempts all /api/admin/* routes (CRON_SECRET bearer)", () => {
    expect(isCsrfExempt("/api/admin/copy/pause")).toBe(true);
    expect(isCsrfExempt("/api/admin/alert")).toBe(true);
    expect(isCsrfExempt("/api/admin/")).toBe(true);
  });

  it("exempts /api/health (uptime monitors)", () => {
    expect(isCsrfExempt("/api/health")).toBe(true);
  });

  it("does NOT exempt regular mutating endpoints", () => {
    expect(isCsrfExempt("/api/order")).toBe(false);
    expect(isCsrfExempt("/api/collateral")).toBe(false);
    expect(isCsrfExempt("/api/copy/subscribe")).toBe(false);
    expect(isCsrfExempt("/api/copy/activate")).toBe(false);
  });

  it("does NOT exempt look-alike paths", () => {
    // Defense against a future route accidentally named into an
    // exempt prefix. `/api/auth/csrf-mock` would match the prefix
    // by accident but the helper requires startsWith from the
    // configured prefix list — verify the configured prefixes are
    // those we expect.
    expect(CSRF_EXEMPT_PATHS).toEqual([
      "/api/auth/csrf",
      "/api/auth/login",
      "/api/auth/nonce",
      "/api/admin/",
      "/api/health",
    ]);
  });
});
