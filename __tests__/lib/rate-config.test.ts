import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_RATE_CONFIGS,
  RATE_CONFIG_BOUNDS,
  getActiveRateConfig,
  isRateModel,
  parseAmountTiers,
  parseReputationTiers,
  previewRateSchedule,
  priceLoanApr,
  selectAmountTier,
  selectReputationMultiplierBps,
  validateRateConfigDraft,
  type InterestRateConfig,
} from "@/lib/loans/rate-config";
import type { Db } from "@/lib/db/client";
import { createFakeDb } from "../helpers/fake-db";

const schedule: InterestRateConfig = {
  rateModel: "fixed",
  version: 3,
  baseAprBps: 1500,
  minAprBps: 100,
  maxAprBps: 5000,
  amountTiers: [
    { minAmount: 1000, aprBps: 1200 },
    { minAmount: 2000, aprBps: 1000 },
  ],
  reputationTiers: [
    { minScore: 0, multiplierBps: 11000 }, // 1.10x — new borrowers pay more
    { minScore: 500, multiplierBps: 10000 }, // 1.00x
    { minScore: 750, multiplierBps: 9000 }, // 0.90x — trusted discount
  ],
};

describe("rate-config — amount tier selection", () => {
  it("falls back to the base APR below the lowest tier", () => {
    expect(selectAmountTier(schedule, 500)).toBeNull();
    const quote = priceLoanApr(schedule, { amount: 500, reputationScore: 500 });
    expect(quote.tierAprBps).toBe(1500);
    expect(quote.matchedAmountTier).toBeNull();
  });

  it("matches a tier inclusively at its threshold", () => {
    expect(selectAmountTier(schedule, 1000)?.aprBps).toBe(1200);
  });

  it("picks the highest tier the principal clears", () => {
    expect(selectAmountTier(schedule, 5000)?.aprBps).toBe(1000);
    expect(selectAmountTier(schedule, 1999)?.aprBps).toBe(1200);
  });
});

describe("rate-config — reputation multipliers", () => {
  it("uses a neutral 1.00x when no tier matches", () => {
    const noTiers: InterestRateConfig = { ...schedule, reputationTiers: [] };
    expect(selectReputationMultiplierBps(noTiers, 900)).toBe(10000);
  });

  it("discounts a trusted borrower and surcharges a new one", () => {
    const trusted = priceLoanApr(schedule, { amount: 1000, reputationScore: 800 });
    const newcomer = priceLoanApr(schedule, { amount: 1000, reputationScore: 100 });

    expect(trusted.aprBps).toBe(1080); // 1200 * 0.90
    expect(newcomer.aprBps).toBe(1320); // 1200 * 1.10
    expect(trusted.aprBps).toBeLessThan(newcomer.aprBps);
  });

  it("picks the highest score band the borrower clears", () => {
    expect(selectReputationMultiplierBps(schedule, 750)).toBe(9000);
    expect(selectReputationMultiplierBps(schedule, 749)).toBe(10000);
  });
});

describe("rate-config — clamping", () => {
  it("clamps a rate above the configured maximum", () => {
    const capped: InterestRateConfig = { ...schedule, maxAprBps: 1100 };
    const quote = priceLoanApr(capped, { amount: 1000, reputationScore: 100 });
    expect(quote.aprBps).toBe(1100);
    expect(quote.clamped).toBe(true);
  });

  it("clamps a rate below the configured minimum", () => {
    const floored: InterestRateConfig = { ...schedule, minAprBps: 1200, maxAprBps: 5000 };
    const quote = priceLoanApr(floored, { amount: 1000, reputationScore: 800 });
    expect(quote.aprBps).toBe(1200); // 1080 raised to the floor
    expect(quote.clamped).toBe(true);
  });

  it("never emits a rate outside the stated ceiling when min/max are inverted", () => {
    const inverted: InterestRateConfig = { ...schedule, minAprBps: 5000, maxAprBps: 100 };
    const quote = priceLoanApr(inverted, { amount: 1000, reputationScore: 500 });
    expect(quote.aprBps).toBeGreaterThanOrEqual(100);
    expect(quote.aprBps).toBeLessThanOrEqual(5000);
  });

  it("reports clamped: false when the rate needs no adjustment", () => {
    const quote = priceLoanApr(schedule, { amount: 1000, reputationScore: 500 });
    expect(quote.aprBps).toBe(1200);
    expect(quote.clamped).toBe(false);
  });
});

