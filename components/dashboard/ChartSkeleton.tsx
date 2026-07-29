"use client";

import { motion } from "framer-motion";
import { Skeleton, ShimmerBar } from "@/components/ui/Skeleton";

// ─────────────────────────────────────────────────────────────────────────────
// Chart Skeleton Variants
// ─────────────────────────────────────────────────────────────────────────────
// Provides realistic placeholder shapes for different chart types used in the
// lending dashboard. Each variant mimics the approximate layout of the real
// chart so the transition to loaded content feels seamless.
//
// Variants:
//   - LineChartSkeleton   → matches InteractiveLineChart (SVG area + line)
//   - BarChartSkeleton    → matches FinanceChart (bar groups)
//   - StatCardSkeleton    → matches summary stat cards
//   - MetricCardSkeleton  → matches TreasuryDashboard metric cards
//   - TableSkeleton       → matches TreasuryDashboard history table
//   - DashboardGridSkeleton → full treasury dashboard skeleton
// ─────────────────────────────────────────────────────────────────────────────

// ─── Line Chart Skeleton ──────────────────────────────────────────────────
// Mimics the shape of InteractiveLineChart — a wavy line with area fill.
// Uses SVG with pulsing opacity for a shimmer effect on the line itself.

interface LineChartSkeletonProps {
  /** Number of data points in the faux line. */
  pointCount?: number;
  /** Height of the skeleton container. */
  height?: number | string;
}

export function LineChartSkeleton({
  pointCount = 7,
  height = 200,
}: LineChartSkeletonProps) {
  // Generate a pseudo-random wave that looks like realistic chart data
  const W = 1000;
  const H = 200;
  const pad = 20;
  const amplitudes = [0.3, 0.6, 0.4, 0.8, 0.5, 0.9, 0.35, 0.7, 0.55];

  const pts = Array.from({ length: pointCount }, (_, i) => {
    const x = pad + (i / Math.max(1, pointCount - 1)) * (W - pad * 2);
    const amp = amplitudes[i % amplitudes.length];
    const y = H - pad - amp * (H - pad * 2);
    return { x, y };
  });

  let d = `M ${pts[0]?.x},${pts[0]?.y}`;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const p = pts[i];
    const cp1x = prev.x + (p.x - prev.x) / 2;
    d += ` C ${cp1x},${prev.y} ${cp1x},${p.y} ${p.x},${p.y}`;
  }

  const areaD = d + ` L ${pts[pts.length - 1]?.x},${H} L ${pts[0]?.x},${H} Z`;

  return (
    <div
      aria-busy="true"
      aria-label="Loading chart…"
      style={{
        width: "100%",
        height: typeof height === "number" ? `${height}px` : height,
        position: "relative",
      }}
    >
      {/* Chart card shell */}
      <div
        className="animate-pulse rounded-xl bg-gray-100 dark:bg-white/5"
        style={{
          width: "100%",
          height: "100%",
          position: "relative",
          overflow: "hidden",
          display: "flex",
          alignItems: "flex-end",
          padding: "0.5rem",
        }}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{
            width: "100%",
            height: "100%",
            position: "absolute",
            inset: 0,
          }}
        >
          {/* Area fill */}
          <path d={areaD} fill="rgba(34,207,157,0.08)" />
          {/* Line stroke */}
          <path
            d={d}
            fill="none"
            stroke="rgba(34,207,157,0.25)"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>

        {/* Floating shimmer dots */}
        {pts.map((p, i) => (
          <div
            key={i}
            className="animate-pulse rounded-full bg-gray-300 dark:bg-white/15"
            style={{
              position: "absolute",
              left: `${(p.x / W) * 100}%`,
              top: `${(p.y / H) * 100}%`,
              width: "6px",
              height: "6px",
              transform: "translate(-50%, -50%)",
            }}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Bar Chart Skeleton ───────────────────────────────────────────────────
// Mimics the FinanceChart layout — a grid of bar groups with two bars each.

interface BarChartSkeletonProps {
  /** Number of bar groups to show. */
  groupCount?: number;
  /** Title text skeleton width. */
  titleWidth?: string;
}

export function BarChartSkeleton({
  groupCount = 6,
  titleWidth = "60%",
}: BarChartSkeletonProps) {
  // Generate bar heights that look semi-realistic
  const heights = [0.7, 0.9, 0.4, 0.85, 0.55, 0.95, 0.3, 0.75];

  return (
    <div
      aria-busy="true"
      aria-label="Loading bar chart…"
      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5"
    >
      {/* Header: title + legend */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "1rem",
        }}
      >
        <ShimmerBar width={titleWidth} height="0.9rem" />
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <ShimmerBar width="4rem" height="0.7rem" />
          <ShimmerBar width="4rem" height="0.7rem" />
        </div>
      </div>

      {/* Bar grid */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: "0.4rem",
          height: "140px",
          padding: "0 0.25rem",
        }}
      >
        {Array.from({ length: groupCount }).map((_, i) => {
          const h1 = heights[(i * 2) % heights.length];
          const h2 = heights[(i * 2 + 1) % heights.length];
          return (
            <div
              key={i}
              style={{
                flex: 1,
                display: "flex",
                gap: "3px",
                alignItems: "flex-end",
                height: "100%",
              }}
            >
              <div
                className="animate-pulse rounded-t-md"
                style={{
                  flex: 1,
                  height: `${h1 * 100}%`,
                  background: "rgba(34, 207, 157, 0.2)",
                  minHeight: "8px",
                }}
              />
              <div
                className="animate-pulse rounded-t-md"
                style={{
                  flex: 1,
                  height: `${h2 * 100}%`,
                  background: "rgba(126, 47, 208, 0.15)",
                  minHeight: "8px",
                }}
              />
            </div>
          );
        })}
      </div>

      {/* X-axis labels */}
      <div
        style={{
          display: "flex",
          gap: "0.4rem",
          marginTop: "0.5rem",
        }}
      >
        {Array.from({ length: groupCount }).map((_, i) => (
          <ShimmerBar
            key={i}
            width="100%"
            height="0.55rem"
          />
        ))}
      </div>
    </div>
  );
}

// ─── Stat Card Skeleton ───────────────────────────────────────────────────
// Matches the summary stat cards used across dashboards.
// Re-exported from PoolCardSkeleton for convenience.

interface StatCardSkeletonProps {
  delay?: number;
}

export function StatCardSkeleton({ delay = 0 }: StatCardSkeletonProps) {
  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay, ease: "easeOut" }}
      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.55rem",
      }}
    >
      <ShimmerBar width="60%" height="0.65rem" />
      <ShimmerBar width="75%" height="1.4rem" />
      <ShimmerBar width="45%" height="0.6rem" />
    </motion.article>
  );
}

