import { Pool, types } from "pg";
import { randomUUID } from "crypto";

/** Generate a UUID — works in all Node.js versions */
export function uuid(): string {
  return randomUUID();
}

// Force pg to parse `timestamp without time zone` (OID 1114) as UTC.
// Prisma creates DateTime columns without timezone, but all our data is UTC.
// Without this, pg interprets stored values using the server's local timezone,
// which shifts times when the server is not in UTC.
types.setTypeParser(1114, (str: string) => new Date(str + "Z"));

/**
 * PostgreSQL connection pool for the history database (TimescaleDB).
 * Replaces Prisma — direct SQL for time-series data.
 */
function createPool(): Pool {
  const url = process.env.HISTORY_DATABASE_URL;
  if (!url) throw new Error("HISTORY_DATABASE_URL environment variable is not set");
  // SSL: off by default (self-hosted). Enable via ?sslmode=require in URL or DB_SSL=true env.
  const wantsSsl = url.includes("sslmode=require") || process.env.DB_SSL === "true";
  return new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: wantsSsl ? { rejectUnauthorized: true } : false,
  });
}

const KEY = Symbol.for("clydex.history-pool.v1");
const store = globalThis as unknown as Record<symbol, Pool | undefined>;

if (!store[KEY]) {
  store[KEY] = createPool();
}

export const historyPool: Pool = store[KEY]!;

/** Convenience: run a parameterized query. */
export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await historyPool.query(text, params);
  return result.rows as T[];
}

/** Convenience: run a query and return row count. */
export async function execute(text: string, params?: unknown[]): Promise<number> {
  const result = await historyPool.query(text, params);
  return result.rowCount ?? 0;
}

/**
 * Acquire a Postgres session-scoped advisory lock and pin the dedicated
 * client until release. Returns `null` immediately if the lock is held
 * by another session. Returns a release callback otherwise; the caller
 * MUST invoke it (typically in a finally block) or the lock leaks until
 * the connection idle-times out or the server restarts.
 *
 * Why a dedicated client: `historyPool.query()` checks out a different
 * connection on every call, so a lock acquired on one query is invisible
 * to a release issued via another. The advisory-lock semantics in
 * Postgres are bound to the SESSION, not to the SQL text — so the same
 * client must hold the connection for the whole window of mutual
 * exclusion.
 */
export async function acquireAdvisoryLock(
  key: number,
): Promise<(() => Promise<void>) | null> {
  const client = await historyPool.connect();
  try {
    const r = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock($1) AS locked`,
      [key],
    );
    if (!r.rows[0]?.locked) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release();
    throw err;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query(`SELECT pg_advisory_unlock($1)`, [key]);
    } catch (err) {
      console.warn("[db-history] advisory unlock failed:", err);
    } finally {
      client.release();
    }
  };
}

// ─── snake_case → camelCase row mapper ────────────────────────────

const SNAKE_RE = /_([a-z])/g;

export function toCamel<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) {
    const camel = key.replace(SNAKE_RE, (_, c: string) => c.toUpperCase());
    out[camel] = val;
  }
  return out as T;
}

export function toCamelRows<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map((r) => toCamel<T>(r));
}
