// ─── Health Factor calculation utilities ─────────────────────────────────────
// Pure, dependency-free module for computing and simulating Health Factors.
//
// Health Factor = Collateral Value (USD) / Outstanding Debt (USD)
//   • HF > 1.5  → Safe (green)
//   • 1.1 ≤ HF ≤ 1.5 → Warning (yellow)
//   • HF < 1.1  → Critical / liquidation risk (red)
//   • HF ≤ 1.0  → Under-collateralized, liquidation triggered

/** Thresholds that define the risk zones. */
export const HF_SAFE_THRESHOLD = 1.5;
export const HF_WARNING_THRESHOLD = 1.1;

/** Risk zone classification. */
export type HealthFactorZone = "critical" | "warning" | "safe";

/** Parameters needed to compute a Health Factor. */
export interface HealthFactorParams {
  /** Total collateral value in USD. */
  collateralValueUsd: number;
  /** Total outstanding debt value in USD. */
  debtValueUsd: number;
}

/**
 * Compute the Health Factor from collateral and debt values.
 *
 * Returns `Infinity` when debt is zero (no risk), and `0` when collateral
 * is zero but debt exists (maximally risky).
 */
export function computeHealthFactor(params: HealthFactorParams): number {
  const { collateralValueUsd, debtValueUsd } = params;

  if (debtValueUsd <= 0) return Infinity;
  if (collateralValueUsd <= 0) return 0;

  return collateralValueUsd / debtValueUsd;
}

/** Classify a Health Factor value into a risk zone. */
export function getHealthFactorZone(hf: number): HealthFactorZone {
  if (!Number.isFinite(hf) && hf > 0) return "safe"; // Infinity → safe
  if (hf >= HF_SAFE_THRESHOLD) return "safe";
  if (hf >= HF_WARNING_THRESHOLD) return "warning";
  return "critical";
}

/** Return the display colour (hex) for a given Health Factor. */
export function getHealthFactorColor(hf: number): string {
  const zone = getHealthFactorZone(hf);
  switch (zone) {
    case "safe":
      return "#22cf9d";
    case "warning":
      return "#f59e0b";
    case "critical":
      return "#ef4444";
  }
}

/** Human-readable label for a Health Factor zone. */
export function getHealthFactorLabel(hf: number): string {
  const zone = getHealthFactorZone(hf);
  switch (zone) {
    case "safe":
      return "Safe";
    case "warning":
      return "Warning — Low Buffer";
    case "critical":
      return "Critical — Liquidation Risk";
  }
}

/**
 * Simulate a Health Factor after adjusting collateral and/or debt.
 *
 * @param params        Current position.
 * @param collateralDeltaUsd  Amount of extra collateral added (USD, can be negative for withdrawal).
 * @param debtDeltaUsd        Amount of additional debt taken (USD, can be negative for repayment).
 */
export function simulateHealthFactor(
  params: HealthFactorParams,
  collateralDeltaUsd: number,
  debtDeltaUsd: number,
): number {
  return computeHealthFactor({
    collateralValueUsd: Math.max(0, params.collateralValueUsd + collateralDeltaUsd),
    debtValueUsd: Math.max(0, params.debtValueUsd + debtDeltaUsd),
  });
}

/**
 * Map a Health Factor value to a 0..1 position on the gauge arc.
 * HF 0 → 0 (far left / red), HF ≥ 3 → 1 (far right / green).
 * Uses a non-linear scale so the warning zone is visually prominent.
 */
export function healthFactorToArcPosition(hf: number): number {
  if (!Number.isFinite(hf)) return 1; // Infinity → fully safe
  const clamped = Math.max(0, Math.min(3, hf));
  // Slightly logarithmic feel: sqrt mapping compresses the high end
  return Math.sqrt(clamped / 3);
}
