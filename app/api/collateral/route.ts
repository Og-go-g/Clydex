import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod/v4";
import { getAuthAddress } from "@/lib/auth/session";
import { getUser, getAccount } from "@/lib/n1/client";
import { checkLiquidationRisk } from "@/lib/n1/alerts";
import { computeMaxWithdraw, POST_WITHDRAW_MARGIN_FLOOR } from "@/lib/n1/margin";
import { RATE_LIMITS, safeRateLimit } from "@/lib/ratelimit";
import { CURRENT_TERMS_VERSION, hasAcceptedCurrentTerms } from "@/lib/legal";

// ─── Zod Schemas ──────────────────────────────────────────────────

const CollateralActionSchema = z.object({
  action: z.enum(["deposit", "withdraw"]),
  amount: z.number().positive("Amount must be positive").finite("Amount must be finite"),
});

// ─── GET /api/collateral — current collateral info for the modal ──

export async function GET() {
  try {
    const address = await getAuthAddress();
    if (!address) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const user = await getUser(address);
    if (!user || !user.accountIds?.length) {
      // Intentional: return same shape with exists: false so the deposit flow UI
      // can show "create account" messaging. This is NOT a privacy leak since
      // the endpoint is authenticated (requires valid session for this wallet).
      return NextResponse.json({
        exists: false,
        collateral: 0,
        availableMargin: 0,
        hasPositions: false,
        positionCount: 0,
        isBankrupt: false,
        message: "No 01 Exchange account found. Deposit USDC to create one.",
      });
    }

    const accountId = user.accountIds[0];
    const account = await getAccount(accountId);
    const usdcBalance = account.balances?.find((b) => b.tokenId === 0)?.amount ?? 0;
    const margins = account.margins;
    const positions = account.positions?.filter(
      (p) => p.perp && p.perp.baseSize !== 0
    ) ?? [];

    // availableMargin = max safe withdraw amount (USD). Computed via the
    // shared margin helper so the UI display matches the server-side
    // approval check on POST. See lib/n1/margin.ts for the formula and
    // its alignment with the protocol's withdraw constraint
    // (https://docs.01.xyz/margins/n1).
    const availableMargin = margins ? computeMaxWithdraw(margins) : 0;

    return NextResponse.json({
      exists: true,
      accountId,
      collateral: usdcBalance,
      availableMargin,
      maintenanceMargin: margins?.mmf ?? 0,
      marginRatio: margins?.pon && margins.pon > 0.001 ? (isFinite(margins.omf / margins.pon) ? Math.min(margins.omf / margins.pon, 100) : null) : null,
      hasPositions: positions.length > 0,
      positionCount: positions.length,
      isBankrupt: margins?.bankruptcy ?? false,
    });
  } catch (error) {
    Sentry.captureException(error, { tags: { endpoint: "collateral", method: "GET" } });
    return NextResponse.json(
      { error: "Failed to fetch collateral info" },
      { status: 500 }
    );
  }
}

// ─── POST /api/collateral — validate deposit/withdraw before client-side execution ──
//
// SECURITY: This does NOT execute the transaction. It validates parameters
// and returns safety warnings. The actual deposit/withdraw requires wallet
// signature and happens client-side via NordUser SDK.

