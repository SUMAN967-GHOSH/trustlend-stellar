/**
 * lib/platform/settings.ts
 *
 * Admin-tunable platform-wide financial parameters (issue #324).
 *
 * The repayment route hardcoded `const platformFee = principal * 0.01`, so
 * changing the protocol's cut required a deployment. Values now live in the
 * `platform_settings` table, one active versioned row per key.
 *
 * ## Fees are locked at origination
 *
 * This is the part that matters most. A platform fee is charged to a borrower,
 * so it must be fixed when they take the loan — if repayment simply read the
 * current value, an admin raising the fee would silently increase the amount
 * owed on every loan already outstanding, and a borrower who budgeted for the
 * agreed total would suddenly be short.
 *
 * So origination stamps the fee into `loans.metadata.platform_fee_bps`, and
 * repayment prefers that stamp over the live setting. The live setting applies
 * only to loans that have no stamp — loans created before this change, which
 * were all charged the 1% the constant is seeded with. `resolveLoanFeeBps`
 * implements that precedence and is the only function repayment should use.
 *
 * ## Relationship to the on-chain fee
 *
 * `contracts/lending/src/lib.rs` deliberately allows no admin override of its
 * platform fee: `set_platform_fee_bps` is callable only by the Governance
 * contract, after a proposal passes. This module governs the *off-chain* fee
 * the API charges, and its bounds mirror the contract's `MAX_PLATFORM_FEE_BPS`
 * so the two can never drift into disagreement. Changing the on-chain fee is
 * still a DAO action; see docs/apr-formulas.md §7.
 */

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { platformSettings } from "@/lib/db/schema";
import { readMetadata } from "@/lib/db/metadata";

// ─── Keys ─────────────────────────────────────────────────────────────────────

/** Protocol cut of a loan's principal, in bps. */
export const PLATFORM_FEE_BPS_KEY = "platform_fee_bps";

export type PlatformSettingKey = typeof PLATFORM_FEE_BPS_KEY;

export const PLATFORM_SETTING_KEYS: readonly PlatformSettingKey[] = [
  PLATFORM_FEE_BPS_KEY,
] as const;

export function isPlatformSettingKey(value: unknown): value is PlatformSettingKey {
  return typeof value === "string" && (PLATFORM_SETTING_KEYS as readonly string[]).includes(value);
}

// ─── Bounds and defaults ──────────────────────────────────────────────────────

export interface SettingDefinition {
  key: PlatformSettingKey;
  label: string;
  /** Value used when the table is unreachable or unseeded. */
  defaultBps: number;
  minBps: number;
  /** Mirrors MAX_PLATFORM_FEE_BPS in contracts/lending/src/lib.rs. */
  maxBps: number;
  description: string;
}

export const SETTING_DEFINITIONS: Record<PlatformSettingKey, SettingDefinition> = {
  [PLATFORM_FEE_BPS_KEY]: {
    key: PLATFORM_FEE_BPS_KEY,
    label: "Platform Fee",
    // The value the repay route hardcoded, and DEFAULT_PLATFORM_FEE_BPS on-chain.
    defaultBps: 100,
    minBps: 0,
    // MAX_PLATFORM_FEE_BPS in the lending contract. Keeping the off-chain
    // ceiling identical means an admin can never configure a fee the contract
    // would refuse.
    maxBps: 1000,
    description:
      "Protocol cut charged on a loan's principal at repayment. Locked per loan at origination.",
  },
};

/** Minimum characters of rationale required to publish a change. */
export const MIN_SETTING_NOTES_LENGTH = 5;

/** Loan metadata key holding the fee a loan was originated under. */
export const LOAN_FEE_METADATA_KEY = "platform_fee_bps";

