import { NextRequest, NextResponse } from "next/server";
import { runCopyEngine } from "@/lib/copy/engine";
import { timingSafeEqual } from "crypto";

/**
 * GET /api/copy/engine — manual trigger for the copy trading engine.
 *
 * As of 2026-04-19 the engine runs inside the pg-boss worker on the
 * `copy-engine-tick` cron (every minute × 4 cycles → ~15s cadence).
 * See lib/queue/schedules.ts + lib/queue/handlers/copy-engine-tick.ts.
 *
 * This endpoint is KEPT for:
 *   - manual trigger from the admin dashboard / debugging
 *   - backward-compat with any external scheduler still pointed here
 * Use the CRON_SECRET bearer token if you still rely on it:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://clydex.io/api/copy/engine
 *
 * If pg-boss is up, prefer removing the external cron entirely —
 * duplicate invocations are harmless (engineRunning lock drops them) but
 * noisy in logs.
 */
export async function GET(request: NextRequest) {
  // Auth check
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret}`;

  // Timing-safe comparison to prevent timing attacks
  let valid = false;
  try {
    const a = Buffer.from(auth);
    const b = Buffer.from(expected);
    valid = a.length === b.length && timingSafeEqual(a, b);
  } catch {
    valid = false;
  }

  if (!valid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runCopyEngine();

    console.log(
      `[copy-engine] leaders=${result.leadersProcessed} diffs=${result.diffsDetected} ` +
      `placed=${result.ordersPlaced} failed=${result.ordersFailed} ` +
      `duration=${result.durationMs}ms` +
      (result.errors.length > 0 ? ` errors=${result.errors.length}` : ""),
    );

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("[copy-engine] fatal:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Engine failed" },
      { status: 500 },
    );
  }
}
