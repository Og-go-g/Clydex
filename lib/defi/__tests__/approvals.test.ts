import { describe, test, expect } from "vitest";
import { buildRevokeTransaction } from "@/lib/defi/approvals";

const VALID_TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const VALID_SPENDER = "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28";
const CHAIN_ID = 1;

describe("buildRevokeTransaction", () => {
  test("returns correct `to` field (token address)", () => {
    const tx = buildRevokeTransaction(VALID_TOKEN, VALID_SPENDER, CHAIN_ID);
    expect(tx.to).toBe(VALID_TOKEN);
  });

  test("data starts with approve selector 0x095ea7b3", () => {
    const tx = buildRevokeTransaction(VALID_TOKEN, VALID_SPENDER, CHAIN_ID);
    expect(tx.data.startsWith("0x095ea7b3")).toBe(true);
  });

  test("value is 0x0", () => {
    const tx = buildRevokeTransaction(VALID_TOKEN, VALID_SPENDER, CHAIN_ID);
    expect(tx.value).toBe("0x0");
  });

  test("data has correct length (10 + 64 + 64 = 138 chars)", () => {
    const tx = buildRevokeTransaction(VALID_TOKEN, VALID_SPENDER, CHAIN_ID);
    // "0x" + 8 selector + 64 spender + 64 amount = 138
    expect(tx.data.length).toBe(138);
  });

  test("data ends with 64 zeros (revoke sets allowance to 0)", () => {
    const tx = buildRevokeTransaction(VALID_TOKEN, VALID_SPENDER, CHAIN_ID);
    const last64 = tx.data.slice(-64);
    expect(last64).toBe("0".repeat(64));
  });

  test("throws for invalid token address", () => {
    expect(() =>
      buildRevokeTransaction("0xinvalid", VALID_SPENDER, CHAIN_ID)
    ).toThrow("Invalid token address");
  });

  test("throws for invalid spender address", () => {
    expect(() =>
      buildRevokeTransaction(VALID_TOKEN, "0xinvalid", CHAIN_ID)
    ).toThrow("Invalid spender address");
  });
});