/** Loan metadata key holding the settings version that fee came from. */
export const LOAN_FEE_VERSION_METADATA_KEY = "platform_fee_version";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlatformSetting {
  key: PlatformSettingKey;
  valueBps: number;
  version: number;
  notes?: string | null;
  updatedByEmail?: string | null;
  updatedAt?: string | null;
  /** True when this came from code defaults rather than the database. */
  usedFallback: boolean;
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function validateSettingValue(
  key: PlatformSettingKey,
  valueBps: number,
): { valid: boolean; error?: string } {
  const definition = SETTING_DEFINITIONS[key];
  if (!definition) {
    return { valid: false, error: `Unknown setting: ${key}` };
  }

  if (!Number.isFinite(valueBps) || !Number.isInteger(valueBps)) {
    return { valid: false, error: `${definition.label} must be a whole number of basis points` };
  }

  if (valueBps < definition.minBps || valueBps > definition.maxBps) {
    return {
      valid: false,
      error: `${definition.label} must be between ${definition.minBps / 100}% and ${
        definition.maxBps / 100
      }%`,
    };
  }

  return { valid: true };
}

/** Clamps a value into its key's bounds. Used on read, so a row written before
 *  a bound tightened can never charge more than the current ceiling. */
export function clampSettingValue(key: PlatformSettingKey, valueBps: number): number {
  const definition = SETTING_DEFINITIONS[key];
  if (!definition) return valueBps;
  if (!Number.isFinite(valueBps)) return definition.defaultBps;
  return Math.min(definition.maxBps, Math.max(definition.minBps, Math.round(valueBps)));
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function fallbackSetting(key: PlatformSettingKey): PlatformSetting {
  return {
    key,
    valueBps: SETTING_DEFINITIONS[key].defaultBps,
    // Version 0 marks a code default, matching the convention in
    // lib/loans/rate-config.ts.
    version: 0,
    notes: "Code default — no active row found in the database",
    usedFallback: true,
  };
}

/**
 * Reads the active value for a setting.
 *
 * Never throws: a database hiccup must not block a borrower from repaying, so
 * an unreachable table degrades to the seeded default rather than failing the
 * request.
 */
export async function getPlatformSetting(
  db: Db | null,
  key: PlatformSettingKey,
): Promise<PlatformSetting> {
  if (!db) return fallbackSetting(key);

  try {
    const [row] = await db
      .select({
        settingKey: platformSettings.settingKey,
        valueBps: platformSettings.valueBps,
        version: platformSettings.version,
        notes: platformSettings.notes,
        updatedByEmail: platformSettings.updatedByEmail,
        updatedAt: platformSettings.updatedAt,
      })
      .from(platformSettings)
      .where(and(eq(platformSettings.settingKey, key), eq(platformSettings.isActive, true)))
      .limit(1);

    if (!row) return fallbackSetting(key);

    return {
      key,
      valueBps: clampSettingValue(key, Number(row.valueBps)),
      version: Number(row.version),
      notes: row.notes,
      updatedByEmail: row.updatedByEmail,
      updatedAt:
        row.updatedAt instanceof Date ? row.updatedAt.toISOString() : (row.updatedAt ?? null),
      usedFallback: false,
    };
  } catch (error) {
    console.error(`Failed to load platform setting ${key}, using default:`, error);
    return fallbackSetting(key);
  }
}

/** Convenience reader for the platform fee. */
export async function getPlatformFeeBps(db: Db | null): Promise<PlatformSetting> {
  return getPlatformSetting(db, PLATFORM_FEE_BPS_KEY);
}

/** Published history for a key, newest first. Powers the admin audit trail. */
export async function getPlatformSettingHistory(
  db: Db | null,
  key?: PlatformSettingKey,
  limit = 25,
): Promise<PlatformSetting[]> {
  if (!db) return [];
  try {
    const base = db
      .select({
        settingKey: platformSettings.settingKey,
        valueBps: platformSettings.valueBps,
        version: platformSettings.version,
        notes: platformSettings.notes,
        updatedByEmail: platformSettings.updatedByEmail,
        updatedAt: platformSettings.updatedAt,
      })
      .from(platformSettings);

    const rows = key
      ? await base
          .where(eq(platformSettings.settingKey, key))
          .orderBy(desc(platformSettings.createdAt))
          .limit(limit)
      : await base.orderBy(desc(platformSettings.createdAt)).limit(limit);

    return rows
      .filter((row) => isPlatformSettingKey(row.settingKey))
      .map((row) => ({
        key: row.settingKey as PlatformSettingKey,
        valueBps: Number(row.valueBps),
        version: Number(row.version),
        notes: row.notes,
        updatedByEmail: row.updatedByEmail,
        updatedAt:
          row.updatedAt instanceof Date ? row.updatedAt.toISOString() : (row.updatedAt ?? null),
        usedFallback: false,
      }));
  } catch (error) {
    console.error("Failed to load platform setting history:", error);
    return [];
  }
}

// ─── Per-loan fee resolution ──────────────────────────────────────────────────

export interface ResolvedLoanFee {
  feeBps: number;
  /** Fee amount in XLM, derived from the principal. */
  feeAmount: number;
  /** "loan" when read from the loan's own stamp, "setting" when from the live
   *  value, "default" when neither was usable. */
  source: "loan" | "setting" | "default";
  /** Settings version the fee came from, when known. */
  version: number | null;
}

/**
 * Reads the fee a loan was originated under, or null when it carries no stamp.
 *
 * Exported so the admin UI can explain why an old loan is charged differently
 * from a new one.
 */
export function readLoanFeeBps(loanMetadata: unknown): number | null {
  const raw = readMetadata(loanMetadata)[LOAN_FEE_METADATA_KEY];
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function readLoanFeeVersion(loanMetadata: unknown): number | null {
  const raw = readMetadata(loanMetadata)[LOAN_FEE_VERSION_METADATA_KEY];
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.round(value) : null;
}

/**
 * Resolves the fee to charge on one loan, honouring the origination lock.
 *
 * Precedence:
 *   1. `loans.metadata.platform_fee_bps` — the rate agreed at origination.
 *   2. The active platform setting — for loans predating the stamp.
 *   3. The code default.
 *
 * Both the repay route and its preflight call this, so the quote a borrower is
 * shown and the amount they are charged cannot disagree.
 */
export function resolveLoanFeeBps(params: {
  principal: number;
  loanMetadata: unknown;
  activeSetting: PlatformSetting | null;
}): ResolvedLoanFee {
  const principal = Math.max(0, Number(params.principal) || 0);
  const definition = SETTING_DEFINITIONS[PLATFORM_FEE_BPS_KEY];

  const stamped = readLoanFeeBps(params.loanMetadata);
  let feeBps: number;
  let source: ResolvedLoanFee["source"];
  let version: number | null;

  if (stamped !== null) {
    // Clamped on read so a malformed or out-of-date stamp cannot overcharge.
    feeBps = clampSettingValue(PLATFORM_FEE_BPS_KEY, stamped);
    source = "loan";
    version = readLoanFeeVersion(params.loanMetadata);
  } else if (params.activeSetting && !params.activeSetting.usedFallback) {
    feeBps = clampSettingValue(PLATFORM_FEE_BPS_KEY, params.activeSetting.valueBps);
    source = "setting";
    version = params.activeSetting.version;
  } else {
    feeBps = params.activeSetting?.valueBps ?? definition.defaultBps;
    feeBps = clampSettingValue(PLATFORM_FEE_BPS_KEY, feeBps);
    source = "default";
    version = params.activeSetting?.version ?? 0;
  }

  return {
    feeBps,
    // 7 decimals — the precision of a stroop, Stellar's smallest unit.
    feeAmount: Number((principal * (feeBps / 10_000)).toFixed(7)),
    source,
    version,
  };
}
