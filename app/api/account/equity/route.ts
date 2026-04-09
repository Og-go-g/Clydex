import { NextRequest, NextResponse } from "next/server";
import { getAuthAddress } from "@/lib/auth/session";
import { query } from "@/lib/db-history";

/**
 * GET /api/account/equity — equity curve (balance over time) for authenticated user.
 *
 * Reconstructs balance history from deposits, withdrawals, and realized PnL.
 * Each point = { time (unix seconds), balance (USD) }.
 *
 * Query params:
 *   period: "7d" | "30d" | "90d" | "all" (default: "30d")
 */

type Period = "7d" | "30d" | "90d" | "all";

function periodToInterval(period: Period): string | null {
  if (period === "7d") return "7 days";
  if (period === "30d") return "30 days";
  if (period === "90d") return "90 days";
  return null; // all
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

  const interval = periodToInterval(period);
  const timeFilter = interval
    ? `AND time >= NOW() - INTERVAL '${interval}'`
    : "";

  try {
    // 1. Deposits — each has balance AFTER deposit
    const deposits = await query<{ time: Date; balance: string; type: string }>(
      `SELECT "time", balance::text, 'deposit' AS type
       FROM deposit_history
       WHERE "walletAddr" = $1 ${timeFilter}`,
      [address],
    );

    // 2. Withdrawals — each has balance AFTER withdrawal
    const withdrawals = await query<{ time: Date; balance: string; type: string }>(
      `SELECT "time", balance::text, 'withdrawal' AS type
       FROM withdrawal_history
       WHERE "walletAddr" = $1 ${timeFilter}`,
      [address],
    );

    // 3. PnL events — realized PnL changes balance
    // We reconstruct balance at each PnL event by finding the nearest
    // deposit/withdrawal balance and adding cumulative PnL delta
    const pnlEvents = await query<{ time: Date; tradingPnl: string; settledFundingPnl: string }>(
      `SELECT "time", "tradingPnl"::text, "settledFundingPnl"::text
       FROM pnl_history
       WHERE "walletAddr" = $1 ${timeFilter}
       ORDER BY "time" ASC`,
      [address],
    );

    // Merge all events chronologically
    interface EquityPoint {
      time: number; // unix seconds
      balance: number;
    }

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

    // Sort by time ascending
    events.sort((a, b) => a.time.getTime() - b.time.getTime());

    if (events.length === 0) {
      return NextResponse.json({ points: [] });
    }

    // Build equity curve
    const points: EquityPoint[] = [];
    let currentBalance = 0;

    for (const ev of events) {
      if (ev.balance !== undefined) {
        // Deposit/withdrawal — balance is exact snapshot
        currentBalance = ev.balance;
      } else if (ev.pnlDelta !== undefined) {
        // PnL event — adjust balance by delta
        currentBalance += ev.pnlDelta;
      }

      points.push({
        time: Math.floor(ev.time.getTime() / 1000),
        balance: Math.round(currentBalance * 100) / 100,
      });
    }

    // Deduplicate same-second points (keep last)
    const deduped: EquityPoint[] = [];
    for (let i = 0; i < points.length; i++) {
      if (i === points.length - 1 || points[i].time !== points[i + 1].time) {
        deduped.push(points[i]);
      }
    }

    return NextResponse.json(
      { points: deduped },
      { headers: { "Cache-Control": "private, max-age=60" } },
    );
  } catch (error) {
    console.error("[api/account/equity] error:", error);
    return NextResponse.json({ error: "Failed to fetch equity data" }, { status: 500 });
  }
}
