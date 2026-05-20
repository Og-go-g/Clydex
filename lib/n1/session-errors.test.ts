/**
 * Session-error matcher — enumerates the SDK phrases we want to retry on
 * (positives) and the look-alike order/validation errors we must NOT
 * retry on (negatives). A false positive here causes a teardown→wallet-
 * sign→re-submit loop on a perfectly good session; a false negative
 * leaves the user stuck with a stale session and a misleading error.
 */

import { describe, it, expect } from "vitest";
import { isSessionError } from "./session-errors";

describe("isSessionError — positive cases (must retry)", () => {
  const sessionPhrases = [
    "Invalid or empty session ID. Please create or refresh your session.",
    "invalid or empty session id",
    "Your session expired",
    "session not found",
    "session   not   found", // tolerant of whitespace
    "session invalid",
    "session revoked",
    "Invalid session",
    "Invalid session.",
    "Please refresh your session",
    "Please create your session",
    "PLEASE CREATE YOUR SESSION", // case insensitivity
  ];

  for (const phrase of sessionPhrases) {
    it(`matches: "${phrase}"`, () => {
      expect(isSessionError(phrase)).toBe(true);
    });
  }
});

describe("isSessionError — negative cases (must NOT trigger session retry)", () => {
  const nonSessionPhrases = [
    "Invalid market",
    "Invalid market symbol",
    "Invalid order size",
    "invalid leverage",
    "Invalid signature",
    "Invalid params",
    "Invalid request",
    "insufficient balance",
    "max leverage exceeded",
    "Connection refused",
    "Cannot read property 'foo' of undefined",
    "Bad request",
    "", // empty string
    "Something went wrong",
  ];

  for (const phrase of nonSessionPhrases) {
    it(`does not match: "${phrase}"`, () => {
      expect(isSessionError(phrase)).toBe(false);
    });
  }
});

describe("isSessionError — edge cases", () => {
  it("returns false for the empty string", () => {
    expect(isSessionError("")).toBe(false);
  });

  it("matches when the SDK message embeds the phrase in a longer error", () => {
    // Real SDK output sometimes wraps the phrase in a status code prefix
    // like "HTTP 401: <message>". The matcher must still trigger.
    expect(isSessionError("HTTP 401: Invalid or empty session ID. Please create or refresh your session.")).toBe(true);
  });

  it("does not match 'invalid' alone without 'session'", () => {
    // Guard against accidentally widening to /invalid/i — that would
    // catch "Invalid market" / "Invalid order size".
    expect(isSessionError("Invalid")).toBe(false);
    expect(isSessionError("invalid request body")).toBe(false);
  });

  it("does not match 'expired' alone without 'session'", () => {
    // Similarly: bare "expired" would match "Wallet signature expired"
    // / "Quote expired" / "Order expired", which are NOT session errors.
    expect(isSessionError("expired")).toBe(false);
    expect(isSessionError("Quote expired")).toBe(false);
    expect(isSessionError("Wallet signature expired")).toBe(false);
  });
});
