/**
 * SDK session-error classifier.
 *
 * Distinguishes "the in-memory NordUser session is dead" (expired,
 * revoked, evicted, signature mismatch) from "your order is wrong"
 * (bad market, bad leverage, bad size). The two error families look
 * superficially similar — both come out of @n1xyz/nord-ts as plain
 * Error.message strings — but only the first should trigger a session
 * teardown + wallet re-sign + retry. Matching too broadly (e.g.
 * `msg.includes("invalid")`) tears down a good session, forces a
 * wallet popup, and re-submits the same bad order in a loop.
 *
 * Add a new phrase only after you've seen it in real SDK output, and
 * add the test case alongside it. Do NOT add phrases that contain just
 * "invalid" without "session", or "expired" without "session" — those
 * collide with order-validation errors.
 *
 * SDK phrases this matches (each pattern is intentionally precise):
 *   - "Invalid or empty session ID. Please create or refresh your session."
 *     The canonical message from @n1xyz/nord-ts when sessionId is
 *     unknown server-side.
 *   - "session expired"        — engine returns this when TTL elapsed.
 *   - "session not found"      — exchange evicted the row.
 *   - "session invalid"        — engine returns this on signature mismatch.
 *   - "session revoked"        — operator revoked it via admin tooling.
 *   - "Invalid session"        — older SDK variant.
 *   - "Please create your session" / "Please refresh your session"
 *     — fallback for SDK phrasings that mention "session" later in
 *     the sentence rather than immediately after the verb.
 *
 * Phrases this deliberately does NOT match:
 *   - "Invalid market" / "Invalid order size" / "invalid leverage"
 *   - "Invalid signature" / "Invalid params" / "Invalid request"
 *   - any message that doesn't reference "session" at all
 *
 * Other call sites (`hooks/useOrderActions.ts`,
 * `hooks/useCollateral.ts`) historically used less precise matchers
 * (`includes("session") || includes("expired")`). Migrating them here
 * is out-of-scope for the change that introduced this helper because
 * it would visibly alter their behaviour; see the C7-row audit notes
 * if you ever pick that up.
 */

const SESSION_ERROR_PATTERNS: readonly RegExp[] = [
  /invalid\s+or\s+empty\s+session\s+id/i,
  /session\s+(expired|not\s+found|invalid|revoked)/i,
  /invalid\s+session\b/i,
  /please\s+(create|refresh)\s+your\s+session/i,
];

/**
 * Returns true if `message` indicates the NordUser session must be
 * recreated. Pass empty string for non-Error throws; matching is
 * case-insensitive across all patterns.
 */
export function isSessionError(message: string): boolean {
  if (!message) return false;
  for (const pattern of SESSION_ERROR_PATTERNS) {
    if (pattern.test(message)) return true;
  }
  return false;
}
