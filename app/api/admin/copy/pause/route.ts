/**
 * POST /api/admin/copy/pause     — flip kill switch ON
 * POST /api/admin/copy/resume    — flip kill switch OFF
 * GET  /api/admin/copy/pause     — read current state
 *
 * Auth: same Bearer CRON_SECRET pattern as the other /api/admin/* routes.
 *
 * Time-to-effect: within KILL_SWITCH_TTL_MS (2s) of the response, the
 * next sign call in the copy engine reads the new value and refuses.
 *
 * Body for POST:
 *   { reason?: string }   — required in practice for the pause action,
 *                           informational. Logged to system_flags.reason
 *                           and surfaced in Sentry.
 *
 * Designed for the compromise-response runbook:
 *
 *   curl -X POST http://localhost:3000/api/admin/copy/pause \
 *     -H "Authorization: Bearer $CRON_SECRET" \
 *     -H "Content-Type: application/json" \
 *     -d '{"reason":"anomaly alert sign-burst, op=jitery"}'
 *
 * Returns 200 with the new state.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import * as Sentry from "@sentry/nextjs";
import {
  isCopyTradingPaused,
  setCopyTradingPaused,
} from "@/lib/copytrade/kill-switch";

export const dynamic = "force-dynamic";

function authorize(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret}`;
  if (auth.length !== expected.length) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const ok = timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
  if (!ok) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const denied = authorize(req);
  if (denied) return denied;

  const state = await isCopyTradingPaused();
  return NextResponse.json({
    paused: state.paused,
    reason: state.reason,
  });
}

export async function POST(req: NextRequest) {
  const denied = authorize(req);
  if (denied) return denied;

  let body: { reason?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // No body is also fine for the resume case.
  }

  const reason = typeof body.reason === "string" ? body.reason : null;

  await setCopyTradingPaused(true, reason, "api:/api/admin/copy/pause");

  Sentry.captureMessage(`[admin] copy trading PAUSED`, {
    level: "warning",
    tags: { component: "copy-engine", event: "kill-switch-flipped" },
    extra: { reason },
  });

  return NextResponse.json({ paused: true, reason });
}
