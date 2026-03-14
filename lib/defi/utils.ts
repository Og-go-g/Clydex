import { BASE_RPCS, OPENOCEAN } from "./constants";

// Shared DeFi utilities — used by all providers

/**
 * Convert human-readable amount to raw units (smallest denomination).
 * E.g. parseUnits("1.5", 18) → "1500000000000000000"
 */
export function parseUnits(value: string, decimals: number): string {
  // Security: reject negative, non-numeric, and malformed input
  // to prevent uint256 wraparound (negative → 2^256-N → unlimited approval)
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Invalid amount: "${value}". Must be a positive decimal number.`);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  const result = BigInt(whole + paddedFraction).toString();
  if (result === "0") {
    throw new Error("Amount must be greater than zero.");
  }
  return result;
}

/**
 * Convert raw units to human-readable amount.
 * E.g. formatUnits("1500000000000000000", 18) → "1.5"
 */
export function formatUnits(value: string, decimals: number): string {
  // Security: reject negative values to prevent display corruption
  if (value.startsWith("-")) {
    throw new Error(`Cannot format negative value: "${value}"`);
  }
  const str = value.padStart(decimals + 1, "0");
  const whole = str.slice(0, str.length - decimals) || "0";
  const fraction = str.slice(str.length - decimals);
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

// --- Address validation ---

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isValidAddress(address: string): boolean {
  return ETH_ADDRESS_RE.test(address);
}

export function assertValidAddress(address: string, label = "Address"): void {
  if (!isValidAddress(address)) {
    throw new Error(`${label} is not a valid Ethereum address: "${address}"`);
  }
}

// --- RPC with fallback ---

const RPC_TIMEOUT = 6_000;

interface RpcResponse {
  jsonrpc: string;
  id: number;
  result?: string;
  error?: { message: string; code?: number };
}

/**
 * Send a JSON-RPC call with automatic fallback across BASE_RPCS.
 * Tries each endpoint in order; throws only if ALL fail.
 */
async function rpcCall(method: string, params: unknown[]): Promise<string> {
  let lastError: Error | null = null;

  for (const rpc of BASE_RPCS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT);

    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      const data: RpcResponse = await res.json();
      if (data.error) throw new Error(data.error.message);
      return data.result ?? "";
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Try next RPC endpoint
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("All RPC endpoints failed");
}

// --- On-chain balance fetching ---

/**
 * Fetch native ETH balance or ERC-20 balance for a wallet on Base.
 * Returns raw balance string (in smallest units, e.g. wei).
 */
export async function getTokenBalance(
  tokenAddress: string,
  ownerAddress: string
): Promise<string> {
  assertValidAddress(ownerAddress, "Owner address");

  const isNative =
    !tokenAddress ||
    tokenAddress.toLowerCase() === OPENOCEAN.NATIVE_ETH_ADDRESS.toLowerCase();

  if (isNative) {
    const result = await rpcCall("eth_getBalance", [ownerAddress, "latest"]);
    return BigInt(result).toString();
  }

  assertValidAddress(tokenAddress, "Token address");

  // ERC-20 balanceOf(address) — selector 0x70a08231
  const paddedOwner = ownerAddress.slice(2).toLowerCase().padStart(64, "0");
  const callData = `0x70a08231${paddedOwner}`;

  const result = await rpcCall("eth_call", [
    { to: tokenAddress, data: callData },
    "latest",
  ]);
  return BigInt(result).toString();
}

// --- Transaction simulation ---

/**
 * Dry-run a swap transaction via eth_call (no gas spent).
 * Returns { success: true } if the tx would succeed on-chain,
 * or { success: false, reason } if it would revert.
 *
 * Fail-closed: if RPC is unreachable, blocks the swap rather than
 * allowing a potentially bad transaction through.
 */
export async function simulateSwap(
  from: string,
  tx: { to: string; data: string; value: string }
): Promise<{ success: true } | { success: false; reason: string }> {
  try {
    await rpcCall("eth_call", [
      { from, to: tx.to, data: tx.data, value: tx.value },
      "latest",
    ]);

    // Simulation passed
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // RPC-level errors (timeout, network) vs on-chain reverts
    const isRpcIssue =
      message.includes("abort") ||
      message.includes("fetch") ||
      message.includes("All RPC");

    if (isRpcIssue) {
      console.warn("[simulate] RPC issue:", message);
      return {
        success: false,
        reason: "Could not verify transaction safety. Please try again.",
      };
    }

    console.warn("[simulate] Revert detected:", message);
    return { success: false, reason: message || "Transaction would revert" };
  }
}
