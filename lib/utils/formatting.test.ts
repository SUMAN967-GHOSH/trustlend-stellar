import { describe, it, expect } from "vitest";
import {
  formatCurrency,
  formatXlm,
  formatXlmPrecise,
  formatXlmCompact,
  formatTokenBalance,
  formatTokenAmount,
  formatApr,
} from "./formatting";

// All tests pin "en-US" behaviour.  The getLocale() helper returns "en-US"
// when navigator is undefined (Node / Vitest environment), so these assertions
// are stable across CI and local runs.

describe("formatCurrency", () => {
  it("formats a normal number with 2 dp and thousands separator", () => {
    expect(formatCurrency(1234.56)).toBe("1,234.56 XLM");
    expect(formatCurrency(100)).toBe("100.00 XLM");
    expect(formatCurrency(0)).toBe("0.00 XLM");
  });

  it("handles large numbers with multiple comma groups", () => {
    expect(formatCurrency(1234567.89)).toBe("1,234,567.89 XLM");
  });

  it("rounds to 2 decimal places", () => {
    expect(formatCurrency(1.005)).toBe("1.01 XLM");
    expect(formatCurrency(1.004)).toBe("1.00 XLM");
  });
});

describe("formatXlm", () => {
  it("is an alias for formatCurrency", () => {
    expect(formatXlm(9876.5)).toBe(formatCurrency(9876.5));
    expect(formatXlm(0)).toBe("0.00 XLM");
  });
});

describe("formatXlmPrecise", () => {
  it("shows up to 4 decimal places", () => {
    expect(formatXlmPrecise(12.3456789)).toBe("12.3457 XLM");
    expect(formatXlmPrecise(0.001)).toBe("0.0010 XLM");
  });

  it("still shows at least 2 decimal places for whole numbers", () => {
    expect(formatXlmPrecise(100)).toBe("100.00 XLM");
  });

  it("includes thousands separators", () => {
    expect(formatXlmPrecise(1234567.8901)).toBe("1,234,567.8901 XLM");
  });
});

describe("formatXlmCompact", () => {
  it("abbreviates billions", () => {
    expect(formatXlmCompact(2_500_000_000)).toBe("2.50B XLM");
  });

  it("abbreviates millions", () => {
    expect(formatXlmCompact(1_234_567)).toBe("1.23M XLM");
  });

  it("abbreviates thousands", () => {
    expect(formatXlmCompact(1_234)).toBe("1.23K XLM");
  });

  it("does not abbreviate values below 1 000", () => {
    expect(formatXlmCompact(500)).toBe("500.00 XLM");
    expect(formatXlmCompact(0)).toBe("0.00 XLM");
  });
});

describe("formatTokenBalance", () => {
  it("converts stroops to XLM using default 7 decimals", () => {
    expect(formatTokenBalance(10_000_000)).toBe("1.00 XLM");   // 1 XLM
    expect(formatTokenBalance(25_000_000)).toBe("2.50 XLM");   // 2.5 XLM
    expect(formatTokenBalance(123_456_789)).toBe("12.35 XLM"); // 12.3456789 rounded
  });

  it("includes thousands separators for large stroops values", () => {
    expect(formatTokenBalance(1_000_000_000_000)).toBe("100,000.00 XLM");
  });

  it("supports custom decimals", () => {
    expect(formatTokenBalance(1000, 2)).toBe("10.00 XLM"); // 1000 / 10^2
  });

  it("handles zero", () => {
    expect(formatTokenBalance(0)).toBe("0.00 XLM");
  });
});

describe("formatTokenAmount", () => {
  it("formats USDC with 2 decimal places by default", () => {
    expect(formatTokenAmount(1234567.89, "USDC")).toBe("1,234,567.89 USDC");
  });

  it("formats XLM with the provided symbol", () => {
    expect(formatTokenAmount(9876.5, "XLM")).toBe("9,876.50 XLM");
  });

  it("respects a custom decimals argument", () => {
    expect(formatTokenAmount(0.000123, "USDC", 6)).toBe("0.000123 USDC");
  });

  it("handles zero", () => {
    expect(formatTokenAmount(0, "USDT")).toBe("0.00 USDT");
  });
});

describe("formatApr", () => {
  it("converts basis points to a percentage string", () => {
    expect(formatApr(1500)).toBe("15.00%");
    expect(formatApr(725)).toBe("7.25%");
    expect(formatApr(10)).toBe("0.10%");
    expect(formatApr(0)).toBe("0.00%");
  });

  it("formats large APR values with thousands separators", () => {
    expect(formatApr(100_000)).toBe("1,000.00%");
  });
});
