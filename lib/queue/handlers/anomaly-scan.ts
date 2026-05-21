/**
 * pg-boss handler for the `anomaly-scan` job (every minute).
 *
 * Runs every rule in lib/copytrade/anomaly-detector.ts, persists each
 * fresh alert, fires Sentry. Designed to be cheap so we can run it
 * frequently — five small SELECT queries against indexed sign_log
 * rows that are anyway hot in the buffer cache.
 *
 * Idempotent by design (dedup unique index on anomaly_alerts), so a
 * job retry never double-alerts. Failures are logged but never
 * back-pressure the scheduler.
 */

import * as Sentry from "@sentry/nextjs";
import { scanForAnomalies, persistAlert } from "@/lib/copytrade/anomaly-detector";

interface Job<T> {
  id: string;
  name: string;
  data: T;
}

export async function handleAnomalyScan(
  _job: Job<Record<string, never>>,
): Promise<void> {
  const t0 = Date.now();
  let detected = 0;
  let inserted = 0;

  try {
    const alerts = await scanForAnomalies();
    detected = alerts.length;

    for (const alert of alerts) {
      const isNew = await persistAlert(alert);
      if (!isNew) continue;
      inserted += 1;

      // Sentry breadcrumb gets the operator pinged. Severity maps
      // 'warning' → 'warning' and 'critical' → 'error' so the
      // dashboard's default filters surface the right ones.
      Sentry.captureMessage(`[anomaly] ${alert.kind}: ${alert.message}`, {
        level: alert.severity === "critical" ? "error" : "warning",
        tags: {
          component: "anomaly-detector",
          kind: alert.kind,
          scope: alert.scopeKey.slice(0, 32),
        },
        extra: alert.details,
      });
    }

    if (detected > 0) {
      console.warn(
        `[anomaly-scan] detected=${detected} new=${inserted} duration=${Date.now() - t0}ms`,
      );
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: "anomaly-detector", event: "scan-failed" },
    });
    console.error("[anomaly-scan] failed:", err);
  }
}