describe("rate-config — quote provenance", () => {
  it("carries the schedule version so origination can pin the loan to it", () => {
    const quote = priceLoanApr(schedule, { amount: 1000, reputationScore: 500 });
    expect(quote.configVersion).toBe(3);
    expect(quote.rateModel).toBe("fixed");
  });

  it("propagates the fallback flag from the caller", () => {
    const quote = priceLoanApr(schedule, {
      amount: 1000,
      reputationScore: 500,
      usedFallback: true,
    });
    expect(quote.usedFallback).toBe(true);
  });

  it("is deterministic, so preflight and commit agree", () => {
    const params = { amount: 1750, reputationScore: 640 };
    expect(priceLoanApr(schedule, params)).toEqual(priceLoanApr(schedule, params));
  });
});

describe("rate-config — code defaults reproduce the pre-#321 ladder", () => {
  // The old hardcoded ladder used strict `>` comparisons, so a loan of exactly
  // 1000 XLM paid the 15% base rate, not the 12% tier.
  const cases: [number, number][] = [
    [1, 1500],
    [999, 1500],
    [1000, 1500],
    [1001, 1200],
    [2000, 1200],
    [2001, 1000],
    [10000, 1000],
  ];

  it.each(cases)("prices %i XLM at %i bps on the fixed default", (amount, expected) => {
    const quote = priceLoanApr(DEFAULT_RATE_CONFIGS.fixed, { amount, reputationScore: 250 });
    expect(quote.aprBps).toBe(expected);
  });

  const floatingCases: [number, number][] = [
    [1000, 500],
    [1001, 450],
    [2000, 450],
    [2001, 400],
  ];

  it.each(floatingCases)("prices %i XLM at %i bps on the floating default", (amount, expected) => {
    const quote = priceLoanApr(DEFAULT_RATE_CONFIGS.floating, { amount, reputationScore: 250 });
    expect(quote.aprBps).toBe(expected);
  });

  it("leaves rates untouched by reputation, since default multipliers are neutral", () => {
    const low = priceLoanApr(DEFAULT_RATE_CONFIGS.fixed, { amount: 1500, reputationScore: 10 });
    const high = priceLoanApr(DEFAULT_RATE_CONFIGS.fixed, { amount: 1500, reputationScore: 900 });
    expect(low.aprBps).toBe(high.aprBps);
  });
});

describe("rate-config — tier parsing", () => {
  it("sorts tiers ascending regardless of stored order", () => {
    const parsed = parseAmountTiers([
      { minAmount: 5000, aprBps: 800 },
      { minAmount: 100, aprBps: 1400 },
    ]);
    expect(parsed.map((t) => t.minAmount)).toEqual([100, 5000]);
  });

  it("accepts snake_case keys as stored by raw SQL seeds", () => {
    expect(parseAmountTiers([{ min_amount: 1000, apr_bps: 1200 }])).toEqual([
      { minAmount: 1000, aprBps: 1200 },
    ]);
    expect(parseReputationTiers([{ min_score: 500, multiplier_bps: 9000 }])).toEqual([
      { minScore: 500, multiplierBps: 9000 },
    ]);
  });

  it("drops malformed entries rather than throwing, so a bad row cannot break origination", () => {
    const parsed = parseAmountTiers([
      { minAmount: 1000, aprBps: 1200 },
      { minAmount: "oops", aprBps: 900 },
      null,
      { minAmount: -5, aprBps: 900 },
      "nonsense",
    ]);
    expect(parsed).toEqual([{ minAmount: 1000, aprBps: 1200 }]);
  });

  it("returns an empty ladder for non-array input", () => {
    expect(parseAmountTiers(null)).toEqual([]);
    expect(parseReputationTiers({ minScore: 1 })).toEqual([]);
  });

  it("rejects a zero or negative multiplier", () => {
    expect(parseReputationTiers([{ minScore: 0, multiplierBps: 0 }])).toEqual([]);
  });
});

