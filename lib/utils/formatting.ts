/**
 * Currency & token formatting utilities for TrustLend.
 *
 * All display-layer functions use `Intl.NumberFormat` so thousands separators
 * and decimal symbols automatically follow the user's locale (e.g. 1,234.56
 * in en-US vs 1.234,56 in de-DE).
 *
 * NOTE: These helpers are for *display only*.  Amounts passed to the Stellar
 * SDK (Operation.payment.amount) must stay as `value.toFixed(7)` strings —
 * never use these formatters for on-chain values.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the best locale to use.
 * - In the browser we use `navigator.language` so the output matches the
 *   user's OS locale setting.
 * - In Node / SSR we fall back to `"en-US"` for deterministic output.
 */
function getLocale(): string {
  if (typeof navigator !== "undefined" && navigator.language) {
    return navigator.language;
  }
  return "en-US";
}

// ─────────────────────────────────────────────────────────────────────────────
// Core XLM formatter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a plain XLM value (already in lumens, not stroops) with proper
 * thousands separators and 2 decimal places, followed by the " XLM" suffix.
 *
 * @example
 *   formatCurrency(1234567.89) // → "1,234,567.89 XLM"  (en-US)
 *   formatCurrency(0)          // → "0.00 XLM"
 */
export function formatCurrency(value: number): string {
  return `${new Intl.NumberFormat(getLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)} XLM`;
}

/**
 * Alias with a more descriptive name — use this when you want to be explicit
 * that the input is already in XLM (not stroops).
 *
 * @example
 *   formatXlm(9876.5)  // → "9,876.50 XLM"
 */
export const formatXlm = formatCurrency;

// ─────────────────────────────────────────────────────────────────────────────
// High-precision variant (4 decimal places) — for interest / earned amounts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Like `formatCurrency` but shows up to 4 decimal places.
 * Useful for earned-interest values where sub-cent precision matters.
 *
 * @example
 *   formatXlmPrecise(0.00123456) // → "0.0012 XLM"
 *   formatXlmPrecise(12.3456789) // → "12.3457 XLM"
 */
export function formatXlmPrecise(value: number): string {
  return `${new Intl.NumberFormat(getLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value)} XLM`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compact formatter — for tight spaces (e.g. badge chips, mobile)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compact representation for large numbers: abbreviates with K / M / B suffix
 * and always appends " XLM".
 *
 * @example
 *   formatXlmCompact(1234567) // → "1.23M XLM"
 *   formatXlmCompact(1234)    // → "1.23K XLM"
 *   formatXlmCompact(500)     // → "500.00 XLM"  (no abbreviation below 1 K)
 */
export function formatXlmCompact(value: number): string {
  if (Math.abs(value) >= 1_000_000_000) {
    return `${new Intl.NumberFormat(getLocale(), {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value / 1_000_000_000)}B XLM`;
  }
  if (Math.abs(value) >= 1_000_000) {
    return `${new Intl.NumberFormat(getLocale(), {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value / 1_000_000)}M XLM`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${new Intl.NumberFormat(getLocale(), {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value / 1_000)}K XLM`;
  }
  return formatCurrency(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stroops → XLM conversion + format
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a value stored in stroops (1 XLM = 10^7 stroops) to a
 * human-readable XLM string with thousands separators.
 *
 * Drop-in replacement for the old `(value / 10_000_000).toFixed(2) + " XLM"`
 * pattern.
 *
 * @param valueInStroops  Raw stroops value (integer)
 * @param decimals        Decimal places for the asset (default: 7 for XLM)
 *
 * @example
 *   formatTokenBalance(10_000_000)   // → "1.00 XLM"
 *   formatTokenBalance(123_456_789)  // → "12.35 XLM"
 */
export function formatTokenBalance(
  valueInStroops: number,
  decimals: number = 7,
): string {
  const adjustedValue = valueInStroops / Math.pow(10, decimals);
  return formatCurrency(adjustedValue);
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-token / stablecoin formatter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * General-purpose token amount formatter for any asset symbol (XLM, USDC,
 * USDT, etc.).  Displays the value with thousands separators according to the
 * user's locale and appends the provided symbol.
 *
 * @param value       Amount already in human-readable units (not base units)
 * @param symbol      Token symbol to append, e.g. "XLM", "USDC"
 * @param decimals    How many decimal places to show (default: 2)
 *
 * @example
 *   formatTokenAmount(1234567.89, "USDC")       // → "1,234,567.89 USDC"
 *   formatTokenAmount(0.0001234,  "USDC", 6)    // → "0.000123 USDC"
 *   formatTokenAmount(9876.5,     "XLM")        // → "9,876.50 XLM"
 */
export function formatTokenAmount(
  value: number,
  symbol: string,
  decimals: number = 2,
): string {
  return `${new Intl.NumberFormat(getLocale(), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value)} ${symbol}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Percentage formatter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format basis-points (bps) as a human-readable APR percentage string.
 * 1 bps = 0.01%, so 1500 bps → "15.00%".
 *
 * @example
 *   formatApr(1500) // → "15.00%"
 *   formatApr(725)  // → "7.25%"
 */
export function formatApr(bps: number): string {
  return `${new Intl.NumberFormat(getLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(bps / 100)}%`;
}
