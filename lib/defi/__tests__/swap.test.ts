import { describe, test, expect } from "vitest";
import { getSwapQuote, getSwapCalldata } from "@/lib/defi/swap";

// ─── getSwapQuote — input validation ────────────────────────────

describe("getSwapQuote validation", () => {
  const userAddr = "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28";

  test("rejects non-numeric amount", async () => {
    await expect(
      getSwapQuote("ETH", "USDC", "abc", userAddr)
    ).rejects.toThrow("Invalid swap amount");
  });

  test("rejects negative amount", async () => {
    await expect(
      getSwapQuote("ETH", "USDC", "-1", userAddr)
    ).rejects.toThrow("Invalid swap amount");
  });

  test("rejects zero amount", async () => {
    await expect(
      getSwapQuote("ETH", "USDC", "0", userAddr)
    ).rejects.toThrow("Invalid swap amount");
  });

  test("rejects swapping a token for itself", async () => {
    await expect(
      getSwapQuote("ETH", "ETH", "1", userAddr)
    ).rejects.toThrow("Cannot swap a token for itself");
  });

  test("rejects unknown token symbol", async () => {
    await expect(
      getSwapQuote("FAKETOKEN", "USDC", "1", userAddr)
    ).rejects.toThrow("Unknown token");
  });
});

// ─── getSwapCalldata — input validation ─────────────────────────

describe("getSwapCalldata validation", () => {
  const userAddr = "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28";

  test("rejects slippage below minimum (0)", async () => {
    await expect(
      getSwapCalldata("ETH", "USDC", "1", userAddr, 0)
    ).rejects.toThrow("Slippage out of safe range");
  });

  test("rejects slippage above maximum (51)", async () => {
    await expect(
      getSwapCalldata("ETH", "USDC", "1", userAddr, 51)
    ).rejects.toThrow("Slippage out of safe range");
  });

  test("rejects NaN slippage", async () => {
    await expect(
      getSwapCalldata("ETH", "USDC", "1", userAddr, NaN)
    ).rejects.toThrow("Slippage out of safe range");
  });

  test("rejects unknown provider name", async () => {
    await expect(
      getSwapCalldata("ETH", "USDC", "1", userAddr, 1, "fakeProvider")
    ).rejects.toThrow('Provider "fakeProvider" not available');
  });
});
