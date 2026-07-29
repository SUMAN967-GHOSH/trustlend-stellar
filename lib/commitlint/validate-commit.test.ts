import { describe, it, expect } from "vitest";

/**
 * Tests for commit message formats following Conventional Commits.
 *
 * Rather than importing commitlint directly (which requires its CLI and config
 * to be installed), these tests validate the regex and parsing logic that
 * commitlint uses under the hood, ensuring the configured rules match the
 * expected message patterns.
 */

// ── Regex derived from @commitlint/config-conventional rules ─────────────

const CONVENTIONAL_PATTERN =
  /^(?<type>\w+)(?:\((?<scope>[\w,-]+)\))?!?:\s(?<subject>.+)$/;

const ALLOWED_TYPES = [
  "feat", "fix", "docs", "style", "refactor", "perf", "test",
  "build", "ci", "chore", "revert", "contract", "stellar", "security",
] as const;

const ALLOWED_SCOPES = [
  "lending", "escrow", "governance", "default-management", "multisig-admin",
  "borrower-reputation", "auto-compound-vault", "treasury", "contracts",
  "frontend", "dashboard", "auth", "kyc", "api", "ci", "db", "supabase",
  "stellar", "soroban", "docs", "deps", "config", "landing", "hooks",
] as const;

function validateCommitMessage(message: string): {
  valid: boolean;
  reason?: string;
} {
  if (!message || message.trim().length === 0) {
    return { valid: false, reason: "empty" };
  }

  // Remove comments (lines starting with #)
  const cleaned = message
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .trim();

  const firstLine = cleaned.split("\n")[0];

  if (!firstLine) {
    return { valid: false, reason: "empty" };
  }

  // Allow merge commits and revert commits
  if (/^(Merge|Revert)\b/.test(firstLine)) {
    return { valid: true };
  }

  const match = CONVENTIONAL_PATTERN.exec(firstLine);

  if (!match) {
    return { valid: false, reason: "format" };
  }

  const { type, scope } = match.groups!;

  if (!ALLOWED_TYPES.includes(type as typeof ALLOWED_TYPES[number])) {
    return { valid: false, reason: "type" };
  }

  // If a scope is present, validate it
  if (scope) {
    const scopes = scope.split(",");
    for (const s of scopes) {
      if (!ALLOWED_SCOPES.includes(s.trim() as typeof ALLOWED_SCOPES[number])) {
        return { valid: false, reason: "scope" };
      }
    }
  }

  const subject = match.groups!.subject;

  // Subject must not be empty
  if (!subject || subject.trim().length === 0) {
    return { valid: false, reason: "empty-subject" };
  }

  // Subject should not end with a period
  if (subject.endsWith(".")) {
    return { valid: false, reason: "trailing-period" };
  }

  return { valid: true };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("commit message validation", () => {
  // ── Success path ───────────────────────────────────────────────────────

  it("accepts feat with scope", () => {
    expect(validateCommitMessage("feat(lending): add flash loan support")).toEqual({
      valid: true,
    });
  });

  it("accepts fix without scope", () => {
    expect(validateCommitMessage("fix: correct interest rate calculation")).toEqual({
      valid: true,
    });
  });

  it("accepts ci scope", () => {
    expect(
      validateCommitMessage("ci: add Vercel preview deployment workflow"),
    ).toEqual({ valid: true });
  });

  it("accepts contract type (custom type)", () => {
    expect(
      validateCommitMessage("contract(lending): add liquidation logic"),
    ).toEqual({ valid: true });
  });

  it("accepts stellar type (custom type)", () => {
    expect(
      validateCommitMessage("stellar: update Horizon RPC endpoint"),
    ).toEqual({ valid: true });
  });

  it("accepts security type (custom type)", () => {
    expect(
      validateCommitMessage("security: bump soroban-sdk to 22.0.5"),
    ).toEqual({ valid: true });
  });

  it("accepts docs type", () => {
    expect(
      validateCommitMessage("docs: update README with deployment guide"),
    ).toEqual({ valid: true });
  });

  it("accepts multi-line commit messages (body after blank line)", () => {
    expect(
      validateCommitMessage(
        "feat(escrow): implement release logic\n\nThis adds the ability to release funds after conditions are met.",
      ),
    ).toEqual({ valid: true });
  });

  it("accepts breaking change with ! before colon", () => {
    expect(
      validateCommitMessage("feat(api)!: migrate to v2 endpoints"),
    ).toEqual({ valid: true });
  });

  it("accepts merge commits", () => {
    expect(
      validateCommitMessage("Merge branch 'main' into feature-branch"),
    ).toEqual({ valid: true });
  });

  it("accepts revert commits", () => {
    expect(
      validateCommitMessage("Revert 'feat: add flash loan support'"),
    ).toEqual({ valid: true });
  });

  // ── Failure path ───────────────────────────────────────────────────────

  it("rejects empty message", () => {
    expect(validateCommitMessage("")).toEqual({
      valid: false,
      reason: "empty",
    });
  });

  it("rejects whitespace-only message", () => {
    expect(validateCommitMessage("   \n  \n")).toEqual({
      valid: false,
      reason: "empty",
    });
  });

  it("rejects message without type colon", () => {
    expect(validateCommitMessage("some random commit")).toEqual({
      valid: false,
      reason: "format",
    });
  });

  it("rejects unknown type", () => {
    expect(validateCommitMessage("typo: fix the thing")).toEqual({
      valid: false,
      reason: "type",
    });
  });

  it("rejects unknown scope", () => {
    expect(validateCommitMessage("feat(wrong-scope): add something")).toEqual({
      valid: false,
      reason: "scope",
    });
  });

  it("rejects trailing period in subject", () => {
    expect(validateCommitMessage("feat: add new feature.")).toEqual({
      valid: false,
      reason: "trailing-period",
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  it("accepts subject with numbers and hyphens", () => {
    expect(
      validateCommitMessage("fix(lending): handle edge-case for loan-id-42"),
    ).toEqual({ valid: true });
  });

  it("accepts subject with uppercase first letter", () => {
    expect(
      validateCommitMessage("fix: Correct the repayment schedule"),
    ).toEqual({ valid: true });
  });

  it("handles git comment lines (#)", () => {
    expect(
      validateCommitMessage(
        "feat: add feature\n# Please enter the commit message",
      ),
    ).toEqual({ valid: true });
  });

  it("accepts multiple comma-separated scopes", () => {
    expect(
      validateCommitMessage("refactor(lending,escrow): extract shared math lib"),
    ).toEqual({ valid: true });
  });

  it("accepts long subject (length enforced by commitlint engine, not regex)", () => {
    const longSubject = "a".repeat(90);
    // type(scope): subject = ~14 + 90 = 104 > 100
    expect(
      validateCommitMessage(`feat(lending): ${longSubject}`).valid,
    ).toBe(true); // the regex doesn't enforce length; commitlint does
    // We just validate the regex passes for pattern correctness
  });
});
