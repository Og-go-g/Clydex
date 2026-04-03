import { Pool, types } from "pg";

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
  return new Pool({
    connectionString: url,
    max: 5,
    ssl: url.includes("localhost") || url.includes("127.0.0.1")
      ? false
      : { rejectUnauthorized: false },
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
