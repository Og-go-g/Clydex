import { NextRequest, NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { getCachedAccountId } from "@/lib/n1/account-cache";
import { getAccount } from "@/lib/n1/client";
import { N1_MAINNET_URL } from "@/lib/n1/constants";

/**
 * GET /api/account/equity — equity curve over time.
 *
 * Data sources:
 *   - Deposit/withdrawal history: absolute `balance` snapshots (anchors)
 *   - PnL history: `tradingPnl` only (realized trade PnL).
 *     `settledFundingPnl` is excluded — it creates noise from background settlements.
 *   - Current equity: USDC balance + unrealized PnL from open positions (last point).
 *
 * Query params:
 *   period: "1d" | "3d" | "7d" (default: "7d")
 */

const API = N1_MAINNET_URL;
const PAGE_SIZE = 250;

type Period = "1d" | "3d" | "7d";

interface EquityPoint {
  time: number; // unix seconds
  balance: number;
}

function periodToMs(period: Period): number {
  if (period === "1d") return 1 * 86400_000;
  if (period === "3d") return 3 * 86400_000;
  return 7 * 86400_000; // 7d default
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

  const periodRaw = req.nextUrl.searchParams.get("period") ?? "7d";
  const period: Period = (["1d", "3d", "7d"] as const).includes(periodRaw as Period)
    ? (periodRaw as Period)
    : "7d";

  try {
    const accountId = await getCachedAccountId(address);
    if (accountId === null) {
      return NextResponse.json({ points: [] });
    }

    // Get current live equity = USDC balance + unrealized PnL
    let currentEquity = 0;
    let currentBalance = 0;
    try {
      const account = await getAccount(accountId);
      currentBalance = account?.balances?.[0]?.amount ?? 0;
      // Sum unrealized PnL from open positions
      let unrealizedPnl = 0;
      const positions = account?.positions ?? [];
      for (const pos of positions) {
        if (pos.perp && pos.perp.baseSize !== 0) {
          unrealizedPnl += (pos.perp.sizePricePnl ?? 0) + (pos.perp.fundingPaymentPnl ?? 0);
        }
      }
      currentEquity = currentBalance + unrealizedPnl;
    } catch { /* use 0 */ }

    const since = new Date(Date.now() - periodToMs(period)).toISOString();

    // Fetch deposit, withdrawal, and PnL history in parallel.
    // Deposits/withdrawals have absolute `balance` field (anchors).
    // PnL: only `tradingPnl` is used (realized trade PnL).
    // `settledFundingPnl` is skipped — background settlements create noise.
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
    // Only tradingPnl — skip settledFundingPnl (creates noise)
    for (const p of pnlHistory) {
      const delta = p.tradingPnl ?? 0;
      if (Math.abs(delta) > 0.001) {
        events.push({
          time: Math.floor(new Date(p.time).getTime() / 1000),
          pnlDelta: delta,
        });
      }
    }

    events.sort((a, b) => a.time - b.time);

    const now = Math.floor(Date.now() / 1000);
    const periodSec = periodToMs(period) / 1000;
    const startTime = now - periodSec;
    const step = getStepForPeriod(period);

    // Separate event types
    const hasAnchors = events.some(e => e.balance !== undefined);
    const hasPnl = events.some(e => e.pnlDelta !== undefined);

    // Build equity curve
    const points: EquityPoint[] = [];

    if (!hasAnchors && !hasPnl) {
      // No events — flat line at current equity
      for (let t = startTime; t < now; t += step) {
        points.push({ time: t, balance: round(currentEquity) });
      }
      points.push({ time: now, balance: round(currentEquity) });
    } else {
      // Reconstruct balance backwards from current balance.
      // Total trading PnL delta = sum of all tradingPnl events in period.
      let totalTradingPnl = 0;
      for (const ev of events) {
        if (ev.pnlDelta !== undefined) totalTradingPnl += ev.pnlDelta;
      }

      // Starting balance = current balance - total realized PnL in period
      // (deposits/withdrawals are handled via absolute anchors)
      let startBalance = currentBalance - totalTradingPnl;

      // If we have deposit/withdrawal anchors, use the earliest one as the start reference
      if (hasAnchors) {
        const firstAnchor = events.find(e => e.balance !== undefined)!;
        startBalance = firstAnchor.balance!;
        // Subtract any PnL that happened before this anchor
        for (const ev of events) {
          if (ev.time >= firstAnchor.time) break;
          if (ev.pnlDelta !== undefined) startBalance -= ev.pnlDelta;
        }
      }

      // Fill from period start with the starting balance
      let bal = startBalance;
      let nextEventIdx = 0;

      for (let t = startTime; t <= now; t += step) {
        // Apply all events up to this timestamp
        while (nextEventIdx < events.length && events[nextEventIdx].time <= t) {
          const ev = events[nextEventIdx];
          if (ev.balance !== undefined) {
            bal = ev.balance;
          } else if (ev.pnlDelta !== undefined) {
            bal += ev.pnlDelta;
          }
          nextEventIdx++;
        }
        points.push({ time: t, balance: round(bal) });
      }

      // Apply remaining events after last step
      while (nextEventIdx < events.length) {
        const ev = events[nextEventIdx];
        if (ev.balance !== undefined) bal = ev.balance;
        else if (ev.pnlDelta !== undefined) bal += ev.pnlDelta;
        nextEventIdx++;
      }

      // Final point = current equity (balance + unrealized PnL)
      points.push({ time: now, balance: round(currentEquity) });
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

/** Interval between intermediate points for each period */
function getStepForPeriod(period: Period): number {
  if (period === "1d") return 3600;     // 1 hour
  if (period === "3d") return 6 * 3600; // 6 hours
  return 12 * 3600;                     // 12 hours for 7d
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
