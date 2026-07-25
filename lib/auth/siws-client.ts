"use client";

/**
 * lib/auth/siws-client.ts
 *
 * Browser side of Sign-In with Stellar (SEP-0010):
 *   connect wallet → fetch challenge → sign with Freighter/Albedo →
 *   verify on the backend → adopt the returned Supabase session.
 */

import { getBrowserSupabaseClient } from "@/lib/supabase/client";
import {
  getConnectedWallet,
  signTransactionWithWallet,
  type StellarWalletProvider,
} from "@/lib/stellar/wallet";
import { normalizeUserRole, type UserRole } from "@/lib/auth/roles";

export interface SiwsResult {
  address: string;
  role: UserRole;
  isNewUser: boolean;
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let payload: Record<string, unknown> = {};
  try {
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON error body */
  }
  return { res, payload };
}

/**
 * Run the full SIWS flow. Resolves with the signed-in identity, or throws an
 * `Error` whose message is safe to show the user (mapped from server codes).
 */
export async function signInWithStellar(
  preferredProvider?: StellarWalletProvider
): Promise<SiwsResult> {
  const supabase = getBrowserSupabaseClient();
  if (!supabase) {
    throw new Error("Supabase is not configured in this environment.");
  }

  // 1. Connect the wallet (Freighter by default).
  const wallet = await getConnectedWallet(preferredProvider);
  const address = wallet.address;

  // 2. Request a SEP-10 challenge.
  const challenge = await postJson("/api/auth/siws/challenge", { address });
  if (!challenge.res.ok) {
    throw new Error((challenge.payload.error as string) ?? "Could not start Stellar sign-in.");
  }
  const transaction = challenge.payload.transaction as string;
  const networkPassphrase = challenge.payload.networkPassphrase as string;
  if (!transaction) {
    throw new Error("The server did not return a challenge transaction.");
  }

  // 3. Sign the challenge with the wallet.
  const signed = await signTransactionWithWallet({
    xdr: transaction,
    networkPassphrase,
    address,
    provider: wallet.provider,
  });

  // 4. Verify + obtain a Supabase session.
  const verify = await postJson("/api/auth/siws/verify", {
    address,
    signedTxXdr: signed.signedTxXdr,
  });
  if (!verify.res.ok) {
    throw new Error(mapVerifyError(verify.payload));
  }
  const accessToken = verify.payload.access_token as string;
  const refreshToken = verify.payload.refresh_token as string;
  if (!accessToken || !refreshToken) {
    throw new Error("Sign-in succeeded but no session was returned.");
  }

  // 5. Adopt the session (persists cookies for SSR + client).
  const { data, error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (error) {
    throw new Error(`Could not establish session: ${error.message}`);
  }

  const role = normalizeUserRole(data.user?.user_metadata?.account_type);
  return { address, role, isNewUser: Boolean(verify.payload.isNewUser) };
}

/** Map backend SIWS error codes to friendly, actionable messages. */
function mapVerifyError(payload: Record<string, unknown>): string {
  const code = payload.code as string | undefined;
  const fallback = (payload.error as string) ?? "Stellar sign-in failed.";
  switch (code) {
    case "expired_challenge":
      return "Your sign-in request expired. Please try again.";
    case "invalid_signature":
      return "We couldn't verify your wallet signature. Please try again.";
    case "address_mismatch":
      return "The signature didn't match the connected wallet. Reconnect and retry.";
    case "invalid_address":
      return "That wallet address is not valid.";
    case "invalid_challenge":
      return "The sign-in challenge was invalid. Please retry.";
    case "not_configured":
    case "session_failed":
      return "Stellar sign-in is temporarily unavailable. Please try another method.";
    default:
      return fallback;
  }
}
