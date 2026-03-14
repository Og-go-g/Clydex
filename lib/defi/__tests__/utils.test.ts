import { describe, test, expect } from "vitest";
import {
  parseUnits,
  formatUnits,
  isValidAddress,
  assertValidAddress,
} from "@/lib/defi/utils";

// ─── parseUnits ─────────────────────────────────────────────────

describe("parseUnits", () => {
  test("converts 1.5 with 18 decimals", () => {
    expect(parseUnits("1.5", 18)).toBe("1500000000000000000");
  });

  test("converts whole number 100 with 18 decimals", () => {
    expect(parseUnits("100", 18)).toBe("100000000000000000000");
  });

  test("converts small decimal 0.001 with 18 decimals", () => {
    expect(parseUnits("0.001", 18)).toBe("1000000000000000");
  });

  test("converts 1.5 with 6 decimals (USDC)", () => {
    expect(parseUnits("1.5", 6)).toBe("1500000");
  });

  test("rejects negative value", () => {
    expect(() => parseUnits("-1", 18)).toThrow("Invalid amount");
  });

  test("rejects non-numeric text", () => {
    expect(() => parseUnits("abc", 18)).toThrow("Invalid amount");
  });

  test("rejects empty string", () => {
    expect(() => parseUnits("", 18)).toThrow("Invalid amount");
  });

  test("rejects zero amount", () => {
    expect(() => parseUnits("0", 18)).toThrow("greater than zero");
  });

  test("rejects scientific notation", () => {
    expect(() => parseUnits("1e18", 18)).toThrow("Invalid amount");
  });

  test("rejects leading spaces", () => {
    expect(() => parseUnits(" 1", 18)).toThrow("Invalid amount");
  });
});

// ─── formatUnits ────────────────────────────────────────────────

describe("formatUnits", () => {
  test("formats 1500000000000000000 with 18 decimals to 1.5", () => {
    expect(formatUnits("1500000000000000000", 18)).toBe("1.5");
  });

  test("formats 1000000 with 6 decimals to 1", () => {
    expect(formatUnits("1000000", 6)).toBe("1");
  });

  test("formats 0 with 18 decimals to 0", () => {
    expect(formatUnits("0", 18)).toBe("0");
  });

  test("rejects negative value", () => {
    expect(() => formatUnits("-100", 18)).toThrow();
  });
});

// ─── isValidAddress ─────────────────────────────────────────────

describe("isValidAddress", () => {
  test("returns true for valid address", () => {
    expect(isValidAddress("0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28")).toBe(
      true
    );
  });

  test("returns false for too-short address", () => {
    expect(isValidAddress("0x742d")).toBe(false);
  });

  test("returns false for address without 0x prefix", () => {
    expect(
      isValidAddress("742d35Cc6634C0532925a3b844Bc9e7595f2bD28")
    ).toBe(false);
  });

  test("returns false for address with invalid characters", () => {
    expect(
      isValidAddress("0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ")
    ).toBe(false);
  });
});

// ─── assertValidAddress ─────────────────────────────────────────

describe("assertValidAddress", () => {
  test("does not throw for valid address", () => {
    expect(() =>
      assertValidAddress("0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28")
    ).not.toThrow();
  });

  test("throws with label for invalid address", () => {
    expect(() => assertValidAddress("0xinvalid", "Token")).toThrow("Token");
  });
});