// ─── Metric Card Skeleton ─────────────────────────────────────────────────
// Matches the TreasuryDashboard metric overview cards (balance, fees, etc.).

interface MetricCardSkeletonProps {
  delay?: number;
}

export function MetricCardSkeleton({ delay = 0 }: MetricCardSkeletonProps) {
  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay, ease: "easeOut" }}
      className="rounded-xl border border-slate-700/50 bg-slate-800/60 p-5"
      style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}
    >
      {/* Header label */}
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div
          className="animate-pulse rounded-md bg-slate-700/50"
          style={{ width: "50%", height: "0.65rem" }}
        />
        <div
          className="animate-pulse rounded-md bg-slate-700/50"
          style={{ width: "1.2rem", height: "1.2rem" }}
        />
      </div>
      {/* Value */}
      <div
        className="animate-pulse rounded-md bg-slate-700/50"
        style={{ width: "70%", height: "1.6rem" }}
      />
      {/* Subtitle */}
      <div
        className="animate-pulse rounded-md bg-slate-700/40"
        style={{ width: "45%", height: "0.55rem" }}
      />
    </motion.article>
  );
}

// ─── Table Skeleton ───────────────────────────────────────────────────────
// Matches the TreasuryDashboard history log table.

interface TableSkeletonProps {
  rowCount?: number;
  columnCount?: number;
}

