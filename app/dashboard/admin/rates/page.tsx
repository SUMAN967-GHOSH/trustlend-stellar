import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { adminNavLinks } from "@/lib/dashboard/admin-links";
import { requireTradeVaultAdmin } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { getAdminDashboardMetrics, presentAdminMetrics } from "@/lib/dashboard/metrics";
import { getActiveRateConfigs, getRateConfigHistory } from "@/lib/loans/rate-config";
import { AdminInterestRatesDashboard } from "@/components/dashboard/AdminInterestRatesDashboard";

export const metadata = {
  title: "Interest Rates — TrustLend Admin",
  description:
    "Tune the APR schedules used to price new loan applications: base rates, principal tiers, and trust score multipliers.",
};

/**
 * Admin interface for the loan-origination APR schedules (issue #321).
 *
 * Rates used to be hardcoded in app/api/loans/apply/route.ts; they now come
 * from `interest_rate_configs` and are edited here.
 */
export default async function AdminInterestRatesPage() {
  const { user } = await requireTradeVaultAdmin();
  const metrics = await getAdminDashboardMetrics();

  const db = getDb();
  const [{ configs, usedFallback }, history] = await Promise.all([
    getActiveRateConfigs(db),
    getRateConfigHistory(db, 25),
  ]);

  return (
    <WorkspaceFrame
      roleLabel="Trade Vault Admin"
      heading="Interest Rates"
      description="Adjust the APRs new loans are priced at — base rates, principal tiers, and trust score multipliers — without a deployment."
      email={user.email ?? null}
      userName={String(user.fullName ?? "Admin")}
      metrics={presentAdminMetrics(metrics)}
      links={[...adminNavLinks]}
      currentPath="/dashboard/admin/rates"
      showProfileAlert={false}
    >
      <AdminInterestRatesDashboard
        initialActive={configs}
        initialHistory={history}
        usingFallbackDefaults={usedFallback}
        adminEmail={user.email || "admin@trustlend.org"}
      />
    </WorkspaceFrame>
  );
}
