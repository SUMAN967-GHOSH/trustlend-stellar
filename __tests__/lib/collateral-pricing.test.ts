import { describe, it, expect } from "vitest";
import {
  ASSUMED_COLLATERAL_RATIO,
  DASHBOARD_PRICE_STALE_AFTER_MS,
  FALLBACK_XLM_PRICE_USD,
  STROOPS_PER_XLM,
  computeHealthFactorValuation,
  fallbackDashboardPrice,
  fetchDashboardPrice,
  resolveDashboardPrice,
} from "@/lib/dashboard/collateral-pricing";
import type { PriceOrigin } from "@/lib/oracle/prices";

const livePrice = (priceUsd: number, ageMs = 0) =>
  resolveDashboardPrice("XLM", { priceUsd, origin: "live", ageMs });

/** 100 XLM of outstanding debt, expressed in stroops. */
const ONE_HUNDRED_XLM = [100 * STROOPS_PER_XLM];

describe("collateral-pricing — the valuation now tracks the market", () => {
  // This is the defect issue #323 describes: with a hardcoded price the USD
  // figures were identical regardless of what XLM was actually worth.
  it.each([0.08, 0.1, 0.12, 0.25, 0.4])(
    "values 100 XLM of debt at $%s per XLM",
    (priceUsd) => {
      const result = computeHealthFactorValuation({
        outstandingStroops: ONE_HUNDRED_XLM,
        price: livePrice(priceUsd),
      });
      expect(result.totalDebtUsd).toBeCloseTo(100 * priceUsd, 10);
    },
  );

  it("doubles the USD debt when the price doubles", () => {
    const cheap = computeHealthFactorValuation({
      outstandingStroops: ONE_HUNDRED_XLM,
      price: livePrice(0.1),
    });
    const dear = computeHealthFactorValuation({
      outstandingStroops: ONE_HUNDRED_XLM,
      price: livePrice(0.2),
    });
    expect(dear.totalDebtUsd).toBeCloseTo(cheap.totalDebtUsd * 2, 10);
  });

  it("scales collateral with the price too", () => {
    const result = computeHealthFactorValuation({
      outstandingStroops: ONE_HUNDRED_XLM,
      price: livePrice(0.25),
    });
    expect(result.totalCollateralUsd).toBeCloseTo(100 * 0.25 * ASSUMED_COLLATERAL_RATIO, 10);
  });

  it("keeps the collateral-to-debt ratio price-invariant", () => {
    // The health factor itself depends on the ratio, so it should not move with
    // price while collateral remains a multiple of debt.
    for (const priceUsd of [0.05, 0.5, 5]) {
      const result = computeHealthFactorValuation({
        outstandingStroops: ONE_HUNDRED_XLM,
        price: livePrice(priceUsd),
      });
      expect(result.totalCollateralUsd / result.totalDebtUsd).toBeCloseTo(
        ASSUMED_COLLATERAL_RATIO,
        10,
      );
    }
  });

  it("honours a collateral ratio override", () => {
    const result = computeHealthFactorValuation({
      outstandingStroops: ONE_HUNDRED_XLM,
      price: livePrice(0.2),
      collateralRatio: 2,
    });
    expect(result.totalCollateralUsd).toBeCloseTo(100 * 0.2 * 2, 10);
  });

  it("reports that collateral is still an assumption", () => {
    const result = computeHealthFactorValuation({
      outstandingStroops: ONE_HUNDRED_XLM,
      price: livePrice(0.12),
    });
    expect(result.collateralIsAssumed).toBe(true);
  });
});

describe("collateral-pricing — debt aggregation", () => {
  it("converts stroops to XLM the way the page previously did", () => {
    const result = computeHealthFactorValuation({
      outstandingStroops: [1_234_567_890],
      price: livePrice(1),
    });
    expect(result.totalDebtXlm).toBeCloseTo(1_234_567_890 / 10_000_000, 10);
  });

  it("sums across several active loans", () => {
    const result = computeHealthFactorValuation({
      outstandingStroops: [50 * STROOPS_PER_XLM, 25 * STROOPS_PER_XLM],
      price: livePrice(0.2),
    });
    expect(result.totalDebtXlm).toBeCloseTo(75, 10);
    expect(result.totalDebtUsd).toBeCloseTo(15, 10);
  });

  it("ignores fully repaid and negative entries", () => {
    const result = computeHealthFactorValuation({
      outstandingStroops: [50 * STROOPS_PER_XLM, 0, -10 * STROOPS_PER_XLM],
      price: livePrice(0.2),
    });
    expect(result.totalDebtXlm).toBeCloseTo(50, 10);
  });

  it("ignores non-finite entries rather than poisoning the total", () => {
    const result = computeHealthFactorValuation({
      outstandingStroops: [
        50 * STROOPS_PER_XLM,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        undefined as unknown as number,
      ],
      price: livePrice(0.2),
    });
    expect(Number.isFinite(result.totalDebtUsd)).toBe(true);
    expect(result.totalDebtXlm).toBeCloseTo(50, 10);
  });

  it("hides the gauge when there is no outstanding debt", () => {
    expect(
      computeHealthFactorValuation({ outstandingStroops: [], price: livePrice(0.12) })
        .showHealthFactor,
    ).toBe(false);
    expect(
      computeHealthFactorValuation({ outstandingStroops: [0, -5], price: livePrice(0.12) })
        .showHealthFactor,
    ).toBe(false);
  });

  it("reports zero collateral when there is no debt", () => {
    const result = computeHealthFactorValuation({
      outstandingStroops: [],
      price: livePrice(0.12),
    });
    expect(result.totalCollateralUsd).toBe(0);
    expect(result.totalDebtUsd).toBe(0);
  });
});