export async function POST(req: Request) {
  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Per-user rate limit (graceful Upstash fallback)
  {
    const { success } = await safeRateLimit(address, "collateral:", RATE_LIMITS.collateral);
    if (!success) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = CollateralActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request parameters" },
      { status: 400 }
    );
  }

  const { action, amount } = parsed.data;

  // Additional numeric safety — matches client-side MAX_AMOUNT
  if (amount > 1_000_000) {
    return NextResponse.json({ error: "Amount exceeds maximum ($1M)" }, { status: 400 });
  }

  try {
    const user = await getUser(address);

    // ─── Deposit validation ──────────────────────────────
    if (action === "deposit") {
      // Enforce ToS acceptance before any deposit. Withdrawals are NOT
      // blocked even without acceptance — a user must always be able to
      // pull their funds out, regardless of legal-flow state.
      const accepted = await hasAcceptedCurrentTerms(address);
      if (!accepted) {
        return NextResponse.json(
          {
            approved: false,
            action: "deposit",
            requiresTermsAcceptance: true,
            currentVersion: CURRENT_TERMS_VERSION,
            message:
              "Please review and accept the Terms of Service and Privacy Policy before depositing.",
          },
          { status: 403 },
        );
      }

      if (!user || !user.accountIds?.length) {
        // First deposit — account will be created
        return NextResponse.json({
          approved: true,
          action: "deposit",
          amount,
          warnings: [],
          message: "This will create your 01 Exchange account and deposit USDC.",
          requiresConfirmation: false,
        });
      }

      return NextResponse.json({
        approved: true,
        action: "deposit",
        amount,
        warnings: [],
        message: `Deposit $${amount.toFixed(2)} USDC to your 01 Exchange account.`,
        requiresConfirmation: false,
      });
    }

    // ─── Withdraw validation ─────────────────────────────
    if (!user || !user.accountIds?.length) {
      return NextResponse.json(
        { error: "No account found. Cannot withdraw." },
        { status: 400 }
      );
    }

    const accountId = user.accountIds[0];
    const account = await getAccount(accountId);
    const usdcBalance = account.balances?.find((b) => b.tokenId === 0)?.amount ?? 0;
    const margins = account.margins;
    const positions = account.positions?.filter(
      (p) => p.perp && p.perp.baseSize !== 0
    ) ?? [];

    const warnings: string[] = [];
    let approved = true;

    // Check: enough balance
    if (amount > usdcBalance) {
      return NextResponse.json({
        approved: false,
        action: "withdraw",
        amount,
        warnings: [`Insufficient balance. You have $${usdcBalance.toFixed(2)} USDC.`],
        message: "Withdrawal denied: insufficient balance.",
        requiresConfirmation: false,
      });
    }

    // Check: will this withdraw breach the safety floor?
    //
    // Replaces the previous `omf − imf` heuristic, which let users
    // withdraw "free margin" derived from omf that included unrealized
    // PnL. A user with +PnL could withdraw paper profit and then get
    // insta-liquidated by a 1% adverse tick.
    //
    // New formula (lib/n1/margin.ts) takes the tightest of:
    //   - protocol bound (omf − imf): what the protocol itself would
    //     accept based on min(AV, TV) ≥ Σ(PON × IMF_base)
    //   - safety bound (mf − 0.15 × pon): keeps post-withdraw margin
    //     ratio above the audit-mandated 15% floor
    // Hard-rejects beyond that. Above the floor is unsafe per audit C1
    // acceptance — no "warn and confirm" middle band.
    if (positions.length > 0 && margins) {
      const maxSafe = computeMaxWithdraw(margins);

      if (amount > maxSafe) {
        const floorPct = (POST_WITHDRAW_MARGIN_FLOOR * 100).toFixed(0);
        warnings.push(
          `Withdrawal would push margin ratio below ${floorPct}%. ` +
            `Max safe withdrawal: $${maxSafe.toFixed(2)}. ` +
            `Reduce positions to free up more collateral.`,
        );
        approved = false;
      }

      // Already-unhealthy account: critical/emergency state means any
      // withdraw is reckless even if the math allows a small one.
      const alert = checkLiquidationRisk(margins);
      if (alert && alert.level !== "warning") {
        warnings.push(`Your account is already in ${alert.level} state. Withdrawing now is extremely risky.`);
        approved = false;
      }
    }

    // Withdraw > 50% of collateral — extra warning
    if (amount > usdcBalance * 0.5 && positions.length > 0) {
      warnings.push("You are withdrawing more than 50% of your collateral while having open positions.");
    }

    return NextResponse.json({
      approved,
      action: "withdraw",
      amount,
      currentBalance: usdcBalance,
      warnings,
      message: approved
        ? `Withdraw $${amount.toFixed(2)} USDC from your 01 Exchange account.`
        : "Withdrawal blocked due to liquidation risk. Close positions or reduce the amount.",
      requiresConfirmation: warnings.length > 0,
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "collateral", method: "POST" },
      extra: { action, amount, user: address.slice(0, 8) },
    });
    return NextResponse.json(
      { error: "Failed to validate collateral action" },
      { status: 500 }
    );
  }
}
