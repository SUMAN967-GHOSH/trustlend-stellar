import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { WalletCard } from "@/components/dashboard/WalletCard";
import { Badge } from "@/components/ui/Badge";
import { TermTooltip } from "@/components/ui/TermTooltip";
import type { GlossaryTermKey } from "@/lib/glossary/terms";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import {
  getBorrowerDashboardMetrics,
  presentBorrowerMetrics,
} from "@/lib/dashboard/metrics";
import { getDb } from "@/lib/db/client";
import { getBorrowerLoans, getLedgerByRef, getProfile } from "@/lib/db/queries";
import { buildStellarTxVerificationUrl, extractPossibleTxHash, isLikelyTxHash } from "@/lib/stellar/explorer";
import { BorrowerRepayWidget } from "@/components/dashboard/BorrowerRepayWidget";
import { WithdrawToFiatButton } from "@/components/dashboard/WithdrawToFiatButton";
import { borrowerNavLinks } from "@/lib/dashboard/borrower-links";
import { getFundingProgress } from "@/lib/loans/funding";
import { HealthFactorGauge } from "@/components/dashboard/HealthFactorGauge";
import {
  ASSUMED_COLLATERAL_RATIO,
  computeHealthFactorValuation,
  fetchDashboardPrice,
} from "@/lib/dashboard/collateral-pricing";
import { formatCurrency } from "@/lib/utils/formatting";

