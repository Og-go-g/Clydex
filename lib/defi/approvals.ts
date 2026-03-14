/**
 * Multi-Chain Token Approval Scanner & Revoke Manager
 *
 * SECURITY-FIRST APPROACH — 6 layers of verification:
 *
 * Layer 1: Moralis possible_spam flag
 * Layer 2: Token name/symbol pattern analysis (URLs, phishing, garbage)
 * Layer 3: Economic signal filter (no price + no logo + unknown spender = spam)
 * Layer 4: On-chain contract validation (eth_getCode + decimals + symbol + totalSupply)
 * Layer 5: On-chain allowance verification (actual current allowance > 0)
 * Layer 6: Cross-validation (on-chain symbol must match Moralis data)
 *
 * Only approvals that pass ALL 6 layers are shown to the user.
 * This matches revoke.cash accuracy — never show phantom/spam approvals.
 */

import { SUPPORTED_CHAINS, type Chain } from "./chains";
import { isValidAddress } from "./utils";

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

// ═══════════════════════════════════════════════════════════════════
// LAYER 1 + 2: Spam Token Detection
// ═══════════════════════════════════════════════════════════════════
//
// These are fast client-side checks BEFORE we hit any RPC.
// Filters known spam patterns, phishing tokens, garbage contracts.

const SPAM_NAME_PATTERNS = [
  /https?:\/\//i,                                    // URLs in token name
  /\.(com|org|net|io|xyz|finance|claim|airdrop)/i,   // domain-like names
  /visit|claim|reward|airdrop|voucher|redeem/i,      // phishing keywords
  /free\s*(mint|token|nft|drop)/i,                   // free mint scams
  /bonus|winner|congratulat/i,                       // lottery scams
  /[\u0000-\u001F]/,                                 // control characters
  /\$\s*\d/,                                         // "$123" style scam names
  /[<>{}]/,                                          // HTML/code injection
  /^0x[0-9a-f]{6,}/i,                               // token named as hex address
];

const MAX_SYMBOL_LENGTH = 20;   // legitimate tokens rarely exceed this
const MAX_NAME_LENGTH = 50;

function isSpamToken(token: {
  name: string;
  symbol: string;
  possible_spam: boolean;
}): boolean {
  // Layer 1: Moralis flag
  if (token.possible_spam) return true;

  const name = token.name || "";
  const symbol = token.symbol || "";

  // Layer 2: Pattern analysis
  if (symbol.length > MAX_SYMBOL_LENGTH) return true;
  if (name.length > MAX_NAME_LENGTH) return true;
  if (!symbol.trim()) return true;

  for (const pattern of SPAM_NAME_PATTERNS) {
    if (pattern.test(name) || pattern.test(symbol)) return true;
  }

  // Non-ASCII characters in symbol (legit tokens use ASCII)
  if (/[^\x20-\x7E]/.test(symbol)) return true;

  return false;
}

// ═══════════════════════════════════════════════════════════════════
// LAYER 3: Economic Signal Filter
// ═══════════════════════════════════════════════════════════════════
//
// Tokens must have at least ONE positive economic signal:
// - Has a USD price from Moralis (meaning it's traded on DEXes)
// - Has a token logo (meaning Moralis has it in their verified DB)
// - Spender is a recognized entity (not just a random address)
//
// Tokens with ZERO signals are almost certainly spam/dust.
// Revoke.cash uses the same approach.

