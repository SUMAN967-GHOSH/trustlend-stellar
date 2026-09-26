import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { loans } from "@/lib/db/schema";
import { getLoanLenders } from "@/lib/loans/lenders";
import { MAX_LENDERS_PER_REPAYMENT } from "@/lib/loans/funding";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { calculateEarlyRepayment, getElapsedDays } from "@/lib/dashboard/interest-rates";
import { getPlatformFeeBps, resolveLoanFeeBps } from "@/lib/platform/settings";

/**
 * GET /api/loans/repay/preflight?loanId=...&daysElapsed=...
 *
 * Returns: lender wallet address + exact repayment breakdown (with early repayment
 * adjusted interest calculations) so the client can build and sign the on-chain Stellar
 * payment before calling POST /api/loans/repay.
 */
export async function GET(request: NextRequest) {
  try {
    // ── Rate limit ───────────────────────────────────────────────────────────
    const rateLimited = await enforceRouteRateLimit(request);
    if (rateLimited) return rateLimited;

    const { user } = await requireAuthenticatedUser("borrower");
    const loanId   = request.nextUrl.searchParams.get("loanId");
    if (!loanId) return NextResponse.json({ error: "loanId required" }, { status: 400 });

    const db = getDb();
    if (!db) return NextResponse.json({ error: "Database unavailable" }, { status: 500 });

    const [loanRow] = await db
      .select({
        id: loans.id,
        status: loans.status,
        principalAmount: loans.principalAmount,
        repaidAmount: loans.repaidAmount,
        aprBps: loans.aprBps,
        durationDays: loans.durationDays,
        createdAt: loans.createdAt,
        metadata: loans.metadata,
      })
      .from(loans)
      .where(and(eq(loans.id, loanId), eq(loans.borrowerId, user.id)))
      .limit(1);

    if (!loanRow) return NextResponse.json({ error: "Loan not found" }, { status: 404 });
    const loan = {
      status: loanRow.status,
      principal_amount: Number(loanRow.principalAmount),
      repaid_amount: Number(loanRow.repaidAmount),
      apr_bps: loanRow.aprBps,
      duration_days: loanRow.durationDays,
      created_at: loanRow.createdAt.toISOString(),
      metadata: loanRow.metadata,
    };

    const repayableStatuses = ["active", "funded", "approved"];
    if (!repayableStatuses.includes(String(loan.status))) {
      return NextResponse.json({ error: "Loan is not in a repayable state" }, { status: 400 });
    }

    // Find every lender who funded this loan. A loan can be filled by several
    // lenders (Issue #269), so repayment is split pro-rata across all of them.
    const lenders = await getLoanLenders(db, loanId);

    if (lenders.length === 0) {
      return NextResponse.json({ error: "Lender wallet not found for this loan. Cannot process on-chain repayment." }, { status: 422 });
    }

    if (lenders.length > MAX_LENDERS_PER_REPAYMENT) {
      return NextResponse.json(
        {
          error: `This loan has ${lenders.length} lenders, more than a single Stellar transaction can pay out. Contact support to settle it in batches.`,
        },
        { status: 422 }
      );
    }

    // Largest contributor, kept for backwards compatibility with clients that
    // still read a single `lenderAddress`.
    const primaryLender = lenders[0];

    // --- Interest & fee calculation ---
    const principal    = Number(loan.principal_amount ?? 0);
    const alreadyPaid  = Number(loan.repaid_amount ?? 0);
    const durationDays = Number(loan.duration_days ?? 30);
    const aprBps       = Number(loan.apr_bps ?? 0);

    const daysElapsedParam = request.nextUrl.searchParams.get("daysElapsed");
    const computedElapsed = loan.created_at
      ? getElapsedDays(loan.created_at, Date.now(), durationDays)
      : durationDays;
    const elapsedDays = daysElapsedParam && !isNaN(Number(daysElapsedParam))
      ? Math.max(1, Math.min(durationDays, Number(daysElapsedParam)))
      : computedElapsed;

    // Same resolution the POST route uses (issue #324), so the quote the
    // borrower signs against and the amount they are charged always agree.
    const activeFeeSetting = await getPlatformFeeBps(db);
    const resolvedFee = resolveLoanFeeBps({
      principal,
      loanMetadata: loan.metadata,
      activeSetting: activeFeeSetting,
    });

    const earlyRepayment = calculateEarlyRepayment({
      principal,
      aprBps,
      totalDays: durationDays,
      elapsedDays,
      alreadyPaid,
      platformFeeBps: resolvedFee.feeBps,
    });

    const totalInterest   = earlyRepayment.standardInterest;
    const platformFee     = earlyRepayment.platformFee;
    const totalDueGross   = earlyRepayment.standardTotalDue;
    const remainingDue    = earlyRepayment.standardRemainingDue;

    // Platform wallet (set in env, or use a default treasury address for testnet)
    const platformWallet  = process.env.PLATFORM_FEE_WALLET ?? "";

    const totalContributed = lenders.reduce((sum, entry) => sum + entry.contribution, 0);

    return NextResponse.json({
      loanId,
      lenderAddress: primaryLender.address,
      lenderUserId: primaryLender.lenderId,
      // Every lender and the fraction of the loan each funded. Clients build
      // one payment operation per entry.
      lenders: lenders.map((entry) => ({
        address: entry.address,
        lenderUserId: entry.lenderId,
        contribution: +entry.contribution.toFixed(7),
        share: totalContributed > 0 ? +(entry.contribution / totalContributed).toFixed(7) : 0,
      })),
      borrowerAddress: user.walletAddress ?? "",
      breakdown: {
        principal:       +principal.toFixed(7),
        interest:        +totalInterest.toFixed(7),
        platformFee,
        // Which fee was applied and why — "loan" means it was locked at
        // origination, "setting" that this loan predates the lock (#324).
        platformFeeBps:    resolvedFee.feeBps,
        platformFeePct:    +((resolvedFee.feeBps / 10000) * 100).toFixed(4),
        platformFeeSource: resolvedFee.source,
        platformWallet:  platformWallet || null,
        totalDue:        totalDueGross,
        alreadyPaid:     +alreadyPaid.toFixed(7),
        remainingDue,
        aprBps,
        durationDays,
        aprPct:          +((aprBps / 10000) * 100).toFixed(4),
        earlyRepayment: {
          isEarly: earlyRepayment.isEarly,
          elapsedDays: earlyRepayment.elapsedDays,
          daysRemaining: earlyRepayment.daysRemaining,
          adjustedInterest: earlyRepayment.adjustedInterest,
          interestSaved: earlyRepayment.interestSaved,
          interestSavedPct: earlyRepayment.interestSavedPct,
          adjustedTotalDue: earlyRepayment.adjustedTotalDue,
          adjustedRemainingDue: earlyRepayment.adjustedRemainingDue,
        },
      },
    });
  } catch (err) {
    if (isRedirectError(err)) throw err;
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
