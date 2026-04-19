/**
 * Wallet resolver — accountId → real Solana pubkey via 01.xyz mainnet backend.
 *
 * Endpoint: GET {N1_MAINNET_URL}/account/{id}/pubkey
 *   200 → bare JSON string, e.g. "HCKzWTFN4iNYSz1uxysTV8RsJ3pc7PTE5kgLUEPFxFoE"
 *   404 → the account id does not exist
 *
 * Results are cached in the `account_pubkey` table — one row per accountId.
 * Callers should prefer `getCachedPubkey()` and only call `resolvePubkey()`
 * from the resolve-wallets job.
 *
 * `propagateWallet()` rewrites all raw/aggregate tables from the placeholder
 * walletAddr 'account:<id>' to the real wallet, using the same delete-twin +
 * update strategy as sql/2026-04-18_consolidate_placeholder_wallets.sql.
 */

import { historyPool, query, execute } from "@/lib/db-history";
import { N1_MAINNET_URL } from "@/lib/n1/constants";
import { retryableFetch, type FetchContext } from "./fetch-context";
import { recomputeAggregates } from "./aggregate";

export interface AccountPubkeyRow {
  accountId: number;
  pubkey: string | null;
  notFound: boolean;
  failedAttempts: number;
  resolvedAt: Date | null;
  lastCheckedAt: Date;
}

/** Fetch cached pubkey row, or null if we've never queried this accountId. */
export async function getCachedPubkey(accountId: number): Promise<AccountPubkeyRow | null> {
  const rows = await query<{
    accountId: number;
    pubkey: string | null;
    notFound: boolean;
    failedAttempts: number;
    resolvedAt: Date | null;
    lastCheckedAt: Date;
  }>(
    `SELECT "accountId", pubkey, "notFound", "failedAttempts", "resolvedAt", "lastCheckedAt"
     FROM account_pubkey WHERE "accountId" = $1`,
    [accountId],
  );
  return rows[0] ?? null;
}

/**
 * Fetch accountId → pubkey from 01.xyz API.
 *   { pubkey: "..." }      — 200, resolved
 *   { pubkey: null, notFound: true }  — 404
 *   throws on 5xx / network errors — caller increments failedAttempts
 */
export async function fetchPubkey(
  accountId: number,
  ctx?: FetchContext,
): Promise<{ pubkey: string | null; notFound: boolean }> {
  const url = `${N1_MAINNET_URL}/account/${accountId}/pubkey`;

  const res = ctx?.agent
    ? await retryableFetch(url, {
        headers: { Accept: "application/json" },
        agent: ctx.agent,
        timeoutMs: 10_000,
        retries: 2,
      })
    : await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });

  if (res.status === 404) return { pubkey: null, notFound: true };
  if (!res.ok) throw new Error(`pubkey API ${res.status} for accountId=${accountId}`);

  const body = await res.json();
  // 01 Exchange returns a bare JSON string. Guard against unexpected shapes.
  const pubkey = typeof body === "string"
    ? body
    : typeof body?.pubkey === "string"
      ? body.pubkey
      : null;

  if (!pubkey) throw new Error(`malformed pubkey response for accountId=${accountId}: ${JSON.stringify(body)}`);
  return { pubkey, notFound: false };
}

/**
 * Upsert a resolved row. Called from the resolver job after a successful fetch.
 */
export async function recordResolved(accountId: number, pubkey: string): Promise<void> {
  await execute(
    `INSERT INTO account_pubkey ("accountId", pubkey, "notFound", "failedAttempts", "resolvedAt", "lastCheckedAt")
     VALUES ($1, $2, FALSE, 0, NOW(), NOW())
     ON CONFLICT ("accountId") DO UPDATE SET
       pubkey = EXCLUDED.pubkey,
       "notFound" = FALSE,
       "failedAttempts" = 0,
       "resolvedAt" = NOW(),
       "lastCheckedAt" = NOW()`,
    [accountId, pubkey],
  );
}

/**
 * Mark accountId as 404 (account does not exist upstream).
 * Retried after 24h by the orchestrator — cheap to revisit, rarely flips back.
 */
