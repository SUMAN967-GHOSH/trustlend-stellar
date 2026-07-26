import { NextRequest, NextResponse } from "next/server";
import {
  issueSessionForWallet,
  SiwsError,
  verifyChallenge,
} from "@/lib/auth/siws-server";
import { enforceRouteRateLimit } from "@/lib/rate-limit";

/**
 * POST /api/auth/siws/verify
 *
 * Steps 4-5 of Sign-In with Stellar (SEP-0010). Validates the wallet-signed
 * challenge (structure, expiry, signature) and — on success — provisions /
 * signs in the wallet's Supabase user, returning session tokens the client
 * adopts via `supabase.auth.setSession(...)`.
 *
 * Body: { address: "G...", signedTxXdr: "<base64 XDR>" }
 * 200:  { access_token, refresh_token, isNewUser }
 * 4xx:  { error, code }   (invalid_address | invalid_challenge | expired_challenge
 *                          | invalid_signature | address_mismatch | ...)
 */
export async function POST(request: NextRequest) {
  const rateLimited = await enforceRouteRateLimit(request);
  if (rateLimited) return rateLimited;

  try {
    const { address, signedTxXdr } = (await request.json()) as {
      address?: string;
      signedTxXdr?: string;
    };
    if (!address || !signedTxXdr) {
      return NextResponse.json(
        { error: "address and signedTxXdr are required", code: "invalid_challenge" },
        { status: 400 }
      );
    }

    // Validate the SEP-10 challenge — throws SiwsError with a clear code/status.
    const wallet = verifyChallenge(signedTxXdr, address);

    // Provision / sign in the wallet identity and return the session.
    const { session, isNewUser } = await issueSessionForWallet(wallet);

    return NextResponse.json({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      isNewUser,
    });
  } catch (err) {
    if (err instanceof SiwsError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    const msg = err instanceof Error ? err.message : "Unexpected error";
    console.error("[siws/verify]", msg);
    return NextResponse.json(
      { error: "Authentication failed", code: "session_failed" },
      { status: 500 }
    );
  }
}
