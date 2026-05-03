/**
 * GET /api/admin/test-sentry
 *
 * Probe endpoint that verifies the Sentry breadcrumb plumbing added in
 * Phase 8c follow-up #3 actually works end-to-end:
 *   - Sentry SDK is initialized in the production runtime
 *   - addBreadcrumb writes into the current request's Sentry Hub
 *   - the throw at the end is caught by Sentry's automatic error
 *     instrumentation and uploaded WITH the breadcrumbs attached
 *
 * Why this exists as a real endpoint instead of a one-off script:
 * Sentry server-side scope is per-request. A breadcrumb added in one
 * request does NOT propagate to an exception thrown in a different
 * request — they live in different Hubs. So to verify the breadcrumb
 * → event linkage you need both to happen in a single HTTP request,
 * which means an endpoint.
 *
 * Auth: same CRON_SECRET bearer pattern as /api/admin/queue-stats. Not
 * exposed to anyone without the env-set secret.
 *
 * To use:
 *   curl -s -H "Authorization: Bearer $CRON_SECRET" \
 *     https://your-domain/api/admin/test-sentry
 *   # Then open the latest event in Sentry; the Breadcrumbs panel
 *   # should contain three entries with category=history-sync.
 *
 * The probe is safe to call repeatedly — each invocation generates one
 * Sentry event tagged `probe=test-sentry` so you can filter the noise.
 * If you want to retire this endpoint after the one-time verification,
 * delete the route file; nothing else depends on it.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

const PROBE_ERROR_MESSAGE =
  "[probe] Sentry breadcrumb verification — expected if you triggered /api/admin/test-sentry";

export async function GET(request: NextRequest) {
  // ─── Admin auth ───────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured on this server" },
      { status: 500 },
    );
  }

  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret}`;
  // Constant-time compare; pad to equal length to avoid length-leak side-channel.
  const maxLen = Math.max(auth.length, expected.length);
  const authBuf = Buffer.from(auth.padEnd(maxLen));
  const expectedBuf = Buffer.from(expected.padEnd(maxLen));
  if (auth.length !== expected.length || !timingSafeEqual(authBuf, expectedBuf)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ─── Probe payload ────────────────────────────────────────────
  // Three breadcrumbs that mirror the real sync flow shape (same
  // category and `data` field structure as the production calls in
  // lib/history/sync.ts and lib/history/queries.ts). If the breadcrumb
  // → event linkage works, all three should appear under "Breadcrumbs"
  // in the Sentry event detail view, in chronological order.
  const probeAccountId = -1; // unmistakably synthetic
  const probeStartedAt = Date.now();

  Sentry.addBreadcrumb({
    category: "history-sync",
    message: "trades sync completed",
    level: "info",
    data: { type: "trades", accountId: probeAccountId, inserted: 7, durationMs: 123 },
  });

  Sentry.addBreadcrumb({
    category: "history-sync",
    message: "pnl sync completed",
    level: "info",
    data: { type: "pnl", accountId: probeAccountId, inserted: 3, durationMs: 89 },
  });

  Sentry.addBreadcrumb({
    category: "history-sync",
    message: "realtime mini-sync pulled fresh rows",
    level: "info",
    data: { accountId: probeAccountId, freshTrades: 4, freshPnl: 2 },
  });

  // Tag this event so it's trivially filterable in Sentry — `probe:true`
  // searches will return only verification events, not real production
  // errors.
  Sentry.setTag("probe", "test-sentry");
  Sentry.setTag("probe.account_id", String(probeAccountId));

  // The throw is the whole point: this is what generates the Sentry
  // event with breadcrumbs attached. Re-thrown out of try/catch so
  // Next.js's error boundary captures it.
  throw new Error(`${PROBE_ERROR_MESSAGE} (probe started ${probeStartedAt})`);
}