export async function recordNotFound(accountId: number): Promise<void> {
  await execute(
    `INSERT INTO account_pubkey ("accountId", pubkey, "notFound", "failedAttempts", "lastCheckedAt")
     VALUES ($1, NULL, TRUE, 0, NOW())
     ON CONFLICT ("accountId") DO UPDATE SET
       "notFound" = TRUE,
       "failedAttempts" = account_pubkey."failedAttempts" + 1,
       "lastCheckedAt" = NOW()`,
    [accountId],
  );
}

/** Mark a transient failure. Keeps pubkey/notFound if already set. */
export async function recordFailure(accountId: number): Promise<void> {
  await execute(
    `INSERT INTO account_pubkey ("accountId", "failedAttempts", "lastCheckedAt")
     VALUES ($1, 1, NOW())
     ON CONFLICT ("accountId") DO UPDATE SET
       "failedAttempts" = account_pubkey."failedAttempts" + 1,
       "lastCheckedAt" = NOW()`,
    [accountId],
  );
}

/**
 * Propagate a newly resolved wallet across all history tables.
 *
 * Rewrites rows currently stored under `account:<id>` placeholder to the real
 * wallet. Uses the same delete-twin + update strategy as the one-off
 * consolidation migration, but scoped to a single accountId.
 *
 * Tables with unique constraint that includes walletAddr: delete rows where
 * a real-wallet twin exists, then update the remaining placeholder rows.
 * Tables unique on (accountId, ...) or on tradeId/orderId: plain UPDATE.
 */
