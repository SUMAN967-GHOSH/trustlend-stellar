import { describe, expect, it } from "vitest";
import {
  computeHealthFactor,
  getHealthFactorZone,
  getHealthFactorColor,
  getHealthFactorLabel,
  simulateHealthFactor,
  healthFactorToArcPosition,
  HF_SAFE_THRESHOLD,
  HF_WARNING_THRESHOLD,
} from "@/lib/dashboard/health-factor";

describe("computeHealthFactor", () => {
  it("returns the ratio of collateral to debt", () => {
    expect(computeHealthFactor({ collateralValueUsd: 200, debtValueUsd: 100 })).toBe(2);
  });

  it("returns Infinity when debt is zero", () => {
    expect(computeHealthFactor({ collateralValueUsd: 100, debtValueUsd: 0 })).toBe(Infinity);
  });

  it("returns Infinity when debt is negative", () => {
    expect(computeHealthFactor({ collateralValueUsd: 100, debtValueUsd: -5 })).toBe(Infinity);
  });

  it("returns 0 when collateral is zero and debt is positive", () => {
    expect(computeHealthFactor({ collateralValueUsd: 0, debtValueUsd: 100 })).toBe(0);
  });

  it("returns 0 when collateral is negative and debt is positive", () => {
    expect(computeHealthFactor({ collateralValueUsd: -10, debtValueUsd: 100 })).toBe(0);
  });

  it("handles fractional ratios", () => {
    const hf = computeHealthFactor({ collateralValueUsd: 50, debtValueUsd: 100 });
    expect(hf).toBeCloseTo(0.5);
  });
});

describe("getHealthFactorZone", () => {
  it("returns 'critical' for HF < 1.1", () => {
    expect(getHealthFactorZone(0)).toBe("critical");
    expect(getHealthFactorZone(0.5)).toBe("critical");
    expect(getHealthFactorZone(1.0)).toBe("critical");
    expect(getHealthFactorZone(1.09)).toBe("critical");
  });

  it("returns 'warning' for HF between 1.1 and 1.5 (inclusive lower bound)", () => {
    expect(getHealthFactorZone(HF_WARNING_THRESHOLD)).toBe("warning");
    expect(getHealthFactorZone(1.3)).toBe("warning");
    expect(getHealthFactorZone(1.49)).toBe("warning");
  });

  it("returns 'safe' for HF >= 1.5", () => {
    expect(getHealthFactorZone(HF_SAFE_THRESHOLD)).toBe("safe");
    expect(getHealthFactorZone(2.0)).toBe("safe");
    expect(getHealthFactorZone(10)).toBe("safe");
  });

  it("returns 'safe' for Infinity (no debt)", () => {
    expect(getHealthFactorZone(Infinity)).toBe("safe");
  });
});

describe("getHealthFactorColor", () => {
  it("returns green for safe zone", () => {
    expect(getHealthFactorColor(2.0)).toBe("#22cf9d");
  });

  it("returns amber for warning zone", () => {
    expect(getHealthFactorColor(1.3)).toBe("#f59e0b");
  });

  it("returns red for critical zone", () => {
    expect(getHealthFactorColor(0.8)).toBe("#ef4444");
  });
});

describe("getHealthFactorLabel", () => {
  it("returns the correct label per zone", () => {
    expect(getHealthFactorLabel(2.0)).toBe("Safe");
    expect(getHealthFactorLabel(1.3)).toBe("Warning — Low Buffer");
    expect(getHealthFactorLabel(0.5)).toBe("Critical — Liquidation Risk");
  });
});

describe("simulateHealthFactor", () => {
  const base = { collateralValueUsd: 150, debtValueUsd: 100 };

  it("returns baseline HF when deltas are zero", () => {
    expect(simulateHealthFactor(base, 0, 0)).toBe(1.5);
  });

  it("increases HF when adding collateral", () => {
    expect(simulateHealthFactor(base, 50, 0)).toBe(2.0);
  });

  it("decreases HF when adding debt", () => {
    expect(simulateHealthFactor(base, 0, 50)).toBe(1.0);
  });

  it("handles both deltas simultaneously", () => {
    // collateral 200, debt 150 → HF ≈ 1.333
    const hf = simulateHealthFactor(base, 50, 50);
    expect(hf).toBeCloseTo(200 / 150);
  });

  it("clamps collateral to zero (no negative collateral)", () => {
    const hf = simulateHealthFactor(base, -200, 0);
    expect(hf).toBe(0);
  });

  it("returns Infinity when debt is reduced to zero", () => {
    expect(simulateHealthFactor(base, 0, -100)).toBe(Infinity);
  });
});

describe("healthFactorToArcPosition", () => {
  it("returns 0 for HF = 0", () => {
    expect(healthFactorToArcPosition(0)).toBe(0);
  });

  it("returns 1 for HF >= 3", () => {
    expect(healthFactorToArcPosition(3)).toBeCloseTo(1);
    expect(healthFactorToArcPosition(5)).toBeCloseTo(1);
  });

  it("returns 1 for Infinity", () => {
    expect(healthFactorToArcPosition(Infinity)).toBe(1);
  });

  it("returns a value between 0 and 1 for typical HF", () => {
    const pos = healthFactorToArcPosition(1.5);
    expect(pos).toBeGreaterThan(0);
    expect(pos).toBeLessThan(1);
  });

  it("is monotonically increasing", () => {
    const a = healthFactorToArcPosition(0.5);
    const b = healthFactorToArcPosition(1.0);
    const c = healthFactorToArcPosition(2.0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});
