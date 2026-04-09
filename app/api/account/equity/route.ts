import { NextRequest, NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { getCachedAccountId } from "@/lib/n1/account-cache";
import { getAccount } from "@/lib/n1/client";
import { query } from "@/lib/db-history";
import {
  fetchRecentTrades,
  fetchRecentPnl,
} from "@/lib/history/realtime";

/**
 * GET /api/account/equity — equity curve (balance over time).
 *
 * Strategy:
 * 1. Try DB first (deposit/withdrawal/pnl history)
 * 2. If DB empty — fetch from 01 API directly (last 7 days)
 * 3. Always add current live balance as the last point
 *
 * Query params:
 *   period: "7d" | "30d" | "90d" | "all" (default: "30d")
 */

type Period = "7d" | "30d" | "90d" | "all";

function periodToInterval(period: Period): string | null {
  if (period === "7d") return "7 days";
  if (period === "30d") return "30 days";
  if (period === "90d") return "90 days";
  return null;
}

interface EquityPoint {
  time: number;
  balance: number;
}

export async function GET(req: NextRequest) {
  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const periodRaw = req.nextUrl.searchParams.get("period") ?? "30d";
  const period: Period = (["7d", "30d", "90d", "all"] as const).includes(periodRaw as Period)
    ? (periodRaw as Period)
    : "30d";

  try {
    // Get current live balance from 01 Exchange
    const accountId = await getCachedAccountId(address);
    let currentBalance = 0;
    if (accountId !== null) {
      try {
        const account = await getAccount(accountId);
        currentBalance = account?.balances?.[0]?.amount ?? 0;
      } catch { /* use 0 */ }
    }

    // Try DB first
    const points = await getPointsFromDb(address, period);

    if (points.length > 0) {
      // Add current balance as last point
      const now = Math.floor(Date.now() / 1000);
      if (points[points.length - 1].time < now - 60) {
        points.push({ time: now, balance: Math.round(currentBalance * 100) / 100 });
      }
      return NextResponse.json(
        { points },
        { headers: { "Cache-Control": "private, max-age=60" } },
      );
    }

    // DB empty — fetch from API for last 7 days
    if (accountId !== null) {
      const apiPoints = await getPointsFromApi(accountId, address, currentBalance);
      return NextResponse.json(
        { points: apiPoints },
        { headers: { "Cache-Control": "private, max-age=60" } },
      );
    }

    // No account — show single point with current balance
    if (currentBalance > 0) {
      return NextResponse.json({
        points: [{ time: Math.floor(Date.now() / 1000), balance: Math.round(currentBalance * 100) / 100 }],
      });
    }

    return NextResponse.json({ points: [] });
  } catch (error) {
    console.error("[api/account/equity] error:", error);
    return NextResponse.json({ error: "Failed to fetch equity data" }, { status: 500 });
  }
}

// ─── DB-based equity curve ──────────────────────────────────────

async function getPointsFromDb(address: string, period: Period): Promise<EquityPoint[]> {
  const interval = periodToInterval(period);
  const timeFilter = interval ? `AND "time" >= NOW() - INTERVAL '${interval}'` : "";

  const deposits = await query<{ time: Date; balance: string }>(
    `SELECT "time", balance::text FROM deposit_history
     WHERE "walletAddr" = $1 ${timeFilter}`,
    [address],
  );

  const withdrawals = await query<{ time: Date; balance: string }>(
    `SELECT "time", balance::text FROM withdrawal_history
     WHERE "walletAddr" = $1 ${timeFilter}`,
    [address],
  );

  const pnlEvents = await query<{ time: Date; tradingPnl: string; settledFundingPnl: string }>(
    `SELECT "time", "tradingPnl"::text, "settledFundingPnl"::text
     FROM pnl_history
     WHERE "walletAddr" = $1 ${timeFilter}
     ORDER BY "time" ASC`,
    [address],
  );

  const events: Array<{ time: Date; balance?: number; pnlDelta?: number }> = [];

  for (const d of deposits) {
    events.push({ time: new Date(d.time), balance: parseFloat(d.balance) || 0 });
  }
  for (const w of withdrawals) {
    events.push({ time: new Date(w.time), balance: parseFloat(w.balance) || 0 });
  }
  for (const p of pnlEvents) {
    const delta = (parseFloat(p.tradingPnl) || 0) + (parseFloat(p.settledFundingPnl) || 0);
    if (Math.abs(delta) > 0.001) {
      events.push({ time: new Date(p.time), pnlDelta: delta });
    }
  }

  events.sort((a, b) => a.time.getTime() - b.time.getTime());
  if (events.length === 0) return [];

  const points: EquityPoint[] = [];
  let bal = 0;
  for (const ev of events) {
    if (ev.balance !== undefined) bal = ev.balance;
    else if (ev.pnlDelta !== undefined) bal += ev.pnlDelta;
    points.push({
      time: Math.floor(ev.time.getTime() / 1000),
      balance: Math.round(bal * 100) / 100,
    });
  }

  // Deduplicate same-second
  const deduped: EquityPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    if (i === points.length - 1 || points[i].time !== points[i + 1].time) {
      deduped.push(points[i]);
    }
  }
  return deduped;
}

// ─── API-based equity curve (fallback when DB is empty) ─────────

async function getPointsFromApi(
  accountId: number,
  walletAddr: string,
  currentBalance: number,
): Promise<EquityPoint[]> {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();

  // Fetch PnL history from API
  const pnlData = await fetchRecentPnl(accountId, walletAddr, since).catch(() => []);

  if (pnlData.length === 0) {
    // No PnL data — just show current balance
    if (currentBalance > 0) {
      return [{ time: Math.floor(Date.now() / 1000), balance: Math.round(currentBalance * 100) / 100 }];
    }
    return [];
  }

  // Sort PnL by time ascending
  const sorted = [...pnlData].sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
  );

  // Work backwards from current balance to reconstruct history
  // currentBalance = startBalance + sum(all PnL deltas)
  // startBalance = currentBalance - sum(all PnL deltas)
  let totalDelta = 0;
  for (const p of sorted) {
    totalDelta += (parseFloat(p.tradingPnl) || 0) + (parseFloat(p.settledFundingPnl) || 0);
  }
  let bal = currentBalance - totalDelta;

  const points: EquityPoint[] = [];
  for (const p of sorted) {
    const delta = (parseFloat(p.tradingPnl) || 0) + (parseFloat(p.settledFundingPnl) || 0);
    bal += delta;
    points.push({
      time: Math.floor(new Date(p.time).getTime() / 1000),
      balance: Math.round(bal * 100) / 100,
    });
  }

  // Add current balance as last point
  const now = Math.floor(Date.now() / 1000);
  if (points.length === 0 || points[points.length - 1].time < now - 60) {
    points.push({ time: now, balance: Math.round(currentBalance * 100) / 100 });
  }

  // Deduplicate
  const deduped: EquityPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    if (i === points.length - 1 || points[i].time !== points[i + 1].time) {
      deduped.push(points[i]);
    }
  }
  return deduped;
}
