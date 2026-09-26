/**
 * lib/dashboard/collateral-pricing.ts
 *
 * Priced collateral/debt valuation for dashboard health factors (issue #323).
 *
 * The borrower dashboard hardcoded `XLM_PRICE_USD = 0.10` and valued every
 * position against it, with a comment conceding that "in production this would
 * come from the oracle". A health factor computed from a constant is
 * decorative: it reports the same number whether XLM is at $0.08 or $0.40, so
 * it cannot warn a borrower that their position is approaching liquidation —
 * which is the only reason the gauge exists.
 *
 * This module routes that valuation through the live price feed built for issue
 * #267 (lib/oracle/live-prices.ts), which already aggregates a median across
 * sources and falls back through cache → on-chain TWAP.
 *
 * Why a wrapper rather than calling `getLivePriceUsd` directly:
 *
 *   1. A *display* surface degrades differently from a liquidation decision.
 *      The keeper must refuse to act without a price; a dashboard is better off
 *      showing a clearly-labelled fallback than an empty panel, so this module
 *      resolves a price with provenance the UI can surface.
 *   2. The fallback and the staleness policy belong somewhere pure and tested,
 *      not inlined in an async page component.
 *
 * Every result carries its `origin`, so the UI can tell the borrower whether
 * they are looking at a live market price or a stale one.
 */

import type { PriceOrigin, PriceSymbol } from "@/lib/oracle/prices";

/** Stroops per unit — 1 XLM = 10^7 stroops. */
export const STROOPS_PER_XLM = 10_000_000;

/**
 * Last-resort XLM price, used only when the oracle yields nothing at all.
 *
 * Mirrors `LIQUIDATION_XLM_PRICE_USD`, the documented fallback constant for the
 * liquidation keeper (docs/oracle-price-feeds.md), so both surfaces degrade to
 * the same number instead of disagreeing about what a position is worth.
 */
export const FALLBACK_XLM_PRICE_USD = 0.12;

/**
 * Collateralization ratio assumed when on-chain collateral is not yet read.
 *
 * The Soroban lending contract requires over-collateralization at origination;
 * until the dashboard reads per-loan collateral records this stays an
 * assumption, and `collateralIsAssumed` on the result says so.
 */
export const ASSUMED_COLLATERAL_RATIO = 1.5;

/** Beyond this age a price is labelled stale in the UI. */
export const DASHBOARD_PRICE_STALE_AFTER_MS = 120_000;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ResolvedPrice {
  symbol: PriceSymbol;
  priceUsd: number;
  origin: PriceOrigin;
  /** Age of the underlying reading in ms; 0 for a fresh live median. */
  ageMs: number;
  /** True when no oracle reading was usable and the constant was used. */
  usedFallback: boolean;
  /** True when the price is live but older than the staleness window. */
  isStale: boolean;
  /** Human-readable provenance, safe to show in a tooltip. */
  label: string;
}

export interface HealthFactorValuationParams {
  /**
   * Outstanding debt per active loan, in stroops. Callers pass
   * `principal - repaid` per loan; non-positive entries are ignored.
   */
  outstandingStroops: number[];
  price: ResolvedPrice;
  /** Override the assumed collateralization ratio. */
  collateralRatio?: number;
}

export interface HealthFactorValuation {
  totalDebtXlm: number;
  totalDebtUsd: number;
  totalCollateralUsd: number;
  /** Whether the gauge has anything meaningful to show. */
  showHealthFactor: boolean;
  /** True while collateral is derived from the assumed ratio. */
  collateralIsAssumed: boolean;
  price: ResolvedPrice;
}

// ─── Price resolution ────────────────────────────────────────────────────────

function describeOrigin(origin: PriceOrigin, ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  switch (origin) {
    case "live":
      return "Live median across price sources";
    case "cache":
      return `Last known good price, ${seconds}s old`;
    case "twap":
      return "On-chain TWAP fallback";
    case "unavailable":
    default:
      return "Price feed unavailable — using configured fallback";
  }
}

