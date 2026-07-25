/**
 * lib/auth/siws-config.ts
 *
 * Shared (client + server safe) configuration for Sign-In with Stellar (SIWS),
 * an implementation of SEP-0010 Web Authentication used as a Web3-native login.
 * Contains NO secrets — only public domains / network settings.
 */

export const SIWS_NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ??
  "Test SDF Network ; September 2015";

/**
 * The `home_domain` / `web_auth_domain` used to build & verify the SEP-10
 * challenge. Both sides MUST agree, so it is derived deterministically:
 *   NEXT_PUBLIC_SIWS_DOMAIN  →  host of NEXT_PUBLIC_SITE_URL  →  "localhost:3000".
 */
export function getSiwsDomain(): string {
  const explicit = process.env.NEXT_PUBLIC_SIWS_DOMAIN;
  if (explicit) return explicit.replace(/^https?:\/\//, "").replace(/\/$/, "");

  const site = process.env.NEXT_PUBLIC_SITE_URL;
  if (site) {
    try {
      return new URL(site).host;
    } catch {
      /* fall through */
    }
  }
  return "localhost:3000";
}
