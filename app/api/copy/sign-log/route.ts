/**
 * GET /api/copy/sign-log — return the authenticated user's own
 * slice of the hash-chained sign log.
 *
 * Auth: standard SIWS session (getAuthAddress). Scopes results to
 * `follower_wallet = <session wallet>` so a logged-in user can only
 * see signs that were issued on THEIR behalf.
 *
 * Query params:
 *   ?limit=100   (default 100, max 1000) — newest-first.
 *   ?before=<id> — cursor for pagination back through history.
 *
 * Response:
 *   {
 *     entries: [{
 *       id, action, symbol, side, size, leverage, slippage,
 *       markPrice, policyResult, signedAt, thisHash, prevHash,
 *     }, ...],
 *     chainRoot: <hex of newest this_hash> | null,
 *     hasMore: boolean,
 *   }
 *
 * The user can verify the chain locally by SHA256-ing each row's
 * (prev_hash || serialize(row)) and comparing to this_hash. The
 * `chainRoot` is the latest row's hash and will eventually be
 * pinned to a public bulletin (off-box mirror + Solana memo tx,
 * Week 4 ops work) so even a compromised DB can't silently rewrite
 * what the user already verified.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { query } from "@/lib/db-history";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

interface SignLogRow extends Record<string, unknown> {
  id: number;
  action: string;
  symbol: string;
  side: string;
  size: string;
  leverage: string;
  slippage: string;
  mark_price: string;
  policy_result: string;
  signed_at: Date;
  this_hash: Buffer;
  prev_hash: Buffer;
}

export async function GET(req: NextRequest) {
  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Math.min(
    MAX_LIMIT,
    Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT,
  );
  const beforeRaw = parseInt(url.searchParams.get("before") ?? "", 10);
  const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;

  try {
    // Fetch limit+1 to detect hasMore without a second query.
    const rows = before === null
      ? await query<SignLogRow>(
          `SELECT id, action, symbol, side, size, leverage, slippage,
                  mark_price, policy_result, signed_at, this_hash, prev_hash
           FROM sign_log
           WHERE follower_wallet = $1
           ORDER BY id DESC
           LIMIT $2`,
          [address, limit + 1],
        )
      : await query<SignLogRow>(
          `SELECT id, action, symbol, side, size, leverage, slippage,
                  mark_price, policy_result, signed_at, this_hash, prev_hash
           FROM sign_log
           WHERE follower_wallet = $1 AND id < $2
           ORDER BY id DESC
           LIMIT $3`,
          [address, before, limit + 1],
        );

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;

    const entries = slice.map((r) => ({
      id: r.id,
      action: r.action,
      symbol: r.symbol,
      side: r.side,
      size: r.size,
      leverage: r.leverage,
      slippage: r.slippage,
      markPrice: r.mark_price,
      policyResult: r.policy_result,
      signedAt: r.signed_at.toISOString(),
      thisHash: r.this_hash.toString("hex"),
      prevHash: r.prev_hash.toString("hex"),
    }));

    // The chainRoot is the latest hash GLOBALLY (across all
    // followers) — that's what the off-box mirror will pin. We
    // expose it here so the user can verify their slice against
    // the global root chain.
    const rootRows = await query<{ this_hash: Buffer }>(
      `SELECT this_hash FROM sign_log ORDER BY id DESC LIMIT 1`,
    );
    const chainRoot = rootRows[0]?.this_hash.toString("hex") ?? null;

    return NextResponse.json({ entries, chainRoot, hasMore });
  } catch (err) {
    console.error("[/api/copy/sign-log] error:", err);
    return NextResponse.json(
      { error: "Failed to fetch sign log" },
      { status: 500 },
    );
  }
}
