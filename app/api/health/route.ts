/**
 * /api/health — DB-aware liveness check for Docker / external monitoring.
 *
 * Why this exists: pre-2026-05-03 the docker healthcheck only hit
 * `http://127.0.0.1:3000/` — Next.js's marketing page renders without
 * touching the DB, so a totally dead Postgres still showed `(healthy)`.
 * On 2026-04-19 that mistake caused a SIX-DAY silent outage where users
 * saw broken history while every container reported green.
 *
 * Now the check pings BOTH pools the app actually depends on:
 *   - main DB        (Prisma over pg) — auth, sessions, rate limiter, copy
 *   - history DB     (raw pg pool, TimescaleDB) — trades, leaderboard
 *
 * Returns 200 with per-pool timings on success; 503 with per-pool error
 * detail on failure. Cache-Control: no-store so intermediaries never
 * memoize a healthy response past a real outage.
 *
 * Exempt from middleware (rate-limit + CSRF) — see proxy.ts. This
 * lets docker hammer it every 30s without burning the rate-limit bucket
 * shared with real /api/* traffic.
 *
 * Designed to be cheap: two `SELECT 1` round-trips, total ~5–20 ms on
 * a healthy box. Safe to call from external uptime monitors.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { historyPool } from "@/lib/db-history";

// Always run on every request — never cache.
export const dynamic = "force-dynamic";

interface PoolStatus {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

interface HealthResponse {
  ok: boolean;
  main: PoolStatus;
  history: PoolStatus;
  durationMs: number;
}

async function pingMain(): Promise<PoolStatus> {
  const t0 = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function pingHistory(): Promise<PoolStatus> {
  const t0 = Date.now();
  try {
    await historyPool.query("SELECT 1");
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function GET() {
  const t0 = Date.now();

  // Run both pings in parallel so a slow pool doesn't gate the other.
  const [main, history] = await Promise.all([pingMain(), pingHistory()]);

  const body: HealthResponse = {
    ok: main.ok && history.ok,
    main,
    history,
    durationMs: Date.now() - t0,
  };

  return NextResponse.json(body, {
    status: body.ok ? 200 : 503,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}
