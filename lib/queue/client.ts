/**
 * pg-boss singleton client.
 *
 * Stores jobs in history DB under `pgboss` schema (created automatically).
 * Shared between worker and Next.js app (for enqueue from API routes).
 *
 * pg-boss v12 requires explicit createQueue() before send()/work() for each queue name.
 */

import { PgBoss } from "pg-boss";
import { JOB } from "./job-names";

const KEY = Symbol.for("clydex.pgboss.v1");
const store = globalThis as unknown as Record<symbol, PgBoss | undefined>;

let startPromise: Promise<PgBoss> | null = null;

function createBoss(): PgBoss {
  const connectionString = process.env.HISTORY_DATABASE_URL;
  if (!connectionString) {
    throw new Error("HISTORY_DATABASE_URL is required for pg-boss");
  }
  return new PgBoss({
    connectionString,
    schema: "pgboss",
  });
}

async function ensureQueues(boss: PgBoss): Promise<void> {
  // Default per-queue options — retries + expiry + retention
  const commonOpts = {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 60 * 60, // 1 hour hard cap
    deleteAfterSeconds: 7 * 24 * 3600, // 7 days
    retentionSeconds: 14 * 24 * 3600, // 14 days in created/retry state
  };
  const queueNames = Object.values(JOB);
  for (const name of queueNames) {
    try {
      await boss.createQueue(name, commonOpts);
    } catch (err) {
      // Ignore "already exists" errors — pg-boss v12 throws if queue exists
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("already exists") && !msg.includes("duplicate")) {
        // Unknown error — rethrow
        throw err;
      }
    }
  }
}

/**
 * Get (and lazily start) the pg-boss instance.
 * Safe to call from multiple places — start() happens once.
 */
export async function getBoss(): Promise<PgBoss> {
  if (store[KEY]) return store[KEY]!;
  if (startPromise) return startPromise;

  startPromise = (async () => {
    const boss = createBoss();
    await boss.start();
    await ensureQueues(boss);
    store[KEY] = boss;
    return boss;
  })();

  return startPromise;
}

/**
 * Stop pg-boss gracefully. Waits for in-flight jobs up to timeout.
 */
export async function stopBoss(timeoutMs = 30_000): Promise<void> {
  if (!store[KEY]) return;
  try {
    await store[KEY]!.stop({ graceful: true, timeout: timeoutMs });
  } finally {
    delete store[KEY];
    startPromise = null;
  }
}
