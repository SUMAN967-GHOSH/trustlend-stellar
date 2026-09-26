import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { LenderForms } from "@/components/dashboard/LenderForms";
import { InteractiveLineChart } from "@/components/dashboard/InteractiveLineChart";
import { LenderEarningsEstimator } from "@/components/dashboard/LenderEarningsEstimator";
import { selectEstimatorAprBps } from "@/lib/dashboard/lender-earnings";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import {
  getLenderDashboardMetrics,
  presentLenderMetrics,
} from "@/lib/dashboard/metrics";
import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { metaString } from "@/lib/db/metadata";
import { getProfile } from "@/lib/db/queries";
import { ledgerToRow, poolToRow, positionToRow } from "@/lib/db/rows";
import { ledgerTransactions, lendingPools, poolPositions } from "@/lib/db/schema";
import { lenderNavLinks } from "@/lib/dashboard/lender-links";
import { formatTokenBalance, formatCurrency, formatXlmPrecise } from "@/lib/utils/formatting";
import {
  isLikelyTxHash,
  buildStellarTxVerificationUrl,
} from "@/lib/stellar/explorer";
import { STELLAR_TESTNET } from "@/lib/stellar/testnet";

export default async function LenderPoolsPage() {
  const { user } = await requireAuthenticatedUser("lender");
  const metrics = await getLenderDashboardMetrics(user.id);
  const db = getDb();

  const walletAddress =
    String(user.walletAddress ?? "") || null;

  const [poolRows, positionRows, profile, txHistoryRows] = db
    ? await Promise.all([
        db.select().from(lendingPools).orderBy(desc(lendingPools.createdAt)).limit(8),
        db
          .select()
          .from(poolPositions)
          .where(eq(poolPositions.lenderId, user.id))
          .orderBy(asc(poolPositions.openedAt)),
        getProfile(db, user.id),
        db
          .select()
          .from(ledgerTransactions)
          .where(and(eq(ledgerTransactions.userId, user.id), eq(ledgerTransactions.refType, "pool_position")))
          .orderBy(desc(ledgerTransactions.createdAt))
          .limit(10),
      ])
    : [[], [], null, []];

  const pools = poolRows.map(poolToRow);
  const positions = positionRows.map(positionToRow);
  const txHistory = txHistoryRows.map(ledgerToRow);
  const isKycVerified = profile?.kyc_status === "verified";

  const totalDeployed = positions.reduce(
    (s, p) => s + Number(p.principal_amount ?? 0),
    0,
  );
  const totalEarned = positions.reduce(
    (s, p) => s + Number(p.earned_interest ?? 0),
    0,
  );

  // Seed the earnings estimator with the best active pool rate — the one a new
  // deposit would realistically target (issue #322).
  const estimatorAprBps = selectEstimatorAprBps(pools);
  const estimatorPoolName =
    pools.find(
      (p) =>
        String(p.status ?? "") === "active" &&
        Number(p.apr_bps ?? 0) === estimatorAprBps,
    )?.name ?? null;

  // Fetch live XLM balance from Stellar Horizon (server-side, best-effort)
  let availableWalletBalance = 0;
  if (walletAddress) {
    try {
      const horizonUrl =
        process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ??
        STELLAR_TESTNET.horizonUrl;
      const accountRes = await fetch(
        `${horizonUrl}/accounts/${walletAddress}`,
        {
          next: { revalidate: 30 },
        },
      );
      if (accountRes.ok) {
        const accountData = await accountRes.json();
        const nativeBalance = (accountData.balances ?? []).find(
          (b: { asset_type: string; balance: string }) =>
            b.asset_type === "native",
        );
        availableWalletBalance = nativeBalance
          ? parseFloat(nativeBalance.balance)
          : 0;
      }
    } catch {
      // Horizon unreachable — WalletCard will fetch live on the client side
    }
  }

  // Generate cumulative portfolio growth data for the chart
  let cumulativeValue = 0;
  const chartData =
    positions.length > 0
      ? positions.map((p) => {
          cumulativeValue +=
            Number(p.principal_amount) + Number(p.earned_interest);
          return {
            label: `Account Value on ${
              p.opened_at
                ? new Date(String(p.opened_at)).toLocaleDateString()
                : "Active"
            }`,
            value: cumulativeValue,
          };
        })
      : [
          { label: "Jan Growth Projection", value: 100 },
          { label: "Feb Growth Projection", value: 250 },
          { label: "Mar Growth Projection", value: 400 },
          { label: "Apr Growth Projection", value: 850 },
        ];

  if (chartData.length === 1) {
    chartData.unshift({ label: "Initial Deposit", value: 0 });
  }

  return (
    <WorkspaceFrame
      roleLabel="Lender Dashboard"
      heading="Pool Investment"
      description="Deposit XLM into a lending pool and earn passive APR. The pool auto-matches your capital to open borrower requests."
      email={user.email ?? null}
      userName={String(
        user.fullName ?? profile?.full_name ?? "",
      )}
      metrics={presentLenderMetrics(metrics)}
      currentPath="/dashboard/lender/pools"
      profilePath="/dashboard/lender/profile"
      showProfileAlert={false}
      links={lenderNavLinks}
    >
      <div className="workspace-stack">
        {/* ── Available to Invest banner ────────────────────────── */}
        <section aria-label="Available to Invest">
          <article
            style={{
              background: "linear-gradient(135deg, color-mix(in srgb, var(--accent) 12%, transparent) 0%, color-mix(in srgb, var(--accent) 4%, transparent) 100%)",
              border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
              borderRadius: "1rem",
              padding: "1.5rem 2rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "1rem",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
              <div
                style={{
                  width: "3rem",
                  height: "3rem",
                  borderRadius: "50%",
                  background: "color-mix(in srgb, var(--accent) 15%, transparent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "1.4rem",
                  flexShrink: 0,
                }}
              >
                💰
              </div>
              <div>
                <p
                  style={{
                    fontSize: "0.75rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                    opacity: 0.55,
                    marginBottom: "0.25rem",
                  }}
                >
                  Available to Invest
                </p>
                <p
                  style={{
                    fontSize: "2rem",
                    fontWeight: 800,
                    color: "var(--accent)",
                    lineHeight: 1,
                    margin: 0,
                  }}
                >
                  {availableWalletBalance > 0
                    ? formatCurrency(availableWalletBalance)
                    : walletAddress
                      ? "Connect a wallet to load balance"
                      : "Wallet not connected"}
                </p>
                {walletAddress && (
                  <p
                    style={{
                      fontSize: "0.75rem",
                      opacity: 0.45,
                      marginTop: "0.3rem",
                      fontFamily: "monospace",
                    }}
                  >
                    {walletAddress.slice(0, 8)}…{walletAddress.slice(-6)}
                  </p>
                )}
              </div>
            </div>

            {/* Quick stats */}
            <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
              {[
                {
                  label: "Deployed in Pools",
                  value: formatCurrency(totalDeployed),
                },
                {
                  label: "Interest Earned",
                  value: formatXlmPrecise(totalEarned),
                  green: true,
                },
                {
                  label: "Active Positions",
                  value: String(
                    positions.filter((p) => p.status === "active").length,
                  ),
                },
              ].map((stat) => (
                <div key={stat.label} style={{ textAlign: "center" }}>
                  <p
                    style={{
                      fontSize: "0.7rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      opacity: 0.5,
                      marginBottom: "0.2rem",
                    }}
                  >
                    {stat.label}
                  </p>
                  <p
                    style={{
                      fontWeight: 700,
                      fontSize: "1.1rem",
                      color: stat.green ? "var(--accent)" : "inherit",
                      margin: 0,
                    }}
                  >
                    {stat.value}
                  </p>
                </div>
              ))}
            </div>
          </article>
        </section>

        {/* ── Earnings estimator (issue #322) ───────────────────── */}
        <LenderEarningsEstimator
          poolAprBps={estimatorAprBps}
          poolName={estimatorPoolName}
          initialDepositXlm={availableWalletBalance}
        />

        {/* ── My positions summary ──────────────────────────────── */}
        <section className="workspace-grid workspace-grid--two">
          <div
            style={{ display: "flex", flexDirection: "column", gap: "1rem" }}
          >
            {[
              {
                label: "Your Total Deployed",
                value: formatCurrency(totalDeployed),
              },
              {
                label: "Total Interest Earned",
                value: formatXlmPrecise(totalEarned),
                green: true,
              },
              {
                label: "Active Positions",
                value: String(
                  positions.filter((p) => p.status === "active").length,
                ),
              },
            ].map((stat) => (
              <article
                key={stat.label}
                className="workspace-card"
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                }}
              >
                <p
                  style={{
                    fontSize: "0.78rem",
                    opacity: 0.55,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    marginBottom: "0.35rem",
                  }}
                >
                  {stat.label}
                </p>
                <p
                  style={{
                    fontSize: "1.6rem",
                    fontWeight: 700,
                    color: stat.green ? "var(--accent)" : "inherit",
                  }}
                >
                  {stat.value}
                </p>
              </article>
            ))}
          </div>

          <article
            className="workspace-card"
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              padding: "2rem",
            }}
          >
            <h3
              style={{
                fontSize: "0.85rem",
                opacity: 0.6,
                marginBottom: "1rem",
                marginTop: 0,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Cumulative Pool Portfolio Growth
            </h3>
            <InteractiveLineChart points={chartData} color="var(--accent)" />
          </article>
        </section>

        <article className="workspace-card workspace-card--full">
          <h2 className="workspace-card-title">Available Lending Pools</h2>
          {pools.length === 0 ? (
            <p className="workspace-card-copy" style={{ opacity: 0.6 }}>
              No lending pools have been created yet. Check back soon.
            </p>
          ) : (
            <div className="workspace-table-wrap">
              <table className="workspace-table" aria-label="Lending pools">
                <thead>
                  <tr>
                    <th>Pool Name</th>
                    <th>Status</th>
                    <th>APR</th>
                    <th>Total Size</th>
                    <th>Available</th>
                    <th>My Stake</th>
                  </tr>
                </thead>
                <tbody>
                  {pools.map((pool) => {
                    const myPos = positions.find(
                      (p) => String(p.pool_id) === String(pool.id),
                    );
                    return (
                      <tr key={String(pool.id)}>
                        <td>
                          <strong>{String(pool.name)}</strong>
                        </td>
                        <td>
                          <span
                            style={{
                              padding: "0.15rem 0.5rem",
                              borderRadius: "9999px",
                              fontSize: "0.75rem",
                              fontWeight: 600,
                              background:
                                pool.status === "active"
                                  ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                                  : "color-mix(in srgb, var(--danger) 12%, transparent)",
                              color:
                                pool.status === "active"
                                  ? "var(--accent)"
                                  : "var(--danger)",
                            }}
                          >
                            {String(pool.status).toUpperCase()}
                          </span>
                        </td>
                        <td>{(Number(pool.apr_bps ?? 0) / 100).toFixed(2)}%</td>
                        <td>
                          {formatTokenBalance(Number(pool.total_liquidity ?? 0))}
                        </td>
                        <td>
                          {formatTokenBalance(Number(pool.available_liquidity ?? 0))}
                        </td>
                        <td
                          style={{
                            color: myPos ? "var(--accent)" : "inherit",
                            fontWeight: myPos ? 600 : 400,
                          }}
                        >
                          {myPos
                            ? `${formatTokenBalance(Number(myPos.principal_amount ?? 0))} ✅`
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </article>

        {/* ── Deposit / Withdraw forms ──────────────────────────── */}
        <section className="workspace-grid workspace-grid--two">
          <LenderForms
            pools={pools.map((p) => ({ ...p, available_liquidity: Number(p.available_liquidity) }))}
            positions={positions.map((p) => ({ ...p, principal_amount: Number(p.principal_amount) }))}
            walletBalance={availableWalletBalance}
            isKycVerified={isKycVerified}
          />

          {/* My positions detail */}
          <article className="workspace-card">
            <h2 className="workspace-card-title">Your Positions</h2>
            {positions.length === 0 ? (
              <p className="workspace-card-copy" style={{ opacity: 0.6 }}>
                No positions yet. Make your first deposit using the form.
              </p>
            ) : (
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.65rem",
                }}
              >
                {positions.map((pos) => {
                  const pool = pools.find(
                    (p) => String(p.id) === String(pos.pool_id),
                  );
                  return (
                    <li
                      key={String(pos.id)}
                      style={{
                        padding: "0.75rem",
                        borderRadius: "0.6rem",
                        background: "color-mix(in srgb, var(--fg) 4%, transparent)",
                        border: "1px solid color-mix(in srgb, var(--fg) 7%, transparent)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          marginBottom: "0.25rem",
                        }}
                      >
                        <span style={{ fontWeight: 600, fontSize: "0.88rem" }}>
                          {pool
                            ? String(pool.name)
                            : `Pool ${String(pos.pool_id).slice(0, 6)}`}
                        </span>
                        <span
                          style={{
                            fontSize: "0.75rem",
                            fontWeight: 600,
                            padding: "0.1rem 0.45rem",
                            borderRadius: "9999px",
                            background:
                              pos.status === "active"
                                ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                                : "color-mix(in srgb, var(--danger) 12%, transparent)",
                            color:
                              pos.status === "active" ? "var(--accent)" : "var(--danger)",
                          }}
                        >
                          {String(pos.status ?? "active").toUpperCase()}
                        </span>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          gap: "1.5rem",
                          fontSize: "0.83rem",
                          opacity: 0.75,
                        }}
                      >
                        <span>
                          Deployed:{" "}
                          <strong>
                            {formatCurrency(Number(pos.principal_amount ?? 0))}
                          </strong>
                        </span>
                        <span>
                          Earned:{" "}
                          <strong style={{ color: "var(--accent)" }}>
                            {formatXlmPrecise(Number(pos.earned_interest ?? 0))}
                          </strong>
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </article>
        </section>

        {/* ── Transaction History ───────────────────────────────── */}
        {txHistory.length > 0 && (
          <section
            className="workspace-card workspace-card--full"
            style={{ marginTop: "1rem" }}
          >
            <h2 className="workspace-card-title">Recent Activity</h2>
            <div className="workspace-table-wrap">
              <table className="workspace-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Verification</th>
                  </tr>
                </thead>
                <tbody>
                  {txHistory.map((tx) => {
                    const txHash = metaString(tx.metadata, "txHash");

                    const isDeposit = tx.category === "deposit";

                    return (
                      <tr key={String(tx.id)}>
                        <td style={{ opacity: 0.8, fontSize: "0.85rem" }}>
                          {tx.created_at
                            ? new Date(
                                String(tx.created_at),
                              ).toLocaleDateString()
                            : "—"}
                        </td>
                        <td>
                          <span
                            style={{
                              padding: "0.15rem 0.5rem",
                              borderRadius: "9999px",
                              fontSize: "0.75rem",
                              fontWeight: 600,
                              background: isDeposit
                                ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                                : "color-mix(in srgb, var(--primary) 12%, transparent)",
                              color: isDeposit ? "var(--accent)" : "var(--primary-muted)",
                            }}
                          >
                            {String(tx.category ?? "Unknown").toUpperCase()}
                          </span>
                        </td>
                        <td style={{ fontWeight: 600 }}>
                          {formatCurrency(Number(tx.amount || 0))}
                        </td>
                        <td
                          style={{
                            opacity: 0.7,
                            fontSize: "0.85rem",
                            textTransform: "capitalize",
                          }}
                        >
                          {tx.status}
                        </td>
                        <td>
                          {isLikelyTxHash(txHash) ? (
                            <a
                              href={buildStellarTxVerificationUrl(txHash)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="workspace-nav-link"
                              style={{
                                display: "inline-block",
                                background: "color-mix(in srgb, var(--accent) 10%, transparent)",
                                color: "var(--accent)",
                                padding: "0.3rem 0.6rem",
                                borderRadius: "0.4rem",
                                fontSize: "0.75rem",
                              }}
                            >
                              ✅ Verify Tx ↗
                            </a>
                          ) : (
                            <span
                              style={{
                                opacity: 0.4,
                                fontSize: "0.8rem",
                                fontStyle: "italic",
                              }}
                            >
                              —
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </WorkspaceFrame>
  );
}
