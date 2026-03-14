/**
 * Multi-Chain Token Approval Scanner & Revoke Manager
 *
 * Uses Moralis Wallet Approvals API — the same indexed approach as revoke.cash.
 * One API call per chain returns ALL historical approvals with:
 * - Token metadata (symbol, name, logo)
 * - Spender labels & entity names
 * - Allowance amounts & USD at risk
 * - Block timestamps
 *
 * No block scanning needed — Moralis indexes all Approval events from genesis.
 */

import { SUPPORTED_CHAINS, type Chain } from "./chains";

// ─── Types ───────────────────────────────────────────────────────

export interface TokenApproval {
  chain: string;
  chainId: number;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  tokenDecimals: number;
  tokenLogo: string | null;
  spenderAddress: string;
  spenderLabel: string;
  allowanceRaw: string;
  allowanceFormatted: string;
  isUnlimited: boolean;
  risk: "critical" | "high" | "medium" | "low";
  riskReason: string;
  lastApprovalBlock: number;
  /** USD value at risk (from Moralis) */
  usdAtRisk: number | null;
  /** Block explorer URL for the spender */
  explorerUrl: string | null;
}

export interface ApprovalsResponse {
  address: string;
  approvals: TokenApproval[];
  totalApprovals: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  chainBreakdown: Record<string, { count: number; criticalCount: number }>;
  errors: string[];
  scannedAt: number;
}

/** Response for a single-chain scan */
export interface ChainApprovalsResponse {
  address: string;
  chain: string;
  chainId: number;
  approvals: TokenApproval[];
  totalApprovals: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  scannedAt: number;
}

export interface RevokeTransaction {
  to: string;
  data: string;
  value: string;
  gasLimit: string;
  chainId: number;
}

// ─── Moralis API ────────────────────────────────────────────────

const MORALIS_API_KEY = process.env.MORALIS_API_KEY || "";
const MORALIS_BASE = "https://deep-index.moralis.io/api/v2.2";

if (!MORALIS_API_KEY && typeof window === "undefined") {
  console.warn("[approvals] MORALIS_API_KEY not set — approval scanning will not work");
}

// Moralis chain slug mapping (different from our SUPPORTED_CHAINS slugs)
const MORALIS_CHAIN_SLUGS: Record<number, string> = {
  1: "eth",
  8453: "base",
  42161: "arbitrum",
  10: "optimism",
  137: "polygon",
  56: "bsc",
  43114: "avalanche",
};

// ─── Moralis response types ─────────────────────────────────────

interface MoralisApprovalResult {
  block_number: string;
  block_timestamp: string;
  transaction_hash: string;
  token: {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    logo: string | null;
    thumbnail: string | null;
    possible_spam: boolean;
  };
  spender: {
    address: string;
    address_label: string | null;
    entity: string | null;
    entity_logo: string | null;
  };
  value: string; // raw allowance amount
  value_formatted: string; // human-readable
  usd_at_risk: number | null;
}

interface MoralisApprovalsResponse {
  page: number;
  page_size: number;
  cursor?: string | null;
  result: MoralisApprovalResult[];
}

// ─── Known trusted spenders (supplement Moralis labels) ─────────

const TRUSTED_ENTITIES = new Set([
  "uniswap", "aave", "morpho", "1inch", "paraswap", "openocean",
  "sushiswap", "pancakeswap", "quickswap", "trader joe", "pangolin",
  "velodrome", "aerodrome", "curve", "balancer", "compound",
  "lido", "rocket pool", "stargate", "across", "hop",
  "opensea", "blur", "metamask", "coinbase",
]);

const TRUSTED_LABELS = new Set([
  "uniswap", "aave", "morpho", "1inch", "paraswap", "openocean",
  "sushi", "pancake", "quickswap", "velodrome", "aerodrome",
  "curve", "balancer", "compound", "lido", "stargate",
  "metamask swap", "coinbase",
]);

function isKnownTrusted(entity: string | null, label: string | null): boolean {
  if (entity) {
    const lower = entity.toLowerCase();
    for (const e of TRUSTED_ENTITIES) {
      if (lower.includes(e)) return true;
    }
  }
  if (label) {
    const lower = label.toLowerCase();
    for (const l of TRUSTED_LABELS) {
      if (lower.includes(l)) return true;
    }
  }
  return false;
}

// ─── Format allowance ───────────────────────────────────────────

const UNLIMITED_THRESHOLD = BigInt("0x100000000000000000000000000000000"); // 2^128