describe("rate-config — draft validation", () => {
  const validDraft = {
    baseAprBps: 1500,
    minAprBps: 100,
    maxAprBps: 5000,
    amountTiers: [{ minAmount: 1000, aprBps: 1200 }],
    reputationTiers: [{ minScore: 500, multiplierBps: 9000 }],
  };

  it("accepts a well-formed draft", () => {
    expect(validateRateConfigDraft(validDraft).valid).toBe(true);
  });

  it("rejects a minimum above the maximum", () => {
    const result = validateRateConfigDraft({ ...validDraft, minAprBps: 6000 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("cannot exceed maximum");
  });

  it("rejects an APR above the 100% ceiling", () => {
    expect(validateRateConfigDraft({ ...validDraft, baseAprBps: 10001 }).valid).toBe(false);
  });

  it("rejects a fractional basis point", () => {
    const result = validateRateConfigDraft({ ...validDraft, baseAprBps: 1500.5 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("whole number");
  });

  it("rejects duplicate amount thresholds", () => {
    const result = validateRateConfigDraft({
      ...validDraft,
      amountTiers: [
        { minAmount: 1000, aprBps: 1200 },
        { minAmount: 1000, aprBps: 1100 },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Duplicate amount tier");
  });

  it("rejects duplicate reputation thresholds", () => {
    const result = validateRateConfigDraft({
      ...validDraft,
      reputationTiers: [
        { minScore: 500, multiplierBps: 9000 },
        { minScore: 500, multiplierBps: 9500 },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Duplicate reputation tier");
  });

  it("rejects a multiplier that would zero out interest", () => {
    const result = validateRateConfigDraft({
      ...validDraft,
      reputationTiers: [{ minScore: 0, multiplierBps: 10 }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Reputation multipliers");
  });

  it("rejects a multiplier above the ceiling", () => {
    expect(
      validateRateConfigDraft({
        ...validDraft,
        reputationTiers: [
          { minScore: 0, multiplierBps: RATE_CONFIG_BOUNDS.MAX_MULTIPLIER_BPS + 1 },
        ],
      }).valid,
    ).toBe(false);
  });

  it("rejects more tiers than the bound allows", () => {
    const tooMany = Array.from({ length: RATE_CONFIG_BOUNDS.MAX_AMOUNT_TIERS + 1 }, (_, i) => ({
      minAmount: i * 100,
      aprBps: 1000,
    }));
    expect(validateRateConfigDraft({ ...validDraft, amountTiers: tooMany }).valid).toBe(false);
  });

  it("rejects non-array tier payloads", () => {
    expect(
      validateRateConfigDraft({ ...validDraft, amountTiers: undefined }).valid,
    ).toBe(false);
  });
});

describe("rate-config — getActiveRateConfig", () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => errorSpy.mockClear());
  afterEach(() => errorSpy.mockClear());

  it("returns the code default when the database is unconfigured", async () => {
    const result = await getActiveRateConfig(null, "fixed");
    expect(result.usedFallback).toBe(true);
    expect(result.config).toEqual(DEFAULT_RATE_CONFIGS.fixed);
  });

  it("returns the code default when no active row exists", async () => {
    const db = createFakeDb();
    db.queue([]);
    const result = await getActiveRateConfig(db as unknown as Db, "floating");
    expect(result.usedFallback).toBe(true);
    expect(result.config.baseAprBps).toBe(DEFAULT_RATE_CONFIGS.floating.baseAprBps);
  });

  it("maps a stored row into a usable schedule", async () => {
    const db = createFakeDb();
    db.queue([
      {
        rateModel: "fixed",
        version: 7,
        baseAprBps: 1800,
        minAprBps: 200,
        maxAprBps: 4000,
        amountTiers: [{ minAmount: 500, aprBps: 1600 }],
        reputationTiers: [{ minScore: 600, multiplierBps: 9500 }],
        notes: "Market repricing",
        updatedByEmail: "admin@trustlend.org",
        updatedAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    ]);

    const { config, usedFallback } = await getActiveRateConfig(db as unknown as Db, "fixed");
    expect(usedFallback).toBe(false);
    expect(config.version).toBe(7);
    expect(config.baseAprBps).toBe(1800);
    expect(config.amountTiers).toEqual([{ minAmount: 500, aprBps: 1600 }]);
    expect(config.updatedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("falls back instead of throwing when the query fails", async () => {
    const brokenDb = {
      select: () => {
        throw new Error("connection reset");
      },
    };
    const result = await getActiveRateConfig(brokenDb as unknown as Db, "fixed");
    expect(result.usedFallback).toBe(true);
    expect(result.config).toEqual(DEFAULT_RATE_CONFIGS.fixed);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("rate-config — helpers", () => {
  it("recognises only the two supported rate models", () => {
    expect(isRateModel("fixed")).toBe(true);
    expect(isRateModel("floating")).toBe(true);
    expect(isRateModel("variable")).toBe(false);
    expect(isRateModel(undefined)).toBe(false);
  });

  it("previews a schedule across principal bands", () => {
    const preview = previewRateSchedule(schedule, [500, 1000, 2000], 500);
    expect(preview).toEqual([
      { amount: 500, aprBps: 1500, aprPct: 15, matchedAmountTier: null },
      { amount: 1000, aprBps: 1200, aprPct: 12, matchedAmountTier: 1000 },
      { amount: 2000, aprBps: 1000, aprPct: 10, matchedAmountTier: 2000 },
    ]);
  });
});