// ── Inline SVG illustrations ───────────────────────────────────────────────
function EmptyLoansIllustration() {
  return (
    <svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="8" y="20" width="64" height="44" rx="8" fill="url(#emptyGrad)" opacity="0.9" />
      <rect x="16" y="32" width="24" height="4" rx="2" fill="white" opacity="0.6" />
      <rect x="16" y="42" width="16" height="4" rx="2" fill="white" opacity="0.4" />
      <circle cx="58" cy="38" r="10" fill="white" opacity="0.15" />
      <path d="M40 8 L44 16 L52 16 L46 21 L48 29 L40 24 L32 29 L34 21 L28 16 L36 16 Z"
            fill="url(#starGrad)" opacity="0.8" />
      <defs>
        <linearGradient id="emptyGrad" x1="8" y1="20" x2="72" y2="64" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--primary)" />
          <stop offset="1" stopColor="var(--accent)" />
        </linearGradient>
        <linearGradient id="starGrad" x1="28" y1="8" x2="52" y2="29" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--warning)" />
          <stop offset="1" stopColor="#f7c948" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export default async function BorrowerDashboardPage() {
  const { user } = await requireAuthenticatedUser("borrower");
  const walletAddress = String(user.walletAddress ?? "") || null;
  const metrics = await getBorrowerDashboardMetrics(user.id);

  const db = getDb();
  const [profile, loans] = await Promise.all([getProfile(db, user.id), getBorrowerLoans(db, user.id, 20)]);

  // Stellar TX lookups
  const loanIds = loans.map((l) => l.id);
  const fundLedger = await getLedgerByRef(db, "loan_fund", loanIds);
  const loanTxMap: Record<string, string> = {};
  for (const entry of fundLedger) {
    if (!entry.ref_id) continue;
    const extracted = extractPossibleTxHash(entry.metadata);
    if (extracted) {
      loanTxMap[entry.ref_id] = extracted;
    }
  }

  const normalizedLoans = loans.map((loan) => {
    const status = String(loan.status ?? "requested");
    // Only a fully funded request counts as "funded" — a partially filled loan
    // is still collecting contributions and has not activated (Issue #269).
    const progress = getFundingProgress(loan.principal_amount, loan.funded_amount);
    const effectiveStatus =
      status === "requested" && progress.isFullyFunded ? "funded" : status;

    // Extract rate model from metadata, default to fixed for backward compatibility
    let rateModel = "fixed";
    if (loan.metadata && typeof loan.metadata === "object" && "rate_model" in loan.metadata) {
      rateModel = String(loan.metadata.rate_model);
    }
    
    return { ...loan, effectiveStatus, rateModel };
  });

  const kycStatus = String(profile?.kyc_status ?? "pending");
  const isKycVerified = kycStatus === "verified";
  const hasGovIdSubmission = Boolean(profile?.government_id_url || profile?.kyc_submitted_at || kycStatus === "submitted" || isKycVerified);

  const verificationItems = [
    { label: "Wallet Verified",      done: Boolean(user.walletAddress) },
    { label: "Legal Name Set",      done: Boolean(profile?.full_name) },
    { label: "Phone Number",        done: Boolean(profile?.phone) },
    { label: "Date of Birth",       done: Boolean(profile?.date_of_birth) },
    { label: "Government ID (KYC)", done: hasGovIdSubmission },
  ];
  const verificationProgress = Math.round((verificationItems.filter((i) => i.done).length / verificationItems.length) * 100);
  const profileComplete = verificationProgress === 100;
  const canApplyLoan = profileComplete && isKycVerified;
  const profileNeedsAttention = !canApplyLoan;

  const REPAYABLE_STATUSES = ["active", "funded", "approved"];
  const activeLoans  = normalizedLoans.filter((l) => REPAYABLE_STATUSES.includes(String(l.effectiveStatus)));
  const pendingLoans = normalizedLoans.filter((l) => String(l.effectiveStatus) === "requested");
  const inLoansXlm   = activeLoans.reduce((sum, l) => sum + Math.max(0, Number(l.principal_amount ?? 0) - Number(l.repaid_amount ?? 0)), 0) / 10000000;
  const pendingXlm   = pendingLoans.reduce((sum, l) => sum + Number(l.principal_amount ?? 0), 0) / 10000000;

  const repayableLoan = activeLoans[0] ?? null;
  const dueAmount = repayableLoan
    ? Math.max(0, Number(repayableLoan.principal_amount ?? 0) - Number(repayableLoan.repaid_amount ?? 0))
    : 0;

  // ── Health Factor computation ──────────────────────────────────────────
  // Debt is valued at the live oracle price (issue #323), not a hardcoded
  // constant: a health factor that ignores the market cannot warn a borrower
  // that their position is approaching liquidation. The feed degrades through
  // cache → on-chain TWAP → configured fallback, and `xlmPrice.origin` records
  // which of those the figures below came from.
  const xlmPrice = await fetchDashboardPrice("XLM");
  const {
    totalDebtUsd,
    totalCollateralUsd,
    showHealthFactor,
    collateralIsAssumed,
  } = computeHealthFactorValuation({
    outstandingStroops: activeLoans.map(
      (l) => Number(l.principal_amount ?? 0) - Number(l.repaid_amount ?? 0),
    ),
    price: xlmPrice,
  });

  const statusBadge = (s: string): "yellow" | "blue" | "green" | "gold" => {
    if (s === "requested")                    return "yellow";
    if (s === "approved")                     return "blue";
    if (s === "active" || s === "funded")     return "green";
    return "gold";
  };

  return (
    <WorkspaceFrame
      roleLabel="Borrower Dashboard"
      heading="My Dashboard"
      description="Your active loans, verification status, and quick actions — all in one place."
      email={user.email ?? null}
      userName={String(user.fullName ?? profile?.full_name ?? "")}
      metrics={presentBorrowerMetrics(metrics)}
      headerWidget={
        <WalletCard
          address={walletAddress}
          available={0}
          inLoansOrPools={inLoansXlm}
          pending={pendingXlm}
          inLoansLabel="In Loans"
          compact
        />
      }
      currentPath="/dashboard/borrower"
      profilePath="/dashboard/borrower/profile"
      profileSummary={profileNeedsAttention ? {
        completion: verificationProgress,
        kycStatus,
        warningText: kycStatus === "submitted" && !isKycVerified
          ? "Your documents are under admin review."
          : profileComplete
            ? "Your profile is ready, but KYC approval is still required to unlock borrowing."
            : "Complete your profile to unlock borrowing.",
        requiredItems: profileComplete && !isKycVerified
          ? ["KYC approval"]
          : verificationItems.filter((i) => !i.done).map((i) => i.label),
      } : undefined}
      showProfileAlert={profileNeedsAttention}
      links={borrowerNavLinks}
    >
      <div className="workspace-stack">

        {/* ── Wallet Alert Banner ── */}
        {!walletAddress && (
          <div className="borrower-wallet-alert">
            <span className="borrower-wallet-alert__icon">⚠️</span>
            <div className="borrower-wallet-alert__body">
              <p className="borrower-wallet-alert__title">Connect Your Stellar Wallet</p>
              <p className="borrower-wallet-alert__copy">
                A wallet is required to receive or repay loans on-chain. Visit{" "}
                <a href="/dashboard/borrower/profile" style={{ fontWeight: 800, textDecoration: "underline" }}>
                  Profile &amp; Settings
                </a>{" "}
                to set it up.
              </p>
            </div>
          </div>
        )}

        {/* ── Verification Status Strip ── */}
        <div className="borrower-verify-card">
          <div className="borrower-verify-header">
            <h2 className="borrower-verify-title">Verification Status</h2>
            <span
              className={`borrower-verify-pct ${
                verificationProgress === 100
                  ? "borrower-verify-pct--done"
                  : "borrower-verify-pct--pending"
              }`}
            >
              {verificationProgress}% Complete
            </span>
          </div>

          <div className="borrower-verify-track" role="progressbar"
               aria-valuenow={verificationProgress} aria-valuemin={0} aria-valuemax={100}
               aria-label={`Profile ${verificationProgress}% complete`}>
            <div
              className="borrower-verify-fill"
              style={{ width: `${verificationProgress}%` }}
            />
          </div>

          <div className="borrower-verify-chips">
            {verificationItems.map((item) => (
              <span
                key={item.label}
                className={`borrower-verify-chip ${
                  item.done ? "borrower-verify-chip--done" : "borrower-verify-chip--pending"
                }`}
              >
                {item.done ? "✓" : "○"} {item.label}
              </span>
            ))}
          </div>

          {!profileComplete && (
            <a href="/dashboard/borrower/profile" className="borrower-verify-cta">
              Complete Profile →
            </a>
          )}
        </div>

        {/* ── Health Factor Gauge ── */}
        {showHealthFactor && (
          <>
            <HealthFactorGauge
              collateralValueUsd={totalCollateralUsd}
              debtValueUsd={totalDebtUsd}
              collateralAssetSymbol="USD"
              debtAssetSymbol="XLM"
            />

            {/* Price provenance — a health factor is only as trustworthy as the
                price behind it, so say where that price came from (#323). */}
            <p
              className={`borrower-price-source${
                xlmPrice.isStale ? " borrower-price-source--stale" : ""
              }`}
            >
              <span aria-hidden="true">{xlmPrice.isStale ? "⚠️" : "🟢"}</span>
              <span>
                Valued at <strong>${xlmPrice.priceUsd.toFixed(4)}</strong> per XLM —{" "}
                {xlmPrice.label}.
                {collateralIsAssumed && (
                  <>
                    {" "}
                    Collateral is estimated at {ASSUMED_COLLATERAL_RATIO * 100}% of outstanding
                    debt pending on-chain collateral records.
                  </>
                )}
              </span>
            </p>
          </>
        )}

        {/* ── Loan Cards ── */}
        {normalizedLoans.length > 0 && (
          <div className="borrower-loan-section">
            <div className="borrower-loan-section__header">
              <h2 className="borrower-loan-section__title">Your Loans</h2>
              <a href="/dashboard/borrower/history" className="borrower-loan-section__link">
                View full history →
              </a>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--surface-2)" }}>
                    {([
                      { label: "Loan ID" },
                      { label: "Amount" },
                      { label: "Status" },
                      { label: "APR", term: "APR" },
                      { label: "Due" },
                      { label: "Stellar TX" },
                      { label: "Receipt" },
                      { label: "Action" },
                    ] as Array<{ label: string; term?: GlossaryTermKey }>).map(({ label, term }) => (
                      <th key={label} style={{ textAlign: "left", padding: "0.6rem 0.75rem", fontSize: "0.72rem", fontWeight: 700, color: "var(--fg-subtle)", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>
                        {term ? (
                          <span className="term-tooltip">
                            {label}
                            <TermTooltip term={term} side="top" />
                          </span>
                        ) : (
                          label
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {normalizedLoans.slice(0, 5).map((loan) => {
                    const status = String(loan.effectiveStatus);
                    const loanId = String(loan.id);
                    const txHash = loanTxMap[loanId] ?? "";
                    const hasTx  = isLikelyTxHash(txHash);
                    const isRepayable = ["active", "funded", "approved"].includes(status);
                    return (
                      <tr key={loanId} style={{ borderBottom: "1px solid var(--surface-2)" }}>
                        <td style={{ padding: "0.75rem", fontFamily: "monospace", fontSize: "0.8rem", color: "var(--fg-muted)" }}>{loanId.slice(0, 8)}</td>
                        <td style={{ padding: "0.75rem", fontWeight: 700 }}>{formatCurrency(Number(loan.principal_amount))}</td>
                          <td style={{ padding: "0.75rem" }}>
                            <Badge variant={statusBadge(status)}>{status.toUpperCase()}</Badge>
                          </td>
                        <td style={{ padding: "0.75rem" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                            <span>{(Number(loan.apr_bps ?? 0) / 100).toFixed(2)}%</span>
                            <Badge 
                              variant={loan.rateModel === "floating" ? "blue" : "yellow"}
                            >
                              {loan.rateModel === "floating" ? "FLOATING" : "FIXED"}
                            </Badge>
                          </div>
                        </td>
                        <td style={{ padding: "0.75rem", whiteSpace: "nowrap" }}>
                          {loan.due_at ? new Date(String(loan.due_at)).toLocaleDateString() : "—"}
                        </td>
                        <td style={{ padding: "0.75rem" }}>
                          {hasTx ? (
                            <a href={buildStellarTxVerificationUrl(txHash)} target="_blank" rel="noreferrer"
                              style={{ fontSize: "0.78rem", color: "var(--accent)", fontWeight: 600, whiteSpace: "nowrap" }}>
                              ✅ Verify ↗
                            </a>
                          ) : (
                            <span style={{ fontSize: "0.75rem", opacity: 0.4, whiteSpace: "nowrap" }}>
                              {status === "requested" || status === "approved" ? "⏳ Pending" : status === "funded" ? "✅ Recorded" : "—"}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "0.75rem", whiteSpace: "nowrap" }}>
                          {status === "repaid" ? (
                            <a
                              href={`/api/loans/${loanId}/receipt`}
                              target="_blank"
                              rel="noreferrer"
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.35rem",
                                padding: "0.45rem 0.8rem",
                                borderRadius: "0.45rem",
                                background: "color-mix(in srgb, var(--primary) 8%, transparent)",
                                color: "var(--primary)",
                                fontSize: "0.78rem",
                                fontWeight: 700,
                                textDecoration: "none",
                              }}
                            >
                              Download PDF
                            </a>
                          ) : (
                            <span style={{ fontSize: "0.75rem", opacity: 0.4 }}>-</span>
                          )}
                        </td>
                        <td style={{ padding: "0.75rem", whiteSpace: "nowrap" }}>
                          {isRepayable ? (
                            <a
                              href={`/dashboard/borrower/repay?loanId=${loanId}`}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.25rem",
                                padding: "0.35rem 0.75rem",
                                borderRadius: "0.45rem",
                                background: "linear-gradient(135deg,var(--primary),var(--primary-hover))",
                                color: "var(--primary-fg)",
                                fontSize: "0.78rem",
                                fontWeight: 700,
                                textDecoration: "none",
                                boxShadow: "0 2px 6px color-mix(in srgb, var(--primary) 25%, transparent)",
                              }}
                            >
                              ⚡ Repay Early
                            </a>
                          ) : status === "repaid" ? (
                            <span style={{ fontSize: "0.75rem", color: "var(--accent)", fontWeight: 700 }}>Settled ✅</span>
                          ) : (
                            <span style={{ fontSize: "0.75rem", color: "var(--fg-subtle)" }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Quick Repayment Widget (if active loan) ── */}
        {repayableLoan && (
          <BorrowerRepayWidget
            loan={{
              id: String(repayableLoan.id),
              principal_amount: Number(repayableLoan.principal_amount),
              repaid_amount: Number(repayableLoan.repaid_amount ?? 0),
              due_at: repayableLoan.due_at ? String(repayableLoan.due_at) : null,
              created_at: repayableLoan.created_at ? String(repayableLoan.created_at) : null,
              apr_bps: Number(repayableLoan.apr_bps ?? 1200),
              duration_days: Number(repayableLoan.duration_days ?? 30),
            }}
            dueAmount={dueAmount}
          />
        )}

        {/* ── Cash out to fiat via Stellar Anchor (SEP-24) ── */}
        <WithdrawToFiatButton walletAddress={walletAddress} />

        {/* ── Polished Empty State (no loans) ── */}
        {normalizedLoans.length === 0 && (
          <div className="borrower-empty-state">
            <div className="borrower-empty-state__glow" aria-hidden="true" />
            <div className="borrower-empty-state__icon">
              <EmptyLoansIllustration />
            </div>
            <h2 className="borrower-empty-state__title">
              {canApplyLoan
                ? "Ready to Borrow?"
                : profileComplete
                ? "KYC Under Review"
                : "Complete Your Profile"}
            </h2>
            <p className="borrower-empty-state__copy">
              {canApplyLoan
                ? "You're fully verified and ready to go. Submit your first loan request and get funded on Stellar."
                : profileComplete
                ? "Your profile is complete and your KYC documents are being reviewed by our team. You'll be notified once approved."
                : "Finish setting up your profile and complete KYC verification to unlock borrowing on TrustLend."}
            </p>
            <a
              href={canApplyLoan ? "/dashboard/borrower/loans" : "/dashboard/borrower/profile"}
              className={`borrower-empty-state__cta${profileComplete && !canApplyLoan ? " borrower-empty-state__cta--kyc" : ""}`}
            >
              {canApplyLoan
                ? "Apply for a Loan →"
                : profileComplete
                ? "Check KYC Status"
                : "Complete Profile →"}
            </a>
          </div>
        )}

      </div>
    </WorkspaceFrame>
  );
}
