import { describe, expect, it } from "vitest";
import {
  computeUtilization,
  computeFloatingRate,
  computeFixedRate,
  calculateSwitchFee,
  canSwitchRateModel,
  recalculateRemainingInterest,
  formatRateModelLabel,
  getRateModelColor,
  bpsToPercent,
  FLOATING_BASE_RATE_BPS,
  FLOATING_SLOPE_BPS,
  RATE_SWITCH_FEE_BPS,
  RATE_SWITCH_COOLDOWN_SECS,
  MIN_FLOATING_RATE_BPS,
  MAX_FLOATING_RATE_BPS,
} from "@/lib/dashboard/interest-rates";

describe("computeUtilization", () => {
  it("returns 0 when totalLiquidity is zero", () => {
    expect(computeUtilization(100, 0)).toBe(0);
  });

  it("returns 0 when totalLiquidity is negative", () => {
    expect(computeUtilization(100, -50)).toBe(0);
  });

  it("returns 0 when nothing is borrowed", () => {
    expect(computeUtilization(0, 1000)).toBe(0);
  });

  it("returns correct utilization ratio", () => {
    expect(computeUtilization(500, 1000)).toBe(0.5);
  });

  it("clamps to 1 when over-utilized", () => {
    expect(computeUtilization(1500, 1000)).toBe(1);
  });

  it("handles 100% utilization", () => {
    expect(computeUtilization(1000, 1000)).toBe(1);
  });
});

describe("computeFloatingRate", () => {
  it("returns base rate at zero utilization", () => {
    const rate = computeFloatingRate({ totalBorrowed: 0, totalLiquidity: 1000 });
    expect(rate).toBe(FLOATING_BASE_RATE_BPS);
  });

  it("returns base + slope at 100% utilization", () => {
    const rate = computeFloatingRate({ totalBorrowed: 1000, totalLiquidity: 1000 });
    expect(rate).toBe(FLOATING_BASE_RATE_BPS + FLOATING_SLOPE_BPS);
  });

  it("returns base + half slope at 50% utilization", () => {
    const rate = computeFloatingRate({ totalBorrowed: 500, totalLiquidity: 1000 });
    expect(rate).toBe(FLOATING_BASE_RATE_BPS + Math.floor(0.5 * FLOATING_SLOPE_BPS));
  });

  it("respects minimum rate floor", () => {
    const rate = computeFloatingRate({
      totalBorrowed: 0,
      totalLiquidity: 1000,
      baseRateBps: 50, // very low base
      slopeBps: 100,
    });
    expect(rate).toBe(MIN_FLOATING_RATE_BPS);
  });

  it("respects maximum rate ceiling", () => {
    const rate = computeFloatingRate({
      totalBorrowed: 1000,
      totalLiquidity: 1000,
      baseRateBps: 4000,
      slopeBps: 3000,
    });
    expect(rate).toBe(MAX_FLOATING_RATE_BPS);
  });

  it("allows custom base and slope", () => {
    const rate = computeFloatingRate({
      totalBorrowed: 500,
      totalLiquidity: 1000,
      baseRateBps: 300,
      slopeBps: 1000,
    });
    // 300 + floor(0.5 * 1000) = 300 + 500 = 800
    expect(rate).toBe(800);
  });

  it("returns minimum when pool is empty", () => {
    const rate = computeFloatingRate({ totalBorrowed: 0, totalLiquidity: 0 });
    expect(rate).toBe(FLOATING_BASE_RATE_BPS);
  });
});

describe("computeFixedRate", () => {
  it("adds a 50 bps premium over the equivalent floating rate", () => {
    const floatingAt50 = FLOATING_BASE_RATE_BPS + Math.floor(0.5 * FLOATING_SLOPE_BPS);
    const fixed = computeFixedRate(0.5);
    expect(fixed).toBe(floatingAt50 + 50);
  });

  it("returns minimum rate floor for very low utilization", () => {
    const fixed = computeFixedRate(0, 50, 100);
    // 50 + 0 + 50 = 100, but min is 200
    expect(fixed).toBe(MIN_FLOATING_RATE_BPS);
  });

  it("clamps utilization to [0, 1]", () => {
    const fixedNeg = computeFixedRate(-0.5);
    const fixedZero = computeFixedRate(0);
    expect(fixedNeg).toBe(fixedZero);

    const fixedOver = computeFixedRate(1.5);
    const fixedOne = computeFixedRate(1.0);
    expect(fixedOver).toBe(fixedOne);
  });
});

