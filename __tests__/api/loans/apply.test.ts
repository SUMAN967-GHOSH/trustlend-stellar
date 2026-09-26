import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mock Auth ─────────────────────────────────────────────────────────────────
const mockRequireAuthenticatedUser = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAuthenticatedUser: (...args: unknown[]) => mockRequireAuthenticatedUser(...args),
}));

// ── Mock Rate Limiter ─────────────────────────────────────────────────────────
vi.mock("@/lib/rate-limit", () => ({
  enforceRouteRateLimit: vi.fn().mockResolvedValue(null),
}));

// ── Mock KYC Guard ────────────────────────────────────────────────────────────
vi.mock("@/lib/kyc/middleware", () => ({
  requireKycVerified: vi.fn().mockResolvedValue({ allowed: true, kycStatus: "verified" }),
}));

// ── Mock Notifications ────────────────────────────────────────────────────────
vi.mock("@/lib/notifications", () => ({
  createNotification: vi.fn().mockResolvedValue({ id: "notif-1" }),
}));

// ── Mock database ─────────────────────────────────────────────────────────────
const mockGetDb = vi.fn();
vi.mock("@/lib/db/client", () => ({
  getDb: () => mockGetDb(),
}));

import { POST } from "@/app/api/loans/apply/route";
import { createFakeDb } from "../../helpers/fake-db";

function makeMockRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/loans/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/loans/apply - Minimum Borrow Amount Validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuthenticatedUser.mockResolvedValue({
      user: { id: "borrower-123", email: "borrower@example.com" },
      role: "borrower",
    });
  });

  it("rejects dust loan amount below 1 XLM with 400 status", async () => {
    mockGetDb.mockReturnValue(createFakeDb());

    const req = makeMockRequest({
      amount: 0.0000001,
      durationDays: 30,
      rateModel: "fixed",
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toContain("minimum borrow amount is 1 XLM");
  });

  it("rejects zero or negative loan amounts with 400 status", async () => {
    mockGetDb.mockReturnValue(createFakeDb());

    const req = makeMockRequest({
      amount: 0,
      durationDays: 30,
      rateModel: "fixed",
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toContain("minimum borrow amount is 1 XLM");
  });
});

// ─── Dynamic interest rates (issue #321) ──────────────────────────────────────

describe("POST /api/loans/apply - Dynamic APR from the admin schedule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuthenticatedUser.mockResolvedValue({
      user: { id: "borrower-123", email: "borrower@example.com", walletAddress: "GBORROWER" },
      role: "borrower",
    });
  });

  /**
   * Queues the reads a preflight request makes, in order: the active-loan
   * check, the reputation snapshot, then the active rate schedule.
   */
  function queuePreflightReads(
    db: ReturnType<typeof createFakeDb>,
    options: {
      reputationScore?: number;
      rateConfigRow?: Record<string, unknown> | null;
    } = {},
  ) {
    db.queue([]); // no existing active loans
    db.queue([{ scoreTotal: options.reputationScore ?? 800 }]);
    db.queue(options.rateConfigRow === null ? [] : [options.rateConfigRow]);
    return db;
  }

  it("prices a loan from the active database schedule, not a hardcoded ladder", async () => {
    const db = queuePreflightReads(createFakeDb(), {
      rateConfigRow: {
        rateModel: "fixed",
        version: 4,
        baseAprBps: 1800, // deliberately unlike any previously hardcoded value
        minAprBps: 100,
        maxAprBps: 5000,
        amountTiers: [{ minAmount: 500, aprBps: 1650 }],
        reputationTiers: [{ minScore: 0, multiplierBps: 10000 }],
        notes: "Market repricing",
        updatedByEmail: "admin@trustlend.org",
        updatedAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    mockGetDb.mockReturnValue(db);

    const res = await POST(
      makeMockRequest({ amount: 750, durationDays: 30, rateModel: "fixed", preflight: true }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.aprBps).toBe(1650); // from the 500-XLM tier in the stored schedule
    expect(json.rateConfigVersion).toBe(4);
  });

  it("applies the trust score multiplier from the schedule", async () => {
    const rateConfigRow = {
      rateModel: "fixed",
      version: 2,
      baseAprBps: 1500,
      minAprBps: 100,
      maxAprBps: 5000,
      amountTiers: [{ minAmount: 100, aprBps: 1200 }],
      reputationTiers: [
        { minScore: 0, multiplierBps: 11000 },
        { minScore: 750, multiplierBps: 9000 },
      ],
      notes: "Trust-weighted pricing",
      updatedByEmail: "admin@trustlend.org",
      updatedAt: null,
    };

    mockGetDb.mockReturnValue(
      queuePreflightReads(createFakeDb(), { reputationScore: 800, rateConfigRow }),
    );
    const trustedRes = await POST(
      makeMockRequest({ amount: 500, durationDays: 30, rateModel: "fixed", preflight: true }),
    );
    const trusted = await trustedRes.json();

    mockGetDb.mockReturnValue(
      queuePreflightReads(createFakeDb(), { reputationScore: 300, rateConfigRow }),
    );
    const newcomerRes = await POST(
      makeMockRequest({ amount: 500, durationDays: 30, rateModel: "fixed", preflight: true }),
    );
    const newcomer = await newcomerRes.json();

    expect(trusted.aprBps).toBe(1080); // 1200 * 0.90
    expect(newcomer.aprBps).toBe(1320); // 1200 * 1.10
    expect(trusted.rateBreakdown.reputationMultiplierBps).toBe(9000);
    expect(newcomer.rateBreakdown.reputationMultiplierBps).toBe(11000);
  });

  it("falls back to the pre-#321 rates when no schedule is published", async () => {
    mockGetDb.mockReturnValue(
      queuePreflightReads(createFakeDb(), { reputationScore: 800, rateConfigRow: null }),
    );

    const res = await POST(
      makeMockRequest({ amount: 1500, durationDays: 30, rateModel: "fixed", preflight: true }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.aprBps).toBe(1200); // the old 12% tier for 1000 < amount <= 2000
    expect(json.rateConfigVersion).toBe(0); // version 0 marks a code default
  });

  it("quotes the floating schedule separately from the fixed one", async () => {
    mockGetDb.mockReturnValue(
      queuePreflightReads(createFakeDb(), {
        reputationScore: 800,
        rateConfigRow: {
          rateModel: "floating",
          version: 1,
          baseAprBps: 600,
          minAprBps: 100,
          maxAprBps: 5000,
          amountTiers: [],
          reputationTiers: [],
          notes: "Floating base",
          updatedByEmail: "admin@trustlend.org",
          updatedAt: null,
        },
      }),
    );

    const res = await POST(
      makeMockRequest({ amount: 5000, durationDays: 60, rateModel: "floating", preflight: true }),
    );

    const json = await res.json();
    expect(json.rateModel).toBe("floating");
    expect(json.aprBps).toBe(600); // base APR: this schedule defines no tiers
  });

  it("still rejects an unsupported rate model", async () => {
    mockGetDb.mockReturnValue(createFakeDb());

    const res = await POST(
      makeMockRequest({ amount: 500, durationDays: 30, rateModel: "variable" }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Invalid rate model");
  });
});