describe("collateral-pricing — price resolution and the fallback chain", () => {
  it("passes a usable live price straight through", () => {
    const resolved = livePrice(0.1375);
    expect(resolved.priceUsd).toBe(0.1375);
    expect(resolved.origin).toBe("live");
    expect(resolved.usedFallback).toBe(false);
    expect(resolved.isStale).toBe(false);
  });

  it("falls back to the configured constant when there is no reading", () => {
    const resolved = resolveDashboardPrice("XLM", null);
    expect(resolved.priceUsd).toBe(FALLBACK_XLM_PRICE_USD);
    expect(resolved.origin).toBe("unavailable");
    expect(resolved.usedFallback).toBe(true);
    expect(resolved.isStale).toBe(true);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, null])(
    "rejects an unusable price of %s and falls back",
    (priceUsd) => {
      const resolved = resolveDashboardPrice("XLM", {
        priceUsd: priceUsd as number | null,
        origin: "live",
      });
      expect(resolved.priceUsd).toBe(FALLBACK_XLM_PRICE_USD);
      expect(resolved.usedFallback).toBe(true);
    },
  );

  it("falls back when the oracle itself reports unavailable", () => {
    const resolved = resolveDashboardPrice("XLM", { priceUsd: null, origin: "unavailable" });
    expect(resolved.priceUsd).toBe(FALLBACK_XLM_PRICE_USD);
    expect(resolved.usedFallback).toBe(true);
  });

  it("honours a fallback override", () => {
    expect(resolveDashboardPrice("XLM", null, { fallbackUsd: 0.09 }).priceUsd).toBe(0.09);
  });

  it("never returns a non-positive price", () => {
    for (const reading of [null, { priceUsd: 0, origin: "live" as PriceOrigin }]) {
      expect(resolveDashboardPrice("XLM", reading).priceUsd).toBeGreaterThan(0);
    }
  });

  it("exposes the fallback directly for callers that skip the oracle", () => {
    const resolved = fallbackDashboardPrice();
    expect(resolved.priceUsd).toBe(FALLBACK_XLM_PRICE_USD);
    expect(resolved.usedFallback).toBe(true);
    expect(resolved.symbol).toBe("XLM");
  });
});

describe("collateral-pricing — staleness labelling", () => {
  it("treats a fresh live median as current", () => {
    expect(livePrice(0.11, 0).isStale).toBe(false);
  });

  it("marks a live price older than the window as stale", () => {
    expect(livePrice(0.11, DASHBOARD_PRICE_STALE_AFTER_MS + 1).isStale).toBe(true);
  });

  it.each(["cache", "twap"] as PriceOrigin[])(
    "always marks a %s reading stale, however recent",
    (origin) => {
      const resolved = resolveDashboardPrice("XLM", { priceUsd: 0.11, origin, ageMs: 0 });
      expect(resolved.isStale).toBe(true);
      expect(resolved.usedFallback).toBe(false);
    },
  );

  it("describes each origin for the UI", () => {
    expect(livePrice(0.11).label).toContain("Live median");
    expect(
      resolveDashboardPrice("XLM", { priceUsd: 0.11, origin: "cache", ageMs: 45_000 }).label,
    ).toBe("Last known good price, 45s old");
    expect(resolveDashboardPrice("XLM", { priceUsd: 0.11, origin: "twap" }).label).toContain(
      "TWAP",
    );
    expect(resolveDashboardPrice("XLM", null).label).toContain("unavailable");
  });

  it("clamps a negative age to zero", () => {
    expect(livePrice(0.11, -500).ageMs).toBe(0);
  });

  it("defaults a missing age to zero", () => {
    expect(resolveDashboardPrice("XLM", { priceUsd: 0.11, origin: "live" }).ageMs).toBe(0);
  });
});

describe("collateral-pricing — fetchDashboardPrice", () => {
  // VITEST is set while this suite runs, so the live lookup is skipped and no
  // test can reach a real price API.
  it("skips the network under test and returns the fallback", async () => {
    const resolved = await fetchDashboardPrice("XLM");
    expect(resolved.usedFallback).toBe(true);
    expect(resolved.priceUsd).toBe(FALLBACK_XLM_PRICE_USD);
  });

  it("never throws, so the dashboard always renders", async () => {
    await expect(fetchDashboardPrice("XLM")).resolves.toBeTruthy();
  });
});