describe("calculateSwitchFee", () => {
  it("calculates 0.5% of remaining debt", () => {
    // 10,000 XLM in stroops = 100_000_000_000
    const remaining = 100_000_000_000n;
    const fee = calculateSwitchFee(remaining);
    // 0.5% = 50/10000 = remaining * 50 / 10000
    expect(fee).toBe(remaining * BigInt(RATE_SWITCH_FEE_BPS) / 10_000n);
    expect(fee).toBe(500_000_000n); // 50 XLM
  });

  it("returns 0 for zero debt", () => {
    expect(calculateSwitchFee(0n)).toBe(0n);
  });

  it("returns 0 for negative debt", () => {
    expect(calculateSwitchFee(-100n)).toBe(0n);
  });

  it("handles small amounts correctly", () => {
    // 1 XLM = 10_000_000 stroops
    const fee = calculateSwitchFee(10_000_000n);
    // 10_000_000 * 50 / 10000 = 50_000 stroops
    expect(fee).toBe(50_000n);
  });
});

describe("canSwitchRateModel", () => {
  it("allows switch when never switched before (timestamp 0)", () => {
    const result = canSwitchRateModel(0, 1000000);
    expect(result.allowed).toBe(true);
    expect(result.remainingSeconds).toBe(0);
  });

  it("allows switch after cooldown has elapsed", () => {
    const now = 200_000;
    const lastSwitch = now - RATE_SWITCH_COOLDOWN_SECS - 1;
    const result = canSwitchRateModel(lastSwitch, now);
    expect(result.allowed).toBe(true);
    expect(result.remainingSeconds).toBe(0);
  });

  it("allows switch at exactly the cooldown boundary", () => {
    const now = 200_000;
    const lastSwitch = now - RATE_SWITCH_COOLDOWN_SECS;
    const result = canSwitchRateModel(lastSwitch, now);
    expect(result.allowed).toBe(true);
  });

  it("blocks switch during cooldown", () => {
    const now = 100_000;
    const lastSwitch = now - 3600; // 1 hour ago
    const result = canSwitchRateModel(lastSwitch, now);
    expect(result.allowed).toBe(false);
    expect(result.remainingSeconds).toBe(RATE_SWITCH_COOLDOWN_SECS - 3600);
  });

  it("reports correct remaining seconds", () => {
    const now = 100_000;
    const lastSwitch = now - 43200; // 12 hours ago
    const result = canSwitchRateModel(lastSwitch, now);
    expect(result.allowed).toBe(false);
    expect(result.remainingSeconds).toBe(86400 - 43200); // 12 hours remaining
  });
});

describe("recalculateRemainingInterest", () => {
  it("calculates interest correctly for a standard case", () => {
    // 1000 XLM principal, 10% rate, 30 days
    const principal = 1_000_0000000n; // 1000 XLM in stroops
    const interest = recalculateRemainingInterest({
      remainingPrincipalStroops: principal,
      newRateBps: 1000,
      remainingDays: 30,
    });
    // 1000_0000000 * 1000 * 30 / (10000 * 365) = 8_219_178_082n (truncated)
    const expected = (principal * 1000n * 30n) / (10_000n * 365n);
    expect(interest).toBe(expected);
  });

  it("returns 0 for zero principal", () => {
    expect(
      recalculateRemainingInterest({
        remainingPrincipalStroops: 0n,
        newRateBps: 1000,
        remainingDays: 30,
      }),
    ).toBe(0n);
  });

  it("returns 0 for zero rate", () => {
    expect(
      recalculateRemainingInterest({
        remainingPrincipalStroops: 1000n,
        newRateBps: 0,
        remainingDays: 30,
      }),
    ).toBe(0n);
  });

  it("returns 0 for zero remaining days", () => {
    expect(
      recalculateRemainingInterest({
        remainingPrincipalStroops: 1000n,
        newRateBps: 1000,
        remainingDays: 0,
      }),
    ).toBe(0n);
  });

  it("handles full year correctly", () => {
    const principal = 10_000_0000000n;
    const interest = recalculateRemainingInterest({
      remainingPrincipalStroops: principal,
      newRateBps: 1500, // 15%
      remainingDays: 365,
    });
    // Full annual: principal * 1500 / 10000 = 1500 XLM
    expect(interest).toBe(principal * 1500n / 10_000n);
  });
});

describe("formatRateModelLabel", () => {
  it("returns 'Fixed Rate' for Fixed", () => {
    expect(formatRateModelLabel("Fixed")).toBe("Fixed Rate");
  });

  it("returns 'Floating Rate' for Floating", () => {
    expect(formatRateModelLabel("Floating")).toBe("Floating Rate");
  });
});

describe("getRateModelColor", () => {
  it("returns purple for Fixed", () => {
    expect(getRateModelColor("Fixed")).toBe("#7e2fd0");
  });

  it("returns teal for Floating", () => {
    expect(getRateModelColor("Floating")).toBe("#22cf9d");
  });
});

describe("bpsToPercent", () => {
  it("formats 1500 bps as '15.00%'", () => {
    expect(bpsToPercent(1500)).toBe("15.00%");
  });

  it("formats 50 bps as '0.50%'", () => {
    expect(bpsToPercent(50)).toBe("0.50%");
  });

  it("formats 0 bps as '0.00%'", () => {
    expect(bpsToPercent(0)).toBe("0.00%");
  });
});