function parseAllowance(
  rawValue: string,
  formattedValue: string,
  decimals: number
): { formatted: string; isUnlimited: boolean; raw: string } {
  if (!rawValue || rawValue === "0") {
    return { formatted: "0", isUnlimited: false, raw: "0" };
  }

  try {
    const value = BigInt(rawValue);
    if (value === BigInt(0)) {
      return { formatted: "0", isUnlimited: false, raw: "0" };
    }

    if (value >= UNLIMITED_THRESHOLD) {
      return { formatted: "Unlimited", isUnlimited: true, raw: rawValue };
    }
  } catch {
    // If BigInt parse fails, use formatted value from Moralis
  }

  // Use Moralis-provided formatted value, abbreviate if large
  const num = parseFloat(formattedValue);
  if (isNaN(num)) return { formatted: formattedValue, isUnlimited: false, raw: rawValue };

  let formatted: string;
  if (num >= 1_000_000_000) formatted = (num / 1_000_000_000).toFixed(2) + "B";
  else if (num >= 1_000_000) formatted = (num / 1_000_000).toFixed(2) + "M";
  else if (num >= 1_000) formatted = num.toLocaleString("en-US", { maximumFractionDigits: 2 });
  else if (num >= 1) formatted = num.toFixed(2);
  else if (num > 0) formatted = num.toFixed(6);
  else formatted = "0";

  return { formatted, isUnlimited: false, raw: rawValue };
}

// ─── Risk Assessment ────────────────────────────────────────────

function assessRisk(
  isUnlimited: boolean,
  isTrusted: boolean
): { risk: TokenApproval["risk"]; riskReason: string } {
  if (!isTrusted && isUnlimited) {
    return { risk: "critical", riskReason: "Unlimited approval to unknown contract" };
  }
  if (!isTrusted && !isUnlimited) {
    return { risk: "high", riskReason: "Approval to unverified contract" };
  }
  if (isTrusted && isUnlimited) {
    return { risk: "medium", riskReason: "Unlimited approval to verified protocol" };
  }
  return { risk: "low", riskReason: "Limited approval to verified protocol" };
}

// ─── On-chain allowance verification (same approach as revoke.cash) ──
//
// Moralis returns HISTORICAL approval events, not current state.
// The only source of truth is the blockchain itself.
// We call allowance(owner, spender) for each candidate and ONLY keep
// those where the on-chain allowance is confirmed > 0.
//
// If the RPC call fails entirely (network down), we retry once.
// If it still fails, we drop the item — better to miss one than show
// 10 phantom approvals that scare the user.

const ALLOWANCE_SELECTOR = "0xdd62ed3e";

/**
 * Result of an on-chain allowance check.
 *
 * "confirmed" — we got a clear answer from the blockchain (value may be 0 or > 0)
 * "unreachable" — network failure, rate-limit, timeout — we could not verify
 */
type AllowanceResult =
  | { status: "confirmed"; value: bigint }
  | { status: "unreachable" };

/**
 * Single eth_call to read allowance(owner, spender) on-chain.
 */
async function readOnChainAllowance(
  rpcUrl: string,
  tokenAddress: string,
  ownerAddress: string,
  spenderAddress: string
): Promise<AllowanceResult> {
  const paddedOwner = ownerAddress.slice(2).toLowerCase().padStart(64, "0");
  const paddedSpender = spenderAddress.slice(2).toLowerCase().padStart(64, "0");
  const callData = `${ALLOWANCE_SELECTOR}${paddedOwner}${paddedSpender}`;

  const doCall = async (): Promise<AllowanceResult> => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: tokenAddress, data: callData }, "latest"],
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return { status: "unreachable" };
    const json = await res.json();

    // RPC error (revert, invalid contract, etc.) → confirmed zero
    if (json.error) return { status: "confirmed", value: BigInt(0) };

    // No result or empty → not a valid ERC-20 → confirmed zero
    if (!json.result || json.result === "0x") return { status: "confirmed", value: BigInt(0) };

    // Parse any hex response
    try {
      return { status: "confirmed", value: BigInt(json.result) };
    } catch {
      return { status: "confirmed", value: BigInt(0) };
    }
  };

  // Try once, retry on network failure
  try {
    return await doCall();
  } catch {
    try {
      await new Promise((r) => setTimeout(r, 300));
      return await doCall();
    } catch {
      return { status: "unreachable" };
    }
  }
}

/**
 * Verify all candidate approvals on-chain.
 *
 * - confirmed value > 0 → keep with updated on-chain value
 * - confirmed value = 0 → drop (revoked/spent)
 * - unreachable / rejected → drop (can't verify; frontend guards against rescan data loss)
 */
