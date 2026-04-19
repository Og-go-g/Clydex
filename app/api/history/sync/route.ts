import { NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { getCachedAccountId } from "@/lib/n1/account-cache";
import { syncAllHistory, hasBeenSynced, getLastSyncTime } from "@/lib/history/sync";
import { linkAccountToWallet } from "@/lib/history/link";

const SYNC_COOLDOWN_MS = 60_000; // 60 seconds between syncs per user

/**
 * POST /api/history/sync — incremental sync for authenticated user.
 *
 * 1. Rate-limits: 1 sync per 60 seconds per wallet
 * 2. Links bulk-synced data (account:ID → wallet address) if needed
 * 3. Fetches new data since last cursor (typically ≤1 week)
 * 4. Returns sync results
 */
export async function POST() {
  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const accountId = await getCachedAccountId(address);
  if (accountId === null) {
    return NextResponse.json({
      error: "No 01 Exchange account found",
    }, { status: 404 });
  }

  // Rate limit: reject if last sync was < 60s ago
  const lastSync = await getLastSyncTime(address);
  const now = Date.now();
  const elapsed = lastSync ? now - lastSync.getTime() : Infinity;
  if (lastSync && elapsed >= 0 && elapsed < SYNC_COOLDOWN_MS) {
    const retryAfter = Math.ceil((SYNC_COOLDOWN_MS - elapsed) / 1000);
    return NextResponse.json(
      { error: "Sync throttled", retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  try {
    // Link bulk-synced data to real wallet address
    await linkAccountToWallet(accountId, address);

    // Incremental sync — only fetches since last cursor.
    // includeOrders:true because this is the authenticated user looking at
    // their own History modal — one account's orders is cheap.
    // Bulk / leaderboard paths keep the default (orders excluded).
    const results = await syncAllHistory(accountId, address, undefined, undefined, {
      includeOrders: true,
    });
    return NextResponse.json({ results });
  } catch (error) {
    console.error("[api/history/sync] error:", error);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}

/**
 * GET /api/history/sync — check sync status for authenticated user.
 * Checks both wallet address and account:ID keys.
 */
export async function GET() {
  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const accountId = await getCachedAccountId(address);
    const accountKey = accountId !== null ? `account:${accountId}` : null;

    // Check if synced under wallet address OR account:ID
    const syncedByWallet = await hasBeenSynced(address);
    const syncedByAccount = accountKey ? await hasBeenSynced(accountKey) : false;

    const lastSyncWallet = await getLastSyncTime(address);
    const lastSyncAccount = accountKey ? await getLastSyncTime(accountKey) : null;

    const lastSync = lastSyncWallet && lastSyncAccount
      ? (lastSyncWallet > lastSyncAccount ? lastSyncWallet : lastSyncAccount)
      : lastSyncWallet ?? lastSyncAccount;

    return NextResponse.json({
      synced: syncedByWallet || syncedByAccount,
      lastSyncAt: lastSync?.toISOString() ?? null,
    });
  } catch (error) {
    console.error("[api/history/sync] status error:", error);
    return NextResponse.json({ error: "Failed to check sync status" }, { status: 500 });
  }
}