export function TableSkeleton({
  rowCount = 4,
  columnCount = 7,
}: TableSkeletonProps) {
  return (
    <div aria-busy="true" aria-label="Loading table…">
      {/* Table header */}
      <div
        className="animate-pulse rounded-t-xl"
        style={{
          display: "flex",
          gap: "0.75rem",
          padding: "0.75rem 1rem",
          background: "rgba(30, 41, 59, 0.8)",
          borderBottom: "1px solid rgba(30, 41, 59, 1)",
        }}
      >
        {Array.from({ length: columnCount }).map((_, i) => (
          <div
            key={i}
            className="rounded-md bg-slate-700/50"
            style={{
              flex: i === 0 ? 0.5 : i === columnCount - 1 ? 1.5 : 1,
              height: "0.6rem",
            }}
          />
        ))}
      </div>

      {/* Table rows */}
      {Array.from({ length: rowCount }).map((_, row) => (
        <div
          key={row}
          className="animate-pulse"
          style={{
            display: "flex",
            gap: "0.75rem",
            padding: "0.75rem 1rem",
            borderBottom: "1px solid rgba(30, 41, 59, 0.5)",
          }}
        >
          {Array.from({ length: columnCount }).map((_, col) => (
            <div
              key={col}
              className="rounded-md bg-slate-800/60"
              style={{
                flex: col === 0 ? 0.5 : col === columnCount - 1 ? 1.5 : 1,
                height: col === 1 || col === columnCount - 1 ? "0.65rem" : "0.85rem",
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── Full Treasury Dashboard Skeleton ─────────────────────────────────────
// Composes all skeleton parts into a single loading state matching
// the TreasuryDashboard layout.

export function TreasuryDashboardSkeleton() {
  return (
    <div
      className="space-y-8 p-6 rounded-2xl border border-slate-800 shadow-xl"
      style={{ background: "rgb(15, 23, 42)" }}
      aria-busy="true"
      aria-label="Loading treasury dashboard…"
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingBottom: "1.5rem",
          borderBottom: "1px solid rgba(30, 41, 59, 1)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <Skeleton className="rounded-xl" style={{ width: "3rem", height: "3rem" }} />
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            <Skeleton style={{ width: "18rem", height: "1.2rem" }} />
            <Skeleton style={{ width: "14rem", height: "0.7rem" }} />
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <Skeleton className="rounded-xl" style={{ width: "8rem", height: "2.5rem" }} />
          <Skeleton className="rounded-xl" style={{ width: "9rem", height: "2.5rem" }} />
        </div>
      </div>

      {/* Metric cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {[0, 0.06, 0.12, 0.18].map((delay, i) => (
          <MetricCardSkeleton key={i} delay={delay} />
        ))}
      </div>

      {/* Distribution strategy card */}
      <Skeleton className="rounded-xl" style={{ width: "100%", height: "8rem" }} />

      {/* History table */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.75rem" }}>
        <Skeleton style={{ width: "10rem", height: "0.9rem" }} />
        <Skeleton style={{ width: "8rem", height: "0.7rem" }} />
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-800">
        <TableSkeleton rowCount={4} columnCount={7} />
      </div>
    </div>
  );
}

// ─── Full Dashboard Charts Skeleton ───────────────────────────────────────
// Composes line + bar chart skeletons for pages that show multiple charts.

interface DashboardChartsSkeletonProps {
  /** Number of line charts to show. */
  lineChartCount?: number;
  /** Number of stat cards to show. */
  statCardCount?: number;
}

export function DashboardChartsSkeleton({
  lineChartCount = 1,
  statCardCount = 3,
}: DashboardChartsSkeletonProps) {
  return (
    <div aria-busy="true" aria-label="Loading dashboard…">
      {/* Stat cards row */}
      <div
        className="grid grid-cols-1 sm:grid-cols-3 gap-4"
        style={{ marginBottom: "1.5rem" }}
      >
        {Array.from({ length: statCardCount }).map((_, i) => (
          <StatCardSkeleton key={i} delay={i * 0.06} />
        ))}
      </div>

      {/* Line charts */}
      {Array.from({ length: lineChartCount }).map((_, i) => (
        <div key={i} style={{ marginBottom: "1.5rem" }}>
          <LineChartSkeleton pointCount={7} height={200} />
        </div>
      ))}
    </div>
  );
}
