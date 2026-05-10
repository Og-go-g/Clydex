import { NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { historyPool } from "@/lib/db-history";
import { safeRateLimit } from "@/lib/ratelimit";

/**
 * POST /api/track/account-interaction — wakes up the dormant Tier-2
 * leaderboard refresh by populating `account_interactions`.
 *
 * Tier-2's selector is `account_interactions WHERE at >= NOW() - 7d`. The
 * UI never wrote to it, so the hourly tier-2 cron has fired into the void
 * since 2026-04-18 deploy. This endpoint is the writer.
 *
 * Design choices:
 *
 *   - **Never break the caller.** Auth-less, malformed, self-tracking, or
 *     unresolved-account requests all return `200 { ok: true, … }` with a
 *     reason flag. The frontend fires this fire-and-forget; a 400/500 here
 *     would log noise without changing user-visible behaviour.
 *
 *   - **Server-side dedup, 1/hour per (user, target, kind).** Reuses the
 *     Postgres rate-limiter from Phase 8a — atomic ON CONFLICT counter,
 *     same infra as `/api/order` etc., zero new tables. Dedup avoids
 *     spamming the table when a user refreshes a profile repeatedly.
 *
 *   - **Skip placeholder wallets** (`account:N`) — the tier-2 selector
 *     already filters them out with `walletAddr NOT LIKE 'account:%'`,
 *     so writing them would be wasted I/O.
 *
 *   - **Skip self-tracking.** A user viewing their own portfolio
 *     shouldn't artificially inflate tier-2 with their own account.
 *
 *   - **Resolve accountId server-side from `pnl_totals`.** Client only
 *     needs to pass the wallet it already has from the profile fetch.
 */

export const dynamic = "force-dynamic";

const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const VALID_KINDS = new Set(["view", "search", "follow"]);
const RATE_WINDOW_MS = 60 * 60 * 1000;

interface Body {
  walletAddr?: unknown;
  kind?: unknown;
}

export async function POST(req: Request) {
  const userAddr = await getAuthAddress();
  if (!userAddr) {
    return NextResponse.json({ ok: true, anonymous: true });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: true, invalid: "json" });
  }

  const { walletAddr, kind } = body;
  if (typeof kind !== "string" || !VALID_KINDS.has(kind)) {
    return NextResponse.json({ ok: true, invalid: "kind" });
  }
  if (typeof walletAddr !== "string") {
    return NextResponse.json({ ok: true, invalid: "wallet" });
  }
  if (walletAddr.startsWith("account:")) {
    return NextResponse.json({ ok: true, skipped: "placeholder" });
  }
  if (!SOLANA_ADDR_RE.test(walletAddr)) {
    return NextResponse.json({ ok: true, invalid: "wallet" });
  }
  if (walletAddr === userAddr) {
    return NextResponse.json({ ok: true, skipped: "self" });
  }

  const { success } = await safeRateLimit(
    userAddr,
    `interaction:${kind}:${walletAddr}:`,
    1,
    RATE_WINDOW_MS,
  );
  if (!success) {
    return NextResponse.json({ ok: true, deduped: true });
  }

  let accountId: number;
  try {
    const { rows } = await historyPool.query<{ accountId: number }>(
      `SELECT "accountId" FROM pnl_totals WHERE "walletAddr" = $1 LIMIT 1`,
      [walletAddr],
    );
    if (rows.length === 0) {
      return NextResponse.json({ ok: true, skipped: "unknown_account" });
    }
    accountId = rows[0].accountId;
  } catch (err) {
    console.error("[track/account-interaction] resolve failed:", err);
    return NextResponse.json({ ok: true, error: "resolve" });
  }

  try {
    await historyPool.query(
      `INSERT INTO account_interactions ("accountId", "walletAddr", kind, "userId")
       VALUES ($1, $2, $3, $4)`,
      [accountId, walletAddr, kind, userAddr],
    );
  } catch (err) {
    console.error("[track/account-interaction] insert failed:", err);
    return NextResponse.json({ ok: true, error: "insert" });
  }

  return NextResponse.json({ ok: true });
}
