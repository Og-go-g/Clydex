/**
 * POST /api/admin/copy/resume — flip the copy-trading kill switch OFF.
 *
 * Auth: same Bearer CRON_SECRET as /api/admin/copy/pause.
 *
 *   curl -X POST http://localhost:3000/api/admin/copy/resume \
 *     -H "Authorization: Bearer $CRON_SECRET" \
 *     -H "Content-Type: application/json" \
 *     -d '{"reason":"incident resolved, op=jitery"}'
 *
 * Time-to-effect: within KILL_SWITCH_TTL_MS (2s) the engine resumes
 * processing followers on the next tick. The resume action does NOT
 * retro-sign any orders that were dropped while paused — those diffs
 * re-detect naturally next cycle (snapshots untouched while paused).
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import * as Sentry from "@sentry/nextjs";
import { setCopyTradingPaused } from "@/lib/copytrade/kill-switch";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret}`;
  if (auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { reason?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // No body is fine.
  }

  const reason = typeof body.reason === "string" ? body.reason : null;
  await setCopyTradingPaused(false, reason, "api:/api/admin/copy/resume");

  Sentry.captureMessage(`[admin] copy trading RESUMED`, {
    level: "info",
    tags: { component: "copy-engine", event: "kill-switch-flipped" },
    extra: { reason },
  });

  return NextResponse.json({ paused: false, reason });
}
