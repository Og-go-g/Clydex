/**
 * POST /api/admin/alert
 *
 * Receives infrastructure alerts from outside the Node app (e.g. systemd
 * `OnFailure=` hooks running a thin bash forwarder) and re-emits them
 * into Sentry through our existing SDK + DSN. Centralises alert routing
 * so the bash side never needs to know our Sentry DSN, project keys,
 * or envelope format.
 *
 * Designed for the case "Postgres just died and I want to know within
 * seconds, not days". A 6-day silent outage on 2026-04-19 happened
 * specifically because nothing was watching PG's health from outside
 * the app, and the app's docker healthcheck didn't ping the DB.
 * /api/health (added 2026-05-03) covers the docker side; this endpoint
 * + a systemd hook covers the systemd side.
 *
 * Auth: same CRON_SECRET bearer pattern as other admin routes.
 *
 * Body: { source, level?, message, tags?, extra? }
 *   source   — required, e.g. "systemd:postgresql@16-main"
 *   level    — "fatal" (default) | "error" | "warning" | "info"
 *   message  — human-readable summary
 *   tags     — flat string→string map for Sentry filtering
 *   extra    — arbitrary JSON for Sentry's Additional Data panel
 *
 * Returns 202 with the captured event id on success — bash callers
 * don't typically need it, but it's helpful for debugging.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

type AlertLevel = "fatal" | "error" | "warning" | "info";
const VALID_LEVELS: ReadonlySet<AlertLevel> = new Set([
  "fatal",
  "error",
  "warning",
  "info",
]);

interface AlertBody {
  source: string;
  level?: AlertLevel;
  message: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

function checkAuth(request: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured on this server" },
      { status: 500 },
    );
  }

  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret}`;
  const maxLen = Math.max(auth.length, expected.length);
  const authBuf = Buffer.from(auth.padEnd(maxLen));
  const expectedBuf = Buffer.from(expected.padEnd(maxLen));
  if (auth.length !== expected.length || !timingSafeEqual(authBuf, expectedBuf)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

function isValidBody(b: unknown): b is AlertBody {
  if (typeof b !== "object" || b === null) return false;
  const x = b as Record<string, unknown>;
  if (typeof x.source !== "string" || x.source.length === 0) return false;
  if (typeof x.message !== "string" || x.message.length === 0) return false;
  if (x.level !== undefined && !VALID_LEVELS.has(x.level as AlertLevel)) return false;
  if (x.tags !== undefined && (typeof x.tags !== "object" || x.tags === null)) return false;
  if (x.extra !== undefined && (typeof x.extra !== "object" || x.extra === null)) return false;
  return true;
}

export async function POST(request: NextRequest) {
  const authError = checkAuth(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!isValidBody(body)) {
    return NextResponse.json(
      { error: "Body must be { source, message, level?, tags?, extra? }" },
      { status: 400 },
    );
  }

  const level = body.level ?? "fatal";

  // Sentry's captureMessage takes a per-call scope override so we don't
  // pollute the request hub for unrelated errors that may fire later.
  const eventId = Sentry.withScope((scope) => {
    scope.setLevel(level);
    scope.setTag("alert.source", body.source);
    scope.setTag("alert.channel", "systemd-hook");
    if (body.tags) {
      for (const [k, v] of Object.entries(body.tags)) {
        // Sentry tag values must be strings. Coerce defensively.
        scope.setTag(k, String(v));
      }
    }
    if (body.extra) {
      scope.setContext("alert.extra", body.extra);
    }
    return Sentry.captureMessage(body.message, level);
  });

  return NextResponse.json(
    { ok: true, eventId },
    { status: 202, headers: { "Cache-Control": "no-store" } },
  );
}
