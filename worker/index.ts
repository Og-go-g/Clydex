/**
 * Worker entry point — long-running process for background jobs.
 *
 * Runs in a separate Docker container (network_mode: host).
 * Shares .env with the Next.js app — same HISTORY_DATABASE_URL, DATABASE_URL, SYNC_PROXIES.
 *
 * Lifecycle:
 * - Start: migrate check → boot pg-boss → register handlers → register schedules → heartbeat loop
 * - Shutdown on SIGINT/SIGTERM: pg-boss graceful stop (up to 30s for in-flight jobs)
 * - Crash: Docker restart: unless-stopped brings it back; healthcheck kills stuck worker
 */

import "dotenv/config";
import * as fs from "fs";
import * as os from "os";
import { getBoss, stopBoss } from "@/lib/queue/client";
import { registerHandlers } from "@/lib/queue/handlers";
import { registerSchedules } from "@/lib/queue/schedules";
import { query, execute } from "@/lib/db-history";

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEALTHCHECK_FILE = "/tmp/worker.healthy";

async function migrationCheck(): Promise<void> {
  // Fail fast if migration not applied — saves mysterious "table not found" errors later
  await query(`SELECT 1 FROM leaderboard_tiers LIMIT 1`);
  await query(`SELECT 1 FROM account_interactions LIMIT 1`);
  await query(`SELECT 1 FROM worker_heartbeat LIMIT 1`);
}

async function heartbeatLoop(): Promise<() => void> {
  const update = async () => {
    try {
      await execute(
        `INSERT INTO worker_heartbeat (id, "lastBeat", pid, host, version)
         VALUES (1, NOW(), $1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET
           "lastBeat" = NOW(),
           pid = EXCLUDED.pid,
           host = EXCLUDED.host,
           version = EXCLUDED.version`,
        [process.pid, os.hostname(), process.version],
      );
      try { fs.writeFileSync(HEALTHCHECK_FILE, "ok"); } catch { /* ignore */ }
    } catch (err) {
      console.error("[worker] heartbeat failed:", err);
    }
  };

  await update();
  const timer = setInterval(update, HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(timer);
}

async function main() {
  console.log(`[worker] starting — pid=${process.pid} host=${os.hostname()} node=${process.version}`);

  await migrationCheck();
  console.log("[worker] DB migrations OK");

  const boss = await getBoss();
  boss.on("error", (err: Error) => {
    console.error("[pg-boss error]", err);
  });

  await registerHandlers(boss);
  await registerSchedules(boss);

  const stopHeartbeat = await heartbeatLoop();
  console.log("[worker] ready — waiting for jobs");

  const shutdown = async (sig: string) => {
    console.log(`[worker] ${sig} received, stopping gracefully (30s timeout)...`);
    stopHeartbeat();
    try {
      try { fs.unlinkSync(HEALTHCHECK_FILE); } catch { /* ignore */ }
      await stopBoss(30_000);
      console.log("[worker] stopped cleanly");
      process.exit(0);
    } catch (err) {
      console.error("[worker] shutdown error:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("uncaughtException", (err) => {
    console.error("[worker] uncaughtException:", err);
    void shutdown("uncaughtException");
  });
}

main().catch((err) => {
  console.error("[worker] fatal error during startup:", err);
  process.exit(1);
});
