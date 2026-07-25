/**
 * lib/auth/siws-server.ts
 *
 * Server-side Sign-In with Stellar (SEP-0010) logic:
 *   1. buildChallenge()  — generate a signed SEP-10 challenge transaction
 *   2. verifyChallenge() — validate structure, expiry and the wallet signature
 *   3. issueSessionForWallet() — mint a Supabase session for the wallet identity
 *
 * SERVER-ONLY. Reads SIWS_SERVER_SECRET / SIWS_PASSWORD_SECRET / service-role key.
 */

import { createHmac } from "node:crypto";
import { Keypair, StrKey, Transaction, WebAuth } from "@stellar/stellar-sdk";
import { createClient, type Session } from "@supabase/supabase-js";
import { SIWS_NETWORK_PASSPHRASE, getSiwsDomain } from "@/lib/auth/siws-config";

/** SEP-10 challenge validity window (seconds). */
const CHALLENGE_TIMEOUT_SECS = 300;

// ─── Typed errors → clean HTTP states ─────────────────────────────────────────

export type SiwsErrorCode =
  | "invalid_address"
  | "not_configured"
  | "invalid_challenge"
  | "expired_challenge"
  | "invalid_signature"
  | "address_mismatch"
  | "session_failed";

export class SiwsError extends Error {
  constructor(
    public code: SiwsErrorCode,
    message: string,
    /** HTTP status the API route should return. */
    public status: number
  ) {
    super(message);
    this.name = "SiwsError";
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

/** The SEP-10 server signing keypair (its public key is the challenge source). */
function getServerKeypair(): Keypair {
  const secret = process.env.SIWS_SERVER_SECRET;
  if (!secret) {
    throw new SiwsError(
      "not_configured",
      "SIWS is not configured on the server (SIWS_SERVER_SECRET missing).",
      503
    );
  }
  try {
    return Keypair.fromSecret(secret);
  } catch {
    throw new SiwsError("not_configured", "SIWS_SERVER_SECRET is not a valid Stellar secret key.", 503);
  }
}

/** Public server signing key — safe to expose (advertised in a SEP-1 toml). */
export function getServerSigningKey(): string {
  return getServerKeypair().publicKey();
}

export function assertValidStellarAddress(address: string): void {
  if (typeof address !== "string" || !StrKey.isValidEd25519PublicKey(address)) {
    throw new SiwsError("invalid_address", "A valid Stellar public key (G...) is required.", 400);
  }
}

// ─── 1. Build challenge ───────────────────────────────────────────────────────

export function buildChallenge(address: string): { transaction: string; networkPassphrase: string } {
  assertValidStellarAddress(address);
  const server = getServerKeypair();
  const domain = getSiwsDomain();

  const transaction = WebAuth.buildChallengeTx(
    server,
    address,
    domain,
    CHALLENGE_TIMEOUT_SECS,
    SIWS_NETWORK_PASSPHRASE,
    domain
  );

  return { transaction, networkPassphrase: SIWS_NETWORK_PASSPHRASE };
}

// ─── 2. Verify challenge ──────────────────────────────────────────────────────

/**
 * Validate a wallet-signed SEP-10 challenge. Returns the authenticated wallet
 * address on success; throws a typed `SiwsError` otherwise so the API can emit
 * clear invalid / expired states.
 */
export function verifyChallenge(signedTxXdr: string, expectedAddress: string): string {
  assertValidStellarAddress(expectedAddress);
  const serverKey = getServerSigningKey();
  const domain = getSiwsDomain();

  if (typeof signedTxXdr !== "string" || signedTxXdr.length < 20) {
    throw new SiwsError("invalid_challenge", "Missing or malformed signed challenge.", 400);
  }

  // Structure validation (sequence=0, single manage_data op, home domain, etc.)
  let clientAccountID: string;
  try {
    const result = WebAuth.readChallengeTx(
      signedTxXdr,
      serverKey,
      SIWS_NETWORK_PASSPHRASE,
      domain,
      domain
    );
    clientAccountID = result.clientAccountID;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/expired|timebound|too far/i.test(msg)) {
      throw new SiwsError("expired_challenge", "The challenge has expired. Please try again.", 401);
    }
    throw new SiwsError("invalid_challenge", `Invalid challenge transaction: ${msg}`, 400);
  }

  // Explicit expiry check: this SDK's readChallengeTx validates structure but
  // does NOT enforce timeBounds against wall-clock time, so we check it here.
  const parsedForTimebounds = new Transaction(signedTxXdr, SIWS_NETWORK_PASSPHRASE);
  const maxTime = Number.parseInt(parsedForTimebounds.timeBounds?.maxTime ?? "0", 10);
  const nowSecs = Math.floor(Date.now() / 1000);
  if (maxTime > 0 && nowSecs > maxTime) {
    throw new SiwsError("expired_challenge", "The challenge has expired. Please try again.", 401);
  }

  if (clientAccountID !== expectedAddress) {
    throw new SiwsError(
      "address_mismatch",
      "The signed challenge does not match the provided wallet address.",
      400
    );
  }

  // Signature validation — the wallet must have signed the challenge.
  try {
    const signers = WebAuth.verifyChallengeTxSigners(
      signedTxXdr,
      serverKey,
      SIWS_NETWORK_PASSPHRASE,
      [expectedAddress],
      domain,
      domain
    );
    if (!signers.includes(expectedAddress)) {
      throw new SiwsError("invalid_signature", "The wallet signature is missing or invalid.", 401);
    }
  } catch (err) {
    if (err instanceof SiwsError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/expired|timebound/i.test(msg)) {
      throw new SiwsError("expired_challenge", "The challenge has expired. Please try again.", 401);
    }
    throw new SiwsError("invalid_signature", `Signature verification failed: ${msg}`, 401);
  }

  return expectedAddress;
}

// ─── 3. Issue a Supabase session for the wallet identity ──────────────────────

/** Deterministic e-mail identity for a wallet (never receives real mail). */
export function walletEmail(address: string): string {
  return `${address.toLowerCase()}@siws.trustlend.app`;
}

/**
 * Server-derived, deterministic password for the wallet's Supabase user.
 * Never leaves the server — used only to mint a session after SEP-10 passes.
 */
function walletPassword(address: string): string {
  const secret = process.env.SIWS_PASSWORD_SECRET;
  if (!secret) {
    throw new SiwsError(
      "not_configured",
      "SIWS is not configured on the server (SIWS_PASSWORD_SECRET missing).",
      503
    );
  }
  return createHmac("sha256", secret).update(address).digest("hex");
}

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new SiwsError("session_failed", "Supabase service role is not configured.", 503);
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/**
 * Ensure a Supabase user exists for `address` and return a fresh session
 * (access + refresh tokens) the client can adopt via `auth.setSession`.
 */
export async function issueSessionForWallet(address: string): Promise<{
  session: Session;
  isNewUser: boolean;
}> {
  const email = walletEmail(address);
  const password = walletPassword(address);
  const admin = adminClient();

  // Create the wallet user if it doesn't exist yet (idempotent).
  let isNewUser = false;
  const { error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      wallet_address: address,
      account_type: "borrower",
      auth_method: "siws",
      full_name: `Stellar ${address.slice(0, 4)}…${address.slice(-4)}`,
    },
  });

  if (createErr) {
    const msg = createErr.message?.toLowerCase() ?? "";
    const alreadyExists =
      msg.includes("already been registered") ||
      msg.includes("already registered") ||
      msg.includes("email_exists") ||
      (createErr as { code?: string }).code === "email_exists";
    if (!alreadyExists) {
      throw new SiwsError("session_failed", `Could not provision wallet account: ${createErr.message}`, 500);
    }
  } else {
    isNewUser = true;
  }

  // Mint a session with the deterministic password (never returned to client).
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const authClient = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw new SiwsError("session_failed", `Failed to issue session: ${error?.message ?? "no session"}`, 500);
  }

  return { session: data.session, isNewUser };
}
