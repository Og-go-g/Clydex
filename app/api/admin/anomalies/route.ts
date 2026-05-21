/**
 * GET /api/admin/anomalies — recent anomaly_alerts rows for the
 * on-call operator dashboard / debug.
 *
 * Auth: Bearer CRON_SECRET (same pattern as /api/admin/copy/pause).
 *
 * Query params:
 *   ?since=<ISO timestamp>  — default: 24h ago
 *   ?limit=<int>            — default 100, max 500
 *   ?kind=<string>          — optional filter on alert kind
 *
 * Response:
 *   { alerts: [{ id, kind, scope_key, severity, message, details,
 *                window_minute, detected_at }, ...] }
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { query } from "@/lib/db-history";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

interface AlertRow extends Record<string, unknown> {
  id: number;
  kind: string;
  scope_key: string;
  severity: string;
  message: string;
  details: Record<string, unknown>;
  window_minute: Date;
  detected_at: Date;
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret}`;
  if (
    auth.length !== expected.length ||
    !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since");
  const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (Number.isNaN(since.getTime())) {
    return NextResponse.json({ error: "Invalid since timestamp" }, { status: 400 });
  }

  const limitRaw = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Math.min(
    MAX_LIMIT,
    Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT,
  );

  const kind = url.searchParams.get("kind");

  try {
    const rows = kind
      ? await query<AlertRow>(
          `SELECT id, kind, scope_key, severity, message, details,
                  window_minute, detected_at
           FROM anomaly_alerts
           WHERE detected_at >= $1 AND kind = $2
           ORDER BY detected_at DESC
           LIMIT $3`,
          [since, kind, limit],
        )
      : await query<AlertRow>(
          `SELECT id, kind, scope_key, severity, message, details,
                  window_minute, detected_at
           FROM anomaly_alerts
           WHERE detected_at >= $1
           ORDER BY detected_at DESC
           LIMIT $2`,
          [since, limit],
        );

    return NextResponse.json({
      alerts: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        scopeKey: r.scope_key,
        severity: r.severity,
        message: r.message,
        details: r.details,
        windowMinute: r.window_minute.toISOString(),
        detectedAt: r.detected_at.toISOString(),
      })),
      since: since.toISOString(),
      count: rows.length,
    });
  } catch (err) {
    console.error("[/api/admin/anomalies] error:", err);
    return NextResponse.json(
      { error: "Failed to fetch anomalies" },
      { status: 500 },
    );
  }
}