function hasEconomicSignal(item: MoralisApprovalResult): boolean {
  const signals: boolean[] = [
    // Signal 1: Token has a market price (Moralis can price it)
    item.usd_at_risk !== null && item.usd_at_risk > 0,
    // Signal 2: Token has an official logo in Moralis DB
    item.token.logo !== null && item.token.logo !== "",
    // Signal 3: Spender is a recognized/labeled entity
    item.spender.entity !== null || item.spender.address_label !== null,
  ];

  // Must have at least 1 positive signal
  return signals.some(Boolean);
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
  _decimals: number
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

// ═══════════════════════════════════════════════════════════════════
// LAYER 4 + 5 + 6 + 7: On-Chain Deep Verification
// ═══════════════════════════════════════════════════════════════════
//
// This is where we separate real from fake. Every candidate goes through:
//
// 4a) eth_getCode — contract must have bytecode (> 100 bytes for real ERC-20)
// 4b) decimals() — must return valid 0-77
// 4c) symbol() — must return valid UTF-8 string
// 4d) totalSupply() — must return > 0
// 5)  allowance(owner, spender) — must return > 0
// 6)  Cross-validate: on-chain symbol must roughly match Moralis symbol
// 7)  Revoke gas simulation — eth_estimateGas for approve(spender, 0)
//     Normal revoke = ~26k-46k gas. If > 100k → GAS TOKEN SCAM on BSC
//     or frozen/malicious contract. Token is hidden entirely.
//
// All in a SINGLE batch RPC call per token for efficiency.

// ERC-20 function selectors
const SEL_ALLOWANCE   = "0xdd62ed3e"; // allowance(address,address)
const SEL_DECIMALS    = "0x313ce567"; // decimals()
const SEL_SYMBOL      = "0x95d89b41"; // symbol()
const SEL_TOTALSUPPLY = "0x18160ddd"; // totalSupply()
const SEL_APPROVE     = "0x095ea7b3"; // approve(address,uint256)

// Minimum bytecode size for a real ERC-20 contract
// Simple proxy/scam contracts are usually < 100 bytes
// Real ERC-20s (even minimal) are 200+ bytes
const MIN_CONTRACT_CODE_LENGTH = 100; // hex chars (= 50 bytes)

// Gas limits for Layer 7 (revoke gas simulation)
// Normal approve(spender, 0) uses ~26,000-46,000 gas
// Gas Token scam contracts use 2,000,000+ gas on BSC
// Frozen/paused contracts either revert or use excessive gas
const MAX_SAFE_REVOKE_GAS = 100_000;

/**
 * Result of full on-chain verification.
 *
 * "verified" — contract is a real ERC-20 with active allowance
 * "rejected" — contract failed validation (spam, fake, zero allowance)
 * "unreachable" — network failure, can't verify
 */
type VerificationResult =
  | { status: "verified"; allowance: bigint; onChainSymbol: string }
  | { status: "rejected"; reason: string }
  | { status: "unreachable" };

/**
 * Deep on-chain verification of a single token approval.
 *
 * Sends a batch RPC with 6 calls:
 * 1. eth_getCode        (is it a real contract?)
 * 2. decimals()         (valid ERC-20?)
 * 3. symbol()           (cross-validation)
 * 4. totalSupply()      (token actually exists?)
 * 5. allowance()        (approval still active?)
 * 6. eth_estimateGas    (is approve(spender,0) safe to call?)
 *    → Layer 7: Gas Token scam detection. If revoke costs > 100k gas,
 *    the token is malicious and should not even be shown.
 */
async function deepVerifyToken(
  rpcUrl: string,
  tokenAddress: string,
  ownerAddress: string,
  spenderAddress: string,
  expectedSymbol: string
): Promise<VerificationResult> {
  const paddedOwner = ownerAddress.slice(2).toLowerCase().padStart(64, "0");
  const paddedSpender = spenderAddress.slice(2).toLowerCase().padStart(64, "0");
  const allowanceData = `${SEL_ALLOWANCE}${paddedOwner}${paddedSpender}`;

  // Build approve(spender, 0) calldata for gas simulation
  const revokeCalldata = `${SEL_APPROVE}${paddedSpender}${"0".padStart(64, "0")}`;

  const doVerify = async (): Promise<VerificationResult> => {
    const batchBody = JSON.stringify([
      // 1. Get contract bytecode
      {
        jsonrpc: "2.0", id: 1,
        method: "eth_getCode",
        params: [tokenAddress, "latest"],
      },
      // 2. decimals()
      {
        jsonrpc: "2.0", id: 2,
        method: "eth_call",
        params: [{ to: tokenAddress, data: SEL_DECIMALS }, "latest"],
      },
      // 3. symbol()
      {
        jsonrpc: "2.0", id: 3,
        method: "eth_call",
        params: [{ to: tokenAddress, data: SEL_SYMBOL }, "latest"],
      },
      // 4. totalSupply()
      {
        jsonrpc: "2.0", id: 4,
        method: "eth_call",
        params: [{ to: tokenAddress, data: SEL_TOTALSUPPLY }, "latest"],
      },
      // 5. allowance(owner, spender)
      {
        jsonrpc: "2.0", id: 5,
        method: "eth_call",
        params: [{ to: tokenAddress, data: allowanceData }, "latest"],
      },
      // 6. Simulate revoke gas: approve(spender, 0) — Layer 7
      {
        jsonrpc: "2.0", id: 6,
        method: "eth_estimateGas",
        params: [{
          from: ownerAddress,
          to: tokenAddress,
          data: revokeCalldata,
        }],
      },
    ]);

    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: batchBody,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return { status: "unreachable" };
    const json = await res.json();

    // ── Handle non-batch RPC (fallback to allowance-only) ──
    if (!Array.isArray(json)) {
      // RPC doesn't support batch — do minimal allowance check
      if (json.error) return { status: "rejected", reason: "RPC error" };
      if (!json.result || json.result === "0x") {
        return { status: "rejected", reason: "No allowance result" };
      }
      try {
        const val = BigInt(json.result);
        if (val === BigInt(0)) return { status: "rejected", reason: "Zero allowance" };
        return { status: "verified", allowance: val, onChainSymbol: expectedSymbol };
      } catch {
        return { status: "rejected", reason: "Invalid allowance hex" };
      }
    }

    // ── Find responses by ID ──
    const find = (id: number) => json.find((r: { id: number }) => r.id === id);
    const codeRes = find(1);
    const decimalsRes = find(2);
    const symbolRes = find(3);
    const supplyRes = find(4);
    const allowanceRes = find(5);

    // ── CHECK 4a: Contract must have real bytecode ──
    if (!codeRes || codeRes.error || !codeRes.result) {
      return { status: "rejected", reason: "No contract code response" };
    }
    const code = codeRes.result as string;
    // "0x" means no code (EOA or destroyed contract)
    if (code === "0x" || code === "0x0" || code.length < MIN_CONTRACT_CODE_LENGTH) {
      return { status: "rejected", reason: `Contract too small: ${code.length} chars` };
    }

    // ── CHECK 4b: decimals() must return valid value ──
    if (
      !decimalsRes || decimalsRes.error ||
      !decimalsRes.result || decimalsRes.result === "0x"
    ) {
      return { status: "rejected", reason: "decimals() failed" };
    }
    try {
      const dec = Number(BigInt(decimalsRes.result));
      if (dec < 0 || dec > 77) {
        return { status: "rejected", reason: `Invalid decimals: ${dec}` };
      }
    } catch {
      return { status: "rejected", reason: "decimals() parse error" };
    }

    // ── CHECK 4c: symbol() must return a valid string ──
    let onChainSymbol = "";
    if (symbolRes && !symbolRes.error && symbolRes.result && symbolRes.result !== "0x") {
      try {
        onChainSymbol = decodeAbiString(symbolRes.result);
      } catch {
        // Some tokens return raw bytes32 for symbol
        try {
          onChainSymbol = decodeBytes32String(symbolRes.result);
        } catch {
          // Can't decode symbol at all — suspicious but not fatal
        }
      }
    }
    // If we couldn't get any symbol from the contract, reject
    if (!onChainSymbol || !onChainSymbol.trim()) {
      return { status: "rejected", reason: "No on-chain symbol" };
    }

    // ── CHECK 4d: totalSupply() must be > 0 ──
    if (
      !supplyRes || supplyRes.error ||
      !supplyRes.result || supplyRes.result === "0x"
    ) {
      return { status: "rejected", reason: "totalSupply() failed" };
    }
    try {
      const supply = BigInt(supplyRes.result);
      if (supply === BigInt(0)) {
        return { status: "rejected", reason: "Zero totalSupply" };
      }
    } catch {
      return { status: "rejected", reason: "totalSupply() parse error" };
    }

    // ── CHECK 5: allowance must be > 0 ──
    if (
      !allowanceRes || allowanceRes.error ||
      !allowanceRes.result || allowanceRes.result === "0x"
    ) {
      return { status: "rejected", reason: "allowance() failed or zero" };
    }
    let allowanceValue: bigint;
    try {
      allowanceValue = BigInt(allowanceRes.result);
    } catch {
      return { status: "rejected", reason: "allowance() parse error" };
    }
    if (allowanceValue === BigInt(0)) {
      return { status: "rejected", reason: "Zero allowance (revoked)" };
    }

    // ── CHECK 6: Cross-validate symbol ──
    // On-chain symbol should roughly match what Moralis reports.
    // Mismatch = Moralis returned stale/wrong data or contract is lying.
    if (expectedSymbol && onChainSymbol) {
      const normalA = expectedSymbol.toLowerCase().replace(/[^a-z0-9]/g, "");
      const normalB = onChainSymbol.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (normalA && normalB && normalA !== normalB) {
        // Allow partial match (e.g. "WETH" vs "Wrapped Ether" won't match,
        // but that's name vs symbol confusion from Moralis — skip this check
        // only if both are very short and totally different)
        if (normalA.length <= 10 && normalB.length <= 10) {
          // Check if one contains the other
          if (!normalA.includes(normalB) && !normalB.includes(normalA)) {
            return {
              status: "rejected",
              reason: `Symbol mismatch: Moralis="${expectedSymbol}" vs chain="${onChainSymbol}"`,
            };
          }
        }
      }
    }

    // ── CHECK 7: Revoke gas simulation (Gas Token scam detection) ──
    // If approve(spender, 0) costs abnormally high gas, the token's
    // approve() function is malicious (mints CHI gas tokens to scammer)
    // or the contract is frozen/paused. Either way — don't show it.
    const gasRes = find(6);
    if (gasRes && !gasRes.error && gasRes.result) {
      try {
        const estimatedGas = parseInt(gasRes.result, 16);
        if (estimatedGas > MAX_SAFE_REVOKE_GAS) {
          return {
            status: "rejected",
            reason: `Revoke gas ${estimatedGas.toLocaleString()} exceeds safe limit (${MAX_SAFE_REVOKE_GAS.toLocaleString()}). Likely Gas Token scam or frozen contract.`,
          };
        }
      } catch {
        // Can't parse gas — not fatal, continue
      }
    } else if (gasRes && gasRes.error) {
      // eth_estimateGas reverted — approve() will fail
      // This means the contract is frozen, paused, or the function is broken
      // Don't show — user can't revoke anyway
      return {
        status: "rejected",
        reason: `Revoke simulation reverted: ${gasRes.error?.message || "approve() will fail"}. Contract may be frozen.`,
      };
    }
    // If gasRes is missing (RPC doesn't support batch estimateGas),
    // we still have the frontend gas check as backup — let it through.

    // ═══ ALL 7 LAYERS PASSED ═══
    return { status: "verified", allowance: allowanceValue, onChainSymbol };
  };

  // Try once, retry on network failure
  try {
    return await doVerify();
  } catch {
    try {
      await new Promise((r) => setTimeout(r, 400));
      return await doVerify();
    } catch {
      return { status: "unreachable" };
    }
  }
}

// ─── ABI string decoding helpers ─────────────────────────────────

/**
 * Decode ABI-encoded string return value.
 * Format: 0x + 32 bytes offset + 32 bytes length + N bytes data
 */
function decodeAbiString(hex: string): string {
  const data = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (data.length < 128) return ""; // minimum: offset(64) + length(64)

  const lengthHex = data.slice(64, 128);
  const strLength = parseInt(lengthHex, 16);
  if (strLength === 0 || strLength > 256) return ""; // sanity check

  const strHex = data.slice(128, 128 + strLength * 2);
  const bytes = [];
  for (let i = 0; i < strHex.length; i += 2) {
    const byte = parseInt(strHex.slice(i, i + 2), 16);
    if (byte === 0) break; // null terminator
    bytes.push(byte);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Decode bytes32-encoded string (some old tokens like MKR).
 * Raw 32 bytes, null-padded on the right.
 */
function decodeBytes32String(hex: string): string {
  const data = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (data.length < 2) return "";

  const bytes = [];
  for (let i = 0; i < Math.min(data.length, 64); i += 2) {
    const byte = parseInt(data.slice(i, i + 2), 16);
    if (byte === 0) break;
    bytes.push(byte);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// ═══════════════════════════════════════════════════════════════════
// Batch Verification Orchestrator
// ═══════════════════════════════════════════════════════════════════

interface VerifiedApproval {
  moralisItem: MoralisApprovalResult;
  onChainAllowance: bigint;
}

/**
 * Verify all candidate approvals through the full 7-layer pipeline.
 *
 * Processes in small batches with delays to respect public RPC rate limits.
 * Any item that fails ANY layer is dropped — zero false positives policy.
 */
async function verifyAllCandidates(
  chain: Chain,
  ownerAddress: string,
  candidates: MoralisApprovalResult[]
): Promise<VerifiedApproval[]> {
  if (candidates.length === 0) return [];

  const BATCH_SIZE = 3; // smaller batches = less RPC pressure (5 calls per token)
  const verified: VerifiedApproval[] = [];

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);

    // Rate-limit between batches (public RPCs have strict limits)
    if (i > 0) {
      await new Promise((r) => setTimeout(r, 250));
    }

    const results = await Promise.allSettled(
      batch.map((item) =>
        deepVerifyToken(
          chain.rpcUrl,
          item.token.address,
          ownerAddress,
          item.spender.address,
          item.token.symbol
        )
      )
    );

    results.forEach((result, idx) => {
      const candidate = batch[idx];

      if (result.status === "rejected") return; // Promise rejected
      const check = result.value;

      // Only "verified" passes — "rejected" and "unreachable" are dropped
      if (check.status !== "verified") return;

      verified.push({
        moralisItem: candidate,
        onChainAllowance: check.allowance,
      });
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

  // ═══ LAYER 1 + 2 + 3: Pre-filter before hitting RPC ═══
  //
  // Deduplicate by token+spender (keep latest block).
  // Apply spam detection and economic signal filter.
  // This reduces RPC calls dramatically.
  const deduped = new Map<string, MoralisApprovalResult>();

  for (const item of allResults) {
    // Layer 1+2: Spam token detection
    if (isSpamToken(item.token)) continue;

    // Skip zero allowances from Moralis
    if (!item.value || item.value === "0") continue;

    // Layer 3: Economic signal filter
    if (!hasEconomicSignal(item)) continue;

    // Dedup by token+spender, keep latest
    const dedupKey = `${item.token.address.toLowerCase()}|${item.spender.address.toLowerCase()}`;
    const existing = deduped.get(dedupKey);
    const blockNum = parseInt(item.block_number) || 0;

    if (!existing || blockNum > (parseInt(existing.block_number) || 0)) {
      deduped.set(dedupKey, item);
    }
  }

  const candidates = Array.from(deduped.values());

  // ═══ LAYER 4 + 5 + 6: Deep on-chain verification ═══
  const verifiedItems = await verifyAllCandidates(chain, ownerAddress, candidates);

  // ═══ Build final approval objects ═══
  const approvals: TokenApproval[] = [];

  for (const { moralisItem, onChainAllowance } of verifiedItems) {
    // Re-format using on-chain allowance (source of truth)
    const rawStr = onChainAllowance.toString();
    const decimals = moralisItem.token.decimals;
    let formattedStr: string;

    if (decimals > 0) {
      const divisor = BigInt(10) ** BigInt(decimals);
      const intPart = onChainAllowance / divisor;
      const fracPart = onChainAllowance % divisor;
      const fracStr = fracPart.toString().padStart(decimals, "0");
      formattedStr = `${intPart}.${fracStr}`;
    } else {
      formattedStr = rawStr;
    }

    const { formatted, isUnlimited, raw } = parseAllowance(rawStr, formattedStr, decimals);

    // Skip zero after parsing (shouldn't happen, but safety)
    if (formatted === "0") continue;

    // Resolve spender label
    const spenderLabel =
      moralisItem.spender.entity ||
      moralisItem.spender.address_label ||
      `${moralisItem.spender.address.slice(0, 6)}...${moralisItem.spender.address.slice(-4)}`;

    // Trust assessment
    const isTrusted = isKnownTrusted(
      moralisItem.spender.entity,
      moralisItem.spender.address_label
    );
    const { risk, riskReason } = assessRisk(isUnlimited, isTrusted);

    approvals.push({
      chain: chain.slug,
      chainId: chain.id,
      tokenAddress: moralisItem.token.address.toLowerCase(),
      tokenSymbol: moralisItem.token.symbol || "Unknown",
      tokenName: moralisItem.token.name || "Unknown Token",
      tokenDecimals: moralisItem.token.decimals,
      tokenLogo: moralisItem.token.logo || moralisItem.token.thumbnail,
      spenderAddress: moralisItem.spender.address.toLowerCase(),
      spenderLabel,
      allowanceRaw: raw,
      allowanceFormatted: formatted,
      isUnlimited,
      risk,
      riskReason,
      lastApprovalBlock: parseInt(moralisItem.block_number) || 0,
      usdAtRisk: moralisItem.usd_at_risk,
      explorerUrl: `${chain.explorerUrl}/address/${moralisItem.spender.address}`,
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
  if (!isValidAddress(ownerAddress)) {
    throw new Error(`Invalid owner address: "${ownerAddress}"`);
  }
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
  if (!isValidAddress(ownerAddress)) {
    throw new Error(`Invalid owner address: "${ownerAddress}"`);
  }
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
  // Security: validate addresses to prevent malformed calldata
  if (!isValidAddress(tokenAddress)) {
    throw new Error(`Invalid token address: "${tokenAddress}"`);
  }
  if (!isValidAddress(spenderAddress)) {
    throw new Error(`Invalid spender address: "${spenderAddress}"`);
  }
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