async function verifyAllowancesOnChain(
  chain: Chain,
  ownerAddress: string,
  candidates: { moralisItem: MoralisApprovalResult }[]
): Promise<MoralisApprovalResult[]> {
  if (candidates.length === 0) return [];

  const BATCH_SIZE = 5;
  const verified: MoralisApprovalResult[] = [];

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);

    if (i > 0) {
      await new Promise((r) => setTimeout(r, 150));
    }

    const results = await Promise.allSettled(
      batch.map((c) =>
        readOnChainAllowance(
          chain.rpcUrl,
          c.moralisItem.token.address,
          ownerAddress,
          c.moralisItem.spender.address
        )
      )
    );

    results.forEach((result, idx) => {
      const candidate = batch[idx];

      // Promise itself rejected — can't verify, drop
      if (result.status === "rejected") return;

      const check = result.value;

      // Network unreachable (rate limit, timeout) — can't verify, drop.
      // The frontend guards against rescan-clearing-cache separately.
      if (check.status === "unreachable") return;

      // Confirmed zero = definitely revoked/spent → drop
      if (check.value === BigInt(0)) return;

      // Confirmed > 0 — real active approval. Update with on-chain value.
      const updatedItem = { ...candidate.moralisItem };
      updatedItem.value = check.value.toString();

      const decimals = updatedItem.token.decimals;
      if (decimals > 0) {
        const divisor = BigInt(10) ** BigInt(decimals);
        const intPart = check.value / divisor;
        const fracPart = check.value % divisor;
        const fracStr = fracPart.toString().padStart(decimals, "0");
        updatedItem.value_formatted = `${intPart}.${fracStr}`;
      } else {
        updatedItem.value_formatted = check.value.toString();
      }

      verified.push(updatedItem);
    });
  }

  return verified;
}

// ─── Fetch approvals for a single chain via Moralis ─────────────

async function fetchChainApprovals(
  chain: Chain,
  ownerAddress: string
): Promise<TokenApproval[]> {
  if (!MORALIS_API_KEY) throw new Error("MORALIS_API_KEY not configured");

  const moralisChain = MORALIS_CHAIN_SLUGS[chain.id];
  if (!moralisChain) throw new Error(`Unsupported chain for Moralis: ${chain.id}`);

  const allResults: MoralisApprovalResult[] = [];
  let cursor: string | null = null;

  // Paginate through all results (Moralis limits to 100 per page)
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ chain: moralisChain });
    if (cursor) params.set("cursor", cursor);

    const url = `${MORALIS_BASE}/wallets/${encodeURIComponent(ownerAddress)}/approvals?${params}`;

    const res = await fetch(url, {
      headers: {
        "X-API-Key": MORALIS_API_KEY,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      // Moralis returns 400 for unsupported chains — not an error
      if (res.status === 400) return [];
      throw new Error(`Moralis ${chain.name}: ${res.status}`);
    }

    const data: MoralisApprovalsResponse = await res.json();
    allResults.push(...data.result);

    if (!data.cursor) break;
    cursor = data.cursor;
  }

  // Step 1: Pre-filter spam/zeros and deduplicate by token+spender
  // Moralis may return multiple entries for the same pair (from different approval txs).
  // Keep only the latest (highest block number) for each unique token+spender.
  const deduped = new Map<string, MoralisApprovalResult>();

  for (const item of allResults) {
    if (item.token.possible_spam) continue;
    if (!item.value || item.value === "0") continue;

    const dedupKey = `${item.token.address.toLowerCase()}|${item.spender.address.toLowerCase()}`;
    const existing = deduped.get(dedupKey);
    const blockNum = parseInt(item.block_number) || 0;

    if (!existing || blockNum > (parseInt(existing.block_number) || 0)) {
      deduped.set(dedupKey, item);
    }
  }

  const candidates = Array.from(deduped.values()).map((moralisItem) => ({ moralisItem }));

  // Step 2: Verify real on-chain allowances (filters out revoked/spent approvals)
  const verifiedItems = await verifyAllowancesOnChain(chain, ownerAddress, candidates);

  // Step 3: Build final approval objects from verified data
  const approvals: TokenApproval[] = [];

  for (const item of verifiedItems) {
    const { formatted, isUnlimited, raw } = parseAllowance(
      item.value,
      item.value_formatted,
      item.token.decimals
    );

    // Skip zero after parsing
    if (formatted === "0") continue;

    // Resolve spender label
    const spenderLabel =
      item.spender.entity ||
      item.spender.address_label ||
      `${item.spender.address.slice(0, 6)}...${item.spender.address.slice(-4)}`;

    // Trust assessment
    const isTrusted = isKnownTrusted(item.spender.entity, item.spender.address_label);
    const { risk, riskReason } = assessRisk(isUnlimited, isTrusted);

    approvals.push({
      chain: chain.slug,
      chainId: chain.id,
      tokenAddress: item.token.address.toLowerCase(),
      tokenSymbol: item.token.symbol || "Unknown",
      tokenName: item.token.name || "Unknown Token",
      tokenDecimals: item.token.decimals,
      tokenLogo: item.token.logo || item.token.thumbnail,
      spenderAddress: item.spender.address.toLowerCase(),
      spenderLabel,
      allowanceRaw: raw,
      allowanceFormatted: formatted,
      isUnlimited,
      risk,
      riskReason,
      lastApprovalBlock: parseInt(item.block_number) || 0,
      usdAtRisk: item.usd_at_risk,
      explorerUrl: `${chain.explorerUrl}/address/${item.spender.address}`,
    });
  }

  return approvals;
}