/**
 * Turns a raw oracle reading into a price the dashboard can always render.
 *
 * Accepts the reading rather than fetching it, so this stays pure and the
 * network call lives at the call site (where Next.js can cache it).
 */
export function resolveDashboardPrice(
  symbol: PriceSymbol,
  reading: { priceUsd: number | null; origin: PriceOrigin; ageMs?: number } | null,
  options: { fallbackUsd?: number; staleAfterMs?: number } = {},
): ResolvedPrice {
  const fallbackUsd = options.fallbackUsd ?? FALLBACK_XLM_PRICE_USD;
  const staleAfterMs = options.staleAfterMs ?? DASHBOARD_PRICE_STALE_AFTER_MS;

  const raw = reading?.priceUsd;
  const usable = typeof raw === "number" && Number.isFinite(raw) && raw > 0;

  if (!usable) {
    return {
      symbol,
      priceUsd: fallbackUsd,
      origin: "unavailable",
      ageMs: 0,
      usedFallback: true,
      isStale: true,
      label: describeOrigin("unavailable", 0),
    };
  }

  const origin = reading?.origin ?? "live";
  const ageMs = Math.max(0, Number(reading?.ageMs ?? 0));

  return {
    symbol,
    priceUsd: raw,
    origin,
    ageMs,
    usedFallback: false,
    // A TWAP or cache reading is by definition not the current market price.
    isStale: origin !== "live" || ageMs > staleAfterMs,
    label: describeOrigin(origin, ageMs),
  };
}

/** The fallback price as a `ResolvedPrice`, for callers that skip the oracle. */
export function fallbackDashboardPrice(
  symbol: PriceSymbol = "XLM",
  fallbackUsd: number = FALLBACK_XLM_PRICE_USD,
): ResolvedPrice {
  return resolveDashboardPrice(symbol, null, { fallbackUsd });
}

// ─── Valuation ───────────────────────────────────────────────────────────────

/**
 * Values outstanding debt and collateral at the resolved price.
 *
 * Replaces the inline arithmetic that used the hardcoded constant. Pure, so the
 * relationship between price and health factor is directly testable.
 */
export function computeHealthFactorValuation(
  params: HealthFactorValuationParams,
): HealthFactorValuation {
  const { outstandingStroops, price } = params;
  const collateralRatio = params.collateralRatio ?? ASSUMED_COLLATERAL_RATIO;

  const totalStroops = outstandingStroops.reduce((sum, raw) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return sum;
    return sum + value;
  }, 0);

  const totalDebtXlm = totalStroops / STROOPS_PER_XLM;
  const totalDebtUsd = totalDebtXlm * price.priceUsd;
  const hasDebt = totalDebtUsd > 0;

  return {
    totalDebtXlm,
    totalDebtUsd,
    totalCollateralUsd: hasDebt ? totalDebtUsd * collateralRatio : 0,
    showHealthFactor: hasDebt,
    collateralIsAssumed: true,
    price,
  };
}

/**
 * Fetches a live price and resolves it for the dashboard.
 *
 * Never throws: a dashboard must render even when every price source is down,
 * so a failed lookup degrades to the fallback constant rather than a 500.
 * Live lookups are skipped under test so unit runs never hit a real API,
 * matching the liquidation keeper's behaviour.
 */
export async function fetchDashboardPrice(
  symbol: PriceSymbol = "XLM",
): Promise<ResolvedPrice> {
  const skipLiveLookup =
    process.env.DASHBOARD_USE_LIVE_PRICES === "false" ||
    process.env.NODE_ENV === "test" ||
    process.env.VITEST !== undefined;

  if (skipLiveLookup) {
    return fallbackDashboardPrice(symbol);
  }

  try {
    const { getLivePrices } = await import("@/lib/oracle/live-prices");
    const prices = await getLivePrices([symbol]);
    const reading = prices.get(symbol) ?? null;
    return resolveDashboardPrice(symbol, reading);
  } catch (error) {
    console.warn(
      `[dashboard] Live ${symbol} price lookup failed; using the configured fallback.`,
      error instanceof Error ? error.message : error,
    );
    return fallbackDashboardPrice(symbol);
  }
}
