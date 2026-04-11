import { NextRequest, NextResponse } from "next/server";
import { runCopyEngine } from "@/lib/copy/engine";
import { timingSafeEqual } from "crypto";

/**
 * GET /api/copy/engine
 * Copy trading engine cron endpoint.
 * Protected by CRON_SECRET bearer token.
 *
 * Run every 15 seconds via pm2 cron or external scheduler:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://clydex.io/api/copy/engine
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
