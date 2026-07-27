/**
 * Shared TypeScript types for the KYC provider integration.
 * Provider: SumSub (https://sumsub.com)
 * These types are provider-agnostic where possible so that switching
 * providers only requires changing lib/kyc/provider.ts.
 */

// ── Internal app KYC statuses ─────────────────────────────────────────────────
export type KycStatus = "pending" | "submitted" | "verified" | "rejected";

// ── SumSub webhook event types we handle ─────────────────────────────────────
export type SumSubReviewAnswer = "GREEN" | "RED";

export type SumSubWebhookType =
  | "applicantCreated"
  | "applicantPending"
  | "applicantReviewed"
  | "applicantOnHold";

export interface SumSubReviewResult {
  reviewAnswer: SumSubReviewAnswer;
  rejectLabels?: string[];
  reviewRejectType?: "FINAL" | "RETRY";
  clientComment?: string;
  moderationComment?: string;
}

/**
 * Payload shape for SumSub webhook callbacks.
 * Reference: https://docs.sumsub.com/reference/webhook-payloads
 */
export interface SumSubWebhookPayload {
  applicantId: string;
  inspectionId?: string;
  correlationId?: string;
  externalUserId: string; // our user UUID
  type: SumSubWebhookType;
  reviewStatus?: string;
  createdAt?: string;
  reviewResult?: SumSubReviewResult;
}

// ── Result returned from createApplicant / generateSdkToken ──────────────────
export interface KycApplicantResult {
  applicantId: string;
  token: string;
  expiresAt: string;
}

// ── Config loaded from environment ───────────────────────────────────────────
export interface KycProviderConfig {
  appToken: string;
  secretKey: string;
  webhookSecret: string;
  baseUrl: string;
  levelName: string;
}
