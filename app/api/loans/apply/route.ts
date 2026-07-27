import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { requireKycVerified } from "@/lib/kyc/middleware";
import { isRedirectError } from "next/dist/client/components/redirect-error";

export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await enforceRouteRateLimit(request);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const { user } = await requireAuthenticatedUser("borrower");
    const supabase = await getServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    // ── KYC guard: regulated pools require verified identity ─────────────────
    const kycCheck = await requireKycVerified(user.id, supabase);
    if (!kycCheck.allowed) {
      return NextResponse.json(
        { error: kycCheck.reason, kycStatus: kycCheck.kycStatus },
        { status: 403 }
      );
    }

    // ── Parse body ──────────────────────────────────────────────────────────
    const body = await request.json();
    const amount: number = body.amount;
    const durationDays: number = body.durationDays ?? body.duration_days;
    const rateModel: string = (body.rateModel ?? body.rate_model ?? "fixed").toLowerCase();

    if (!amount || amount <= 0) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }

    if (!durationDays || ![30, 60, 90].includes(Number(durationDays))) {
      return NextResponse.json(
        { error: `Invalid duration: must be 30, 60, or 90 days` },
        { status: 400 }
      );
    }

    if (!['fixed', 'floating'].includes(rateModel)) {
      return NextResponse.json(
        { error: `Invalid rate model: must be 'fixed' or 'floating'` },
        { status: 400 }
      );
    }

    // ── 1. Anti-scam: only ONE active loan at a time ─────────────────────────
    const { data: existingLoans } = await supabase
      .from("loans")
      .select("id, status")
      .eq("borrower_id", user.id)
      .not("status", "in", '("repaid","defaulted","cancelled")')
      .limit(1);

    if (existingLoans && existingLoans.length > 0) {
      return NextResponse.json(
        {
          error:
            "You already have an active or pending loan. Repay or close it before applying for a new one.",
        },
        { status: 400 }
      );
    }

    // ── 2. Reputation / credit limit check ───────────────────────────────────
    const { data: reputation } = await supabase
      .from("reputation_snapshots")
      .select("score_total")
      .eq("user_id", user.id)
      .maybeSingle();

    const reputationScore: number = reputation?.score_total ?? 250;
    const maxLoan = reputationScore * 10;

    if (amount > maxLoan) {
      return NextResponse.json(
        { error: `Exceeds your credit limit of ${maxLoan} XLM (trust score: ${reputationScore}).` },
        { status: 400 }
      );
    }

    // ── 3. Calculate APR ─────────────────────────────────────────────────────────
    let aprBps: number;
    if (rateModel === 'floating') {
      // Floating rate: base 5% + utilization slope
      // Start lower than fixed — the rate will be updated dynamically
      aprBps = 500; // 5% base floating rate
      if (amount > 2000) aprBps = 400;
      else if (amount > 1000) aprBps = 450;
    } else {
      // Fixed rate: locked at creation (traditional tiered model)
      aprBps = 1500; // 15% default
      if (amount > 2000) aprBps = 1000;       // 10%
      else if (amount > 1000) aprBps = 1200;  // 12%
    }

    // ── 4. Try to auto-assign a pool with enough liquidity ───────────────────
    // This is optional — loan is still created without a pool (direct P2P path)
    const { data: availablePools } = await supabase
      .from("lending_pools")
      .select("id, available_liquidity")
      .eq("status", "active")
      .gte("available_liquidity", amount)
      .order("available_liquidity", { ascending: false })
      .limit(1);

    const poolId = availablePools && availablePools.length > 0
      ? availablePools[0].id
      : null; // loan will be funded directly by a lender

    // ── 5. Create the loan ───────────────────────────────────────────────────
    const { data: loan, error: loanError } = await supabase
      .from("loans")
      .insert({
        borrower_id: user.id,
        ...(poolId ? { pool_id: poolId } : {}),
        principal_amount: amount,
        apr_bps: aprBps,
        duration_days: Number(durationDays),
        status: "requested",
        metadata: {
          rate_model: rateModel,
        },
      })
      .select()
      .single();

    if (loanError) {
      return NextResponse.json({ error: loanError.message }, { status: 500 });
    }

    // ── 6. Record request in ledger for traceability ────────────────────────
    const { error: ledgerError } = await supabase
      .from("ledger_transactions")
      .insert({
        user_id: user.id,
        category: "loan_request",
        amount: Number(amount),
        currency: "XLM",
        status: "confirmed",
        ref_type: "loan_request",
        ref_id: String(loan.id),
        metadata: {
          stage: "requested",
          loanId: String(loan.id),
          durationDays: Number(durationDays),
          aprBps,
          rateModel,
          fundingPath: poolId ? "pool" : "direct",
        },
      });

    if (ledgerError) {
      // Roll back the just-created loan to keep invariants strict: every request must have a ledger entry.
      await supabase
        .from("loans")
        .delete()
        .eq("id", String(loan.id))
        .eq("borrower_id", user.id);
      return NextResponse.json({ error: `Failed to record transaction trail: ${ledgerError.message}` }, { status: 500 });
    }

    // ── Emit notification ──
    const { createNotification } = await import("@/lib/notifications");
    await createNotification({
      userId: user.id,
      title: "Loan Request Submitted",
      message: `Your ${rateModel}-rate request for ${amount} XLM is now live in the marketplace and waiting for lender funding.`,
      type: "loan_requested",
    });

    return NextResponse.json(
      {
        loan,
        rateModel,
        fundingPath: poolId ? "pool" : "direct",
        message: poolId
          ? `Your ${rateModel}-rate loan request has been submitted. A lending pool has been assigned — it will be processed shortly.`
          : `Your ${rateModel}-rate loan request is now open. A lender will fund it directly. You'll receive XLM in your wallet once funded.`,
      },
      { status: 201 }
    );
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    console.error("Loan application error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
