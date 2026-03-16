import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { getAuthAddress } from "@/lib/auth/session";
import { getUser, getAccount } from "@/lib/n1/client";
import { checkLiquidationRisk } from "@/lib/n1/alerts";

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
      return NextResponse.json({
        exists: false,
        collateral: 0,
        availableMargin: 0,
        hasPositions: false,
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

    return NextResponse.json({
      exists: true,
      accountId,
      collateral: usdcBalance,
      availableMargin: margins?.omf ?? 0,
      maintenanceMargin: margins?.mmf ?? 0,
      marginRatio: margins?.pon ? (margins.omf / margins.pon) : null,
      hasPositions: positions.length > 0,
      positionCount: positions.length,
      isBankrupt: margins?.bankruptcy ?? false,
    });
  } catch (error) {
    console.error("[/api/collateral] GET error:", error);
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = CollateralActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.issues.map(i => i.message) },
      { status: 400 }
    );
  }

  const { action, amount } = parsed.data;

  // Additional numeric safety
  if (amount > 1_000_000_000) {
    return NextResponse.json({ error: "Amount exceeds maximum" }, { status: 400 });
  }

  try {
    const user = await getUser(address);

    // ─── Deposit validation ──────────────────────────────
    if (action === "deposit") {
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

    // Check: will this liquidate positions?
    if (positions.length > 0 && margins) {
      const availableForWithdrawal = margins.omf - margins.imf;

      if (amount > availableForWithdrawal) {
        warnings.push(
          `This withdrawal may put your positions at risk. Available for safe withdrawal: $${Math.max(0, availableForWithdrawal).toFixed(2)}.`
        );
      }

      // Simulate post-withdrawal margin ratio
      const newOmf = margins.omf - amount;
      if (margins.pon > 0) {
        const newRatio = newOmf / margins.pon;
        if (newRatio < 0.10) {
          warnings.push("CRITICAL: After this withdrawal, your margin ratio will be below 10%. Liquidation risk is very high.");
          approved = false;
        } else if (newRatio < 0.15) {
          warnings.push("WARNING: After this withdrawal, your margin ratio will be below 15%. Consider reducing positions first.");
        }
      }

      // Check current liquidation risk
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
    console.error("[/api/collateral] POST error:", error);
    return NextResponse.json(
      { error: "Failed to validate collateral action" },
      { status: 500 }
    );
  }
}
