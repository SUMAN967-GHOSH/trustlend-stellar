/**
 * Reusable KYC guard for API routes.
 *
 * Usage:
 *   const check = await requireKycVerified(user.id, supabase);
 *   if (!check.allowed) {
 *     return NextResponse.json({ error: check.reason }, { status: 403 });
 *   }
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface KycGuardResult {
  allowed: boolean;
  reason?: string;
  kycStatus?: string;
}

/**
 * Check whether a user has completed KYC verification.
 * Regulated pools and institutional lending require `kyc_status = 'verified'`.
 */
export async function requireKycVerified(
  userId: string,
  supabase: SupabaseClient,
  options: { regulatedPoolOnly?: boolean } = {}
): Promise<KycGuardResult> {
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("kyc_status, regulated_pool_access, risk_status")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    return {
      allowed: false,
      reason: "Unable to verify identity status. Please try again.",
    };
  }

  if (!profile) {
    return {
      allowed: false,
      reason: "Profile not found. Please complete your registration.",
    };
  }

  const kycStatus = (profile.kyc_status as string) ?? "pending";
  const riskStatus = (profile.risk_status as string) ?? "medium";

  // Blocked accounts can never access regulated pools
  if (riskStatus === "blocked") {
    return {
      allowed: false,
      kycStatus,
      reason: "Your account has been blocked. Please contact support.",
    };
  }

  // For regulated pools, require full verification
  if (kycStatus !== "verified") {
    const statusMessages: Record<string, string> = {
      pending:
        "KYC verification is required to access regulated lending pools. Please complete identity verification in your profile settings.",
      submitted:
        "Your KYC documents are under review. You will gain access once verification is complete (typically 1-2 business days).",
      rejected:
        "Your KYC submission was rejected. Please re-submit with a valid government ID in your profile settings.",
    };

    return {
      allowed: false,
      kycStatus,
      reason:
        statusMessages[kycStatus] ??
        "Identity verification is required to access this feature.",
    };
  }

  // For regulated pools specifically, also check the explicit access flag
  if (options.regulatedPoolOnly && !profile.regulated_pool_access) {
    return {
      allowed: false,
      kycStatus,
      reason:
        "Access to regulated institutional pools requires enhanced verification. Please contact support.",
    };
  }

  return { allowed: true, kycStatus };
}

/**
 * Lightweight check — returns `true` if KYC verified, `false` otherwise.
 * Use this for UI gates where you don't need the reason string.
 */
export async function isKycVerified(
  userId: string,
  supabase: SupabaseClient
): Promise<boolean> {
  const { data } = await supabase
    .from("profiles")
    .select("kyc_status")
    .eq("id", userId)
    .maybeSingle();

  return data?.kyc_status === "verified";
}