// ─── Single-Chain Scan ──────────────────────────────────────────

/**
 * Scan a single chain for ERC-20 approvals via Moralis API.
 * Used for per-chain lazy loading in the UI.
 */
export async function scanChainApprovals(
  ownerAddress: string,
  chainSlug: string
): Promise<ChainApprovalsResponse> {
  const chain = SUPPORTED_CHAINS.find((c) => c.slug === chainSlug);
  if (!chain) throw new Error(`Unknown chain: ${chainSlug}`);

  const approvals = await fetchChainApprovals(chain, ownerAddress);

  // Sort: critical first, then high, then by USD at risk
  const riskOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  approvals.sort((a, b) => {
    const riskDiff = riskOrder[a.risk] - riskOrder[b.risk];
    if (riskDiff !== 0) return riskDiff;
    return (b.usdAtRisk || 0) - (a.usdAtRisk || 0);
  });

  return {
    address: ownerAddress.toLowerCase(),
    chain: chain.slug,
    chainId: chain.id,
    approvals,
    totalApprovals: approvals.length,
    criticalCount: approvals.filter((a) => a.risk === "critical").length,
    highCount: approvals.filter((a) => a.risk === "high").length,
    mediumCount: approvals.filter((a) => a.risk === "medium").length,
    lowCount: approvals.filter((a) => a.risk === "low").length,
    scannedAt: Date.now(),
  };
}

// ─── Multi-Chain Scan ───────────────────────────────────────────

/**
 * Scan all supported chains for ERC-20 approvals via Moralis API.
 * All chains queried in parallel. Failed chains reported in errors[].
 */
export async function scanAllApprovals(ownerAddress: string): Promise<ApprovalsResponse> {
  const errors: string[] = [];
  const allApprovals: TokenApproval[] = [];
  const chainBreakdown: Record<string, { count: number; criticalCount: number }> = {};

  const results = await Promise.allSettled(
    SUPPORTED_CHAINS.map((chain) => fetchChainApprovals(chain, ownerAddress))
  );

  results.forEach((result, i) => {
    const chain = SUPPORTED_CHAINS[i];
    if (result.status === "fulfilled") {
      allApprovals.push(...result.value);
      chainBreakdown[chain.slug] = {
        count: result.value.length,
        criticalCount: result.value.filter((a) => a.risk === "critical").length,
      };
    } else {
      console.error(`[approvals] Failed to scan ${chain.name}:`, result.reason);
      errors.push(chain.name);
      chainBreakdown[chain.slug] = { count: 0, criticalCount: 0 };
    }
  });

  // Sort: critical first, then high, then by USD at risk
  const riskOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  allApprovals.sort((a, b) => {
    const riskDiff = riskOrder[a.risk] - riskOrder[b.risk];
    if (riskDiff !== 0) return riskDiff;
    // Within same risk level, sort by USD at risk (highest first)
    return (b.usdAtRisk || 0) - (a.usdAtRisk || 0);
  });

  return {
    address: ownerAddress.toLowerCase(),
    approvals: allApprovals,
    totalApprovals: allApprovals.length,
    criticalCount: allApprovals.filter((a) => a.risk === "critical").length,
    highCount: allApprovals.filter((a) => a.risk === "high").length,
    mediumCount: allApprovals.filter((a) => a.risk === "medium").length,
    lowCount: allApprovals.filter((a) => a.risk === "low").length,
    chainBreakdown,
    errors,
    scannedAt: Date.now(),
  };
}

// ─── Revoke Transaction Builder ─────────────────────────────────

const APPROVE_SELECTOR = "0x095ea7b3";

export function buildRevokeTransaction(
  tokenAddress: string,
  spenderAddress: string,
  chainId: number
): RevokeTransaction {
  const paddedSpender = spenderAddress.slice(2).padStart(64, "0");
  const paddedAmount = "0".padStart(64, "0");

  return {
    to: tokenAddress,
    data: `${APPROVE_SELECTOR}${paddedSpender}${paddedAmount}`,
    value: "0x0",
    gasLimit: "0x15F90", // 90,000
    chainId,
  };
}

export function buildBatchRevokeTransactions(
  approvals: { tokenAddress: string; spenderAddress: string; chainId: number }[]
): RevokeTransaction[] {
  return approvals.map((a) => buildRevokeTransaction(a.tokenAddress, a.spenderAddress, a.chainId));
}
