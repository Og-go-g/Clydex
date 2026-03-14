import { NextResponse } from "next/server";
import {
  scanAllApprovals,
  scanChainApprovals,
  buildRevokeTransaction,
  buildBatchRevokeTransactions,
} from "@/lib/defi/approvals";
import { SUPPORTED_CHAINS } from "@/lib/defi/chains";
import { getAuthAddress } from "@/lib/auth/session";

const VALID_CHAIN_SLUGS = new Set(SUPPORTED_CHAINS.map((c) => c.slug));

/**
 * GET /api/approvals?address=0x...
 * GET /api/approvals?address=0x...&chain=base   — scan single chain (lazy load)
 *
 * Without `chain` param → scans all chains (legacy behavior).
 * With `chain` param → scans only the specified chain (fast, for per-tab loading).
 */
export async function GET(request: Request) {
  try {
    const authAddress = await getAuthAddress();
    if (!authAddress) {
      return NextResponse.json(
        { error: "Not authenticated — please sign in first" },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const address = searchParams.get("address");
    const chainParam = searchParams.get("chain");

    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return NextResponse.json(
        { error: "Missing or invalid address parameter" },
        { status: 400 }
      );
    }

    if (address.toLowerCase() !== authAddress) {
      return NextResponse.json(
        { error: "Address mismatch — you can only scan your own approvals" },
        { status: 403 }
      );
    }

    // Single-chain scan
    if (chainParam) {
      if (!VALID_CHAIN_SLUGS.has(chainParam)) {
        return NextResponse.json(
          { error: `Invalid chain: ${chainParam}` },
          { status: 400 }
        );
      }

      const result = await scanChainApprovals(address, chainParam);
      return NextResponse.json(result);
    }

    // All-chains scan (legacy)
    const approvals = await scanAllApprovals(address);
    return NextResponse.json(approvals);
  } catch (error) {
    console.error("Approvals API error:", error);
    return NextResponse.json(
      { error: "Failed to scan approvals" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/approvals
 * Build revoke transaction(s) for one or more approvals.
 *
 * Body:
 *   { tokenAddress, spenderAddress, chainId }                          — single revoke
 *   { approvals: [{ tokenAddress, spenderAddress, chainId }, ...] }    — batch revoke
 */
export async function POST(request: Request) {
  try {
    const authAddress = await getAuthAddress();
    if (!authAddress) {
      return NextResponse.json(
        { error: "Not authenticated — please sign in first" },
        { status: 401 }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    // Batch revoke
    if (Array.isArray(body.approvals)) {
      const MAX_BATCH = 50;
      const approvalsList = (body.approvals as Record<string, unknown>[]).slice(0, MAX_BATCH);

      const validated = approvalsList.filter(
        (a) =>
          typeof a.tokenAddress === "string" &&
          /^0x[0-9a-fA-F]{40}$/.test(a.tokenAddress as string) &&
          typeof a.spenderAddress === "string" &&
          /^0x[0-9a-fA-F]{40}$/.test(a.spenderAddress as string) &&
          typeof a.chainId === "number" &&
          a.chainId > 0
      );

      if (validated.length === 0) {
        return NextResponse.json(
          { error: "No valid approvals provided" },
          { status: 400 }
        );
      }

      const transactions = buildBatchRevokeTransactions(
        validated as { tokenAddress: string; spenderAddress: string; chainId: number }[]
      );
      return NextResponse.json({ transactions });
    }

    // Single revoke
    const { tokenAddress, spenderAddress, chainId } = body as {
      tokenAddress: unknown;
      spenderAddress: unknown;
      chainId: unknown;
    };

    if (
      typeof tokenAddress !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress) ||
      typeof spenderAddress !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(spenderAddress) ||
      typeof chainId !== "number" ||
      chainId <= 0
    ) {
      return NextResponse.json(
        { error: "Invalid tokenAddress, spenderAddress, or chainId" },
        { status: 400 }
      );
    }

    const transaction = buildRevokeTransaction(tokenAddress, spenderAddress, chainId);
    return NextResponse.json({ transaction });
  } catch (error) {
    console.error("Revoke API error:", error);
    return NextResponse.json(
      { error: "Failed to build revoke transaction" },
      { status: 500 }
    );
  }
}