export async function propagateWallet(accountId: number, realWallet: string): Promise<{
  tablesUpdated: Record<string, number>;
  tablesCleaned: Record<string, number>;
}> {
  const placeholder = `account:${accountId}`;
  const updated: Record<string, number> = {};
  const cleaned: Record<string, number> = {};

  const client = await historyPool.connect();
  try {
    await client.query("BEGIN");

    // 1. Tables unique on (accountId, marketId, time) — no twin possible.
    for (const t of ["pnl_history", "funding_history"]) {
      const r = await client.query(
        `UPDATE ${t} SET "walletAddr" = $1
         WHERE "accountId" = $2 AND "walletAddr" = $3`,
        [realWallet, accountId, placeholder],
      );
      updated[t] = r.rowCount ?? 0;
    }

    // 2. trade_history — unique on (tradeId, time), no twin risk on walletAddr.
    // order_history was removed on 2026-04-19.
    {
      const r = await client.query(
        `UPDATE trade_history SET "walletAddr" = $1
         WHERE "accountId" = $2 AND "walletAddr" = $3`,
        [realWallet, accountId, placeholder],
      );
      updated.trade_history = r.rowCount ?? 0;
    }

    // 3. deposit_history / withdrawal_history — unique on (walletAddr, time, amount).
    //    A real-wallet twin CAN coexist if the account was ever synced under
    //    its real wallet after linking. Delete placeholder twins first.
    for (const t of ["deposit_history", "withdrawal_history"]) {
      const d = await client.query(
        `DELETE FROM ${t} p
         USING ${t} r
         WHERE p."walletAddr" = $1 AND p."accountId" = $2
           AND r."accountId" = p."accountId"
           AND r."time"      = p."time"
           AND r."amount"    = p."amount"
           AND r."walletAddr" = $3`,
        [placeholder, accountId, realWallet],
      );
      cleaned[t] = d.rowCount ?? 0;

      const u = await client.query(
        `UPDATE ${t} SET "walletAddr" = $1
         WHERE "accountId" = $2 AND "walletAddr" = $3`,
        [realWallet, accountId, placeholder],
      );
      updated[t] = u.rowCount ?? 0;
    }

    // 4. liquidation_history — unique on (walletAddr, time, fee).
    {
      const d = await client.query(
        `DELETE FROM liquidation_history p
         USING liquidation_history r
         WHERE p."walletAddr" = $1 AND p."accountId" = $2
           AND r."accountId" = p."accountId"
           AND r."time"      = p."time"
           AND r."fee"       = p."fee"
           AND r."walletAddr" = $3`,
        [placeholder, accountId, realWallet],
      );
      cleaned.liquidation_history = d.rowCount ?? 0;

      const u = await client.query(
        `UPDATE liquidation_history SET "walletAddr" = $1
         WHERE "accountId" = $2 AND "walletAddr" = $3`,
        [realWallet, accountId, placeholder],
      );
      updated.liquidation_history = u.rowCount ?? 0;
    }

    // 5. pnl_totals — walletAddr is unique. Drop placeholder if real twin exists.
    {
      const d = await client.query(
        `DELETE FROM pnl_totals p
         USING pnl_totals r
         WHERE p."walletAddr" = $1 AND p."accountId" = $2
           AND r."accountId" = p."accountId"
           AND r."walletAddr" = $3`,
        [placeholder, accountId, realWallet],
      );
      cleaned.pnl_totals = d.rowCount ?? 0;

      const u = await client.query(
        `UPDATE pnl_totals SET "walletAddr" = $1
         WHERE "accountId" = $2 AND "walletAddr" = $3`,
        [realWallet, accountId, placeholder],
      );
      updated.pnl_totals = u.rowCount ?? 0;
    }

    // 6. volume_calendar — unique on (walletAddr, date).
    {
      const d = await client.query(
        `DELETE FROM volume_calendar p
         USING volume_calendar r
         WHERE p."walletAddr" = $1 AND p."accountId" = $2
           AND r."accountId" = p."accountId"
           AND r."date"       = p."date"
           AND r."walletAddr" = $3`,
        [placeholder, accountId, realWallet],
      );
      cleaned.volume_calendar = d.rowCount ?? 0;

      const u = await client.query(
        `UPDATE volume_calendar SET "walletAddr" = $1
         WHERE "accountId" = $2 AND "walletAddr" = $3`,
        [realWallet, accountId, placeholder],
      );
      updated.volume_calendar = u.rowCount ?? 0;
    }

    // 7. sync_cursors — placeholder entries are dead weight after schema fix
    //    (cursors are keyed by accountId now). Drop them.
    {
      const d = await client.query(
        `DELETE FROM sync_cursors WHERE "walletAddr" = $1`,
        [placeholder],
      );
      cleaned.sync_cursors = d.rowCount ?? 0;
    }

    // 8. leaderboard_tiers — walletAddr is not part of the key, just refresh it.
    {
      const u = await client.query(
        `UPDATE leaderboard_tiers SET "walletAddr" = $1
         WHERE "accountId" = $2 AND "walletAddr" = $3`,
        [realWallet, accountId, placeholder],
      );
      updated.leaderboard_tiers = u.rowCount ?? 0;
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Rebuild pnl_totals + volume_calendar for this account from raw tables.
  //
  // Propagation moved existing rows from placeholder → real wallet, but it
  // did NOT create pnl_totals rows for accounts that had raw history under
  // 'account:<id>' yet never had pnl_totals materialized (common for
  // bulk-synced accounts that never went through the tier pipeline). Without
  // this, Tier-4 selector can't see them (selector reads from pnl_totals),
  // so they stay invisible in the leaderboard forever.
  //
  // recomputeAggregates is idempotent — re-running for already-fresh totals
  // just overwrites with the same numbers.
  try {
    await recomputeAggregates(accountId, realWallet);
  } catch (err) {
    // Don't fail the whole propagation if aggregate recompute bombs —
    // the UPDATEs above are the critical path. Tier-4 will pick it up later.
    console.warn(`[propagateWallet] aggregate recompute failed for ${accountId}:`, err);
  }

  return { tablesUpdated: updated, tablesCleaned: cleaned };
}

/**
 * How many accounts does 01.xyz know about right now?
 * Used by the orchestrator to discover newly created profiles.
 */
export async function fetchAccountsCount(ctx?: FetchContext): Promise<number> {
  const url = `${N1_MAINNET_URL}/accounts/count`;
  const res = ctx?.agent
    ? await retryableFetch(url, {
        headers: { Accept: "application/json" },
        agent: ctx.agent,
        timeoutMs: 10_000,
        retries: 2,
      })
    : await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });

  if (!res.ok) throw new Error(`/accounts/count returned ${res.status}`);
  const body = await res.json();
  if (typeof body !== "number" || !Number.isFinite(body)) {
    throw new Error(`/accounts/count returned non-numeric: ${JSON.stringify(body)}`);
  }
  return body;
}
