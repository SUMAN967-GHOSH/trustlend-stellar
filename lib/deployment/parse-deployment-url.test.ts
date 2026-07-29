import { describe, it, expect } from "vitest";
import { parseDeploymentUrl, buildPreviewComment } from "./parse-deployment-url";

const VALID_URL = "https://trustlend-preview-abc123.vercel.app";

describe("parseDeploymentUrl", () => {
  // ── Success path ──────────────────────────────────────────────

  it("extracts a valid URL from plain output", () => {
    expect(parseDeploymentUrl(VALID_URL)).toBe(VALID_URL);
  });

  it("trims surrounding whitespace", () => {
    expect(parseDeploymentUrl(`  ${VALID_URL}\n`)).toBe(VALID_URL);
  });

  it("picks the last http line from multi-line output (build logs + URL)", () => {
    const multiLine = [
      "> Running vercel deploy --prebuilt",
      "> Using Team Acme",
      VALID_URL,
    ].join("\n");
    expect(parseDeploymentUrl(multiLine)).toBe(VALID_URL);
  });

  it("picks the last URL when there are multiple http lines", () => {
    const multiUrl = [
      "https://some-intermediate-step.example.com",
      VALID_URL,
    ].join("\n");
    expect(parseDeploymentUrl(multiUrl)).toBe(VALID_URL);
  });

  it("handles Windows-style line endings", () => {
    expect(parseDeploymentUrl(`${VALID_URL}\r\n`)).toBe(VALID_URL);
  });

  // ── Failure path ──────────────────────────────────────────────

  it("throws on empty string", () => {
    expect(() => parseDeploymentUrl("")).toThrow("Empty Vercel deploy output");
  });

  it("throws on whitespace-only string", () => {
    expect(() => parseDeploymentUrl("   \n  \n  ")).toThrow(
      "Empty Vercel deploy output",
    );
  });

  it("throws when no http line exists", () => {
    expect(() => parseDeploymentUrl("Some random log line")).toThrow(
      "No valid deployment URL found",
    );
  });

  it("throws when the http line is not a proper URL", () => {
    // The regex checks the general shape, but an invalid hostname after
    // the domain may still be caught by URL constructor.
    expect(() =>
      parseDeploymentUrl("https://not a valid url because spaces!   "),
    ).toThrow();
  });

  // ── Edge cases ────────────────────────────────────────────────

  it("handles output with excessive newlines", () => {
    expect(parseDeploymentUrl(`\n\n\n${VALID_URL}\n\n\n`)).toBe(VALID_URL);
  });

  it("throws on non-https URL", () => {
    expect(() =>
      parseDeploymentUrl("http://insecure-preview.example.vercel.app"),
    ).toThrow("Deployment URL must use HTTPS");
  });
});

describe("buildPreviewComment", () => {
  it("includes the deployment URL in the generated Markdown", () => {
    const comment = buildPreviewComment(VALID_URL);
    expect(comment).toContain(VALID_URL);
    expect(comment).toContain("Vercel Preview Deployment");
  });
});
