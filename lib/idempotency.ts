/**
 * Idempotency-key store for write APIs (currently /api/order).
 *
 * Given the same key + same response, a network retry must return the
 * stored response instead of re-executing the side-effectful operation.
 * TTL is 5 minutes — long enough to cover any reasonable retry, short
 * enough that the table stays small.
 *
 * Postgres primary, in-memory last-resort fallback (for PG outage). On a
 * single-container deployment the in-memory path is single-process and
 * therefore correct; we keep it so an `/api/order` flow during a brief PG
 * blip doesn't double-execute the order.
 *
 * Atomicity for store: `INSERT ... ON CONFLICT (key) DO NOTHING` — the
 * first writer wins, retries see the same row.
 *
 * Cleanup: setInterval every 5 minutes prunes expired rows. Lazy-started
 * on first use so test harnesses that import this module don't leak a
 * timer.
 */

import { prisma } from "./db";

const TTL_S = 300; // 5 minutes

/* ─── In-memory fallback ─── */

const memMap = new Map<string, { result: unknown; createdAt: number }>();
const MAX_MEM = 500;

function memCleanup(): void {
  const now = Date.now();
  for (const [k, v] of memMap) {
    if (now - v.createdAt > TTL_S * 1000) memMap.delete(k);
  }
  while (memMap.size >= MAX_MEM) {
    const oldest = memMap.keys().next().value;
    if (oldest) memMap.delete(oldest);
    else break;
  }
}

/* ─── PG warn throttle ─── */

let lastPgWarnAt = 0;
const PG_WARN_INTERVAL_MS = 60_000;

function warn(label: string, err: unknown): void {
  const now = Date.now();
  if (now - lastPgWarnAt > PG_WARN_INTERVAL_MS) {
    lastPgWarnAt = now;
    console.warn(
      `[idempotency] ${label} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/* ─── Background cleanup ─── */

const CLEANUP_INTERVAL_MS = 5 * 60_000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanupTimer(): void {
  if (cleanupTimer || typeof setInterval === "undefined") return;
  cleanupTimer = setInterval(() => {
    void prisma
      .$executeRaw`DELETE FROM idempotency_keys WHERE expires_at < NOW();`
      .catch((err: unknown) => warn("periodic cleanup", err));
  }, CLEANUP_INTERVAL_MS);
  if (typeof cleanupTimer === "object" && cleanupTimer && "unref" in cleanupTimer) {
    (cleanupTimer as unknown as { unref: () => void }).unref();
  }
}

/* ─── Public API ─── */

/** Look up a previously stored idempotent result. Null if absent/expired. */
export async function checkIdempotency(key: string): Promise<unknown | null> {
  ensureCleanupTimer();
  try {
    const rows = await prisma.$queryRaw<{ result: unknown }[]>`
      SELECT result
      FROM idempotency_keys
      WHERE key = ${key}
        AND expires_at > NOW()
      LIMIT 1;
    `;
    if (rows.length > 0) return rows[0].result;
  } catch (err) {
    warn("checkIdempotency", err);
  }

  const entry = memMap.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_S * 1000) {
    memMap.delete(key);
    return null;
  }
  return entry.result;
}

/** Store an idempotent result. First writer wins; retries no-op. */
export async function storeIdempotency(
  key: string,
  result: unknown,
): Promise<void> {
  ensureCleanupTimer();
  try {
    await prisma.$executeRaw`
      INSERT INTO idempotency_keys (key, result, expires_at)
      VALUES (
        ${key},
        ${result as object}::jsonb,
        NOW() + (${TTL_S}::int * INTERVAL '1 second')
      )
      ON CONFLICT (key) DO NOTHING;
    `;
    return;
  } catch (err) {
    warn("storeIdempotency", err);
  }

  memCleanup();
  memMap.set(key, { result, createdAt: Date.now() });
}
