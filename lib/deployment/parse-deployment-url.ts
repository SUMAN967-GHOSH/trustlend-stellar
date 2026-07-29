/**
 * Parses a Vercel deployment URL from the raw CLI output.
 *
 * The `vercel deploy --prebuilt` command outputs the full URL on the final line
 * (e.g. "https://trustlend-project-name.vercel.app").
 * This function trims surrounding whitespace, discards any informational lines
 * that do not start with "http", and validates the URL.
 */

const URL_REGEX = /^https?:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9][a-z0-9-]*\.[a-z]+/i;

/**
 * Extracts the deployment URL from the raw STDOUT of `vercel deploy --prebuilt`.
 *
 * @param rawOutput - The full stdout from the vercel CLI command.
 * @returns The cleaned deployment URL.
 * @throws {Error} If no valid URL can be extracted.
 */
export function parseDeploymentUrl(rawOutput: string): string {
  if (!rawOutput || rawOutput.trim().length === 0) {
    throw new Error("Empty Vercel deploy output — no URL to parse");
  }

  // Split into lines and take the last line that looks like a URL
  const lines = rawOutput.trim().split(/\r?\n/);
  const urlCandidates = lines.filter((line) => URL_REGEX.test(line.trim()));

  if (urlCandidates.length === 0) {
    throw new Error(
      `No valid deployment URL found in Vercel output.\nOutput:\n${rawOutput.slice(0, 500)}`,
    );
  }

  const url = urlCandidates[urlCandidates.length - 1].trim();

  // Validate the URL is well-formed
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error("Deployment URL must use HTTPS");
    }
    return url;
  } catch (cause) {
    throw new Error(
      `Extracted candidate "${url}" is not a valid URL`,
      { cause },
    );
  }
}

/**
 * Builds a Markdown comment body for PRs that includes the preview link.
 */
export function buildPreviewComment(deploymentUrl: string): string {
  return [
    "## ✅ Vercel Preview Deployment",
    "",
    `🔗 **Preview URL:** ${deploymentUrl}`,
    "",
    "This preview was automatically deployed for this pull request. Every new push will update the preview automatically.",
  ].join("\n");
}
