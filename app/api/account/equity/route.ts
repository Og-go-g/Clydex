import { NextRequest, NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { getCachedAccountId } from "@/lib/n1/account-cache";
import { getAccount } from "@/lib/n1/client";
import { N1_MAINNET_URL } from "@/lib/n1/constants";

/**
 * GET /api/account/equity — equity curve (balance over time).
 *
 * Fetches deposit + withdrawal + PnL history directly from 01 API,
 * reconstructs balance timeline, adds current live balance as last point.
 *
 * No DB dependency — works for any connected user immediately.
 *
 * Query params:
 *   period: "7d" | "30d" | "90d" | "all" (default: "30d")
 */

const API = N1_MAINNET_URL;
const PAGE_SIZE = 250;

type Period = "7d" | "30d" | "90d" | "all";

interface EquityPoint {
  time: number; // unix seconds
  balance: number;
}

function periodToMs(period: Period): number {
  if (period === "7d") return 7 * 86400_000;
  if (period === "30d") return 30 * 86400_000;
  if (period === "90d") return 90 * 86400_000;
  return 0; // all
}

// Fetch paginated data from 01 API
async function fetchAll<T>(baseUrl: string, since?: string): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  let pages = 0;

  while (pages < 20) {
    let url = baseUrl + (baseUrl.includes("?") ? "&" : "?") + `pageSize=${PAGE_SIZE}`;
    if (since) url += `&since=${encodeURIComponent(since)}`;
    if (cursor) url += `&startInclusive=${encodeURIComponent(cursor)}`;

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) break;

    const body = await res.json();
    const items: T[] = Array.isArray(body)
      ? body
      : (body.items ?? body.data ?? body.results ?? []);
    if (items.length === 0) break;

    all.push(...items);
    cursor = body.nextStartInclusive ?? body.cursor ?? body.nextCursor;
    if (!cursor || items.length < PAGE_SIZE) break;
    pages++;
  }
  return all;
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
    const accountId = await getCachedAccountId(address);
    if (accountId === null) {
      return NextResponse.json({ points: [] });
    }

    // Get current live balance
    let currentBalance = 0;
    try {
      const account = await getAccount(accountId);
      currentBalance = account?.balances?.[0]?.amount ?? 0;
    } catch { /* use 0 */ }

    const since = period !== "all"
      ? new Date(Date.now() - periodToMs(period)).toISOString()
      : undefined;

    // Fetch deposit, withdrawal, PnL history from 01 API in parallel
    interface DepositRaw { time: string; amount: number; balance: number }
    interface WithdrawalRaw { time: string; amount: number; balance: number; fee: number }
    interface PnlRaw { time: string; tradingPnl: number; settledFundingPnl: number }

    const [deposits, withdrawals, pnlHistory] = await Promise.all([
      fetchAll<DepositRaw>(`${API}/account/${accountId}/history/deposit`, since).catch(() => []),
      fetchAll<WithdrawalRaw>(`${API}/account/${accountId}/history/withdrawal`, since).catch(() => []),
      fetchAll<PnlRaw>(`${API}/account/${accountId}/history/pnl`, since).catch(() => []),
    ]);

    // Build timeline events
    const events: Array<{ time: number; balance?: number; pnlDelta?: number }> = [];

    for (const d of deposits) {
      events.push({
        time: Math.floor(new Date(d.time).getTime() / 1000),
        balance: d.balance,
      });
    }
    for (const w of withdrawals) {
      events.push({
        time: Math.floor(new Date(w.time).getTime() / 1000),
        balance: w.balance,
      });
    }
    for (const p of pnlHistory) {
      const delta = (p.tradingPnl ?? 0) + (p.settledFundingPnl ?? 0);
      if (Math.abs(delta) > 0.001) {
        events.push({
          time: Math.floor(new Date(p.time).getTime() / 1000),
          pnlDelta: delta,
        });
      }
    }

    // Sort chronologically
    events.sort((a, b) => a.time - b.time);

    // Build equity curve
    const points: EquityPoint[] = [];

    if (events.length === 0) {
      // No history — show flat line at current balance
      if (currentBalance > 0) {
        const now = Math.floor(Date.now() / 1000);
        const periodSec = periodToMs(period) / 1000 || 30 * 86400;
        points.push({ time: now - periodSec, balance: round(currentBalance) });
        points.push({ time: now, balance: round(currentBalance) });
      }
    } else {
      // Reconstruct: work backwards from current balance
      // currentBalance = startBalance + sum(all PnL deltas) + sum(deposit amounts) - sum(withdrawal amounts)
      // But deposits/withdrawals have balance-after snapshots, so use those as anchors.

      let bal = 0;
      for (const ev of events) {
        if (ev.balance !== undefined) {
          bal = ev.balance;
        } else if (ev.pnlDelta !== undefined) {
          bal += ev.pnlDelta;
        }
        points.push({ time: ev.time, balance: round(bal) });
      }

      // Add current balance as last point
      const now = Math.floor(Date.now() / 1000);
      if (points[points.length - 1].time < now - 30) {
        points.push({ time: now, balance: round(currentBalance) });
      }
    }

    // Deduplicate same-second (keep last)
    const deduped: EquityPoint[] = [];
    for (let i = 0; i < points.length; i++) {
      if (i === points.length - 1 || points[i].time !== points[i + 1].time) {
        deduped.push(points[i]);
      }
    }

    return NextResponse.json(
      { points: deduped },
      { headers: { "Cache-Control": "private, max-age=30" } },
    );
  } catch (error) {
    console.error("[api/account/equity] error:", error);
    return NextResponse.json({ error: "Failed to fetch equity data" }, { status: 500 });
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
