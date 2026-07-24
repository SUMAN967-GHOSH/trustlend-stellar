"use client";

import { useState, useEffect, useRef } from "react";
import type { SimulationResult } from "@/lib/stellar/simulation";
import { Progress } from "@/components/ui/progress";

interface SimulationPreviewProps {
  result: SimulationResult | null;
  loading: boolean;
  methodLabel?: string;
}

// ─── Animated counter ─────────────────────────────────────────────────────

function AnimatedValue({ value, suffix = "" }: { value: number; suffix?: string }) {
  const [display, setDisplay] = useState(0);
  const frameRef = useRef(0);

  useEffect(() => {
    if (value === 0) {
      frameRef.current = requestAnimationFrame(() => setDisplay(0));
      return;
    }
    const duration = 600;
    const start = performance.now();
    const from = 0;
    const delta = value - from;

    const tick = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(from + delta * eased));
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(tick);
      }
    };
    frameRef.current = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frameRef.current);
  }, [value]);

  return <>{display.toLocaleString()}{suffix}</>;
}

// ─── Metric tile ──────────────────────────────────────────────────────────

function MetricTile({
  label,
  value,
  suffix = "",
  icon,
  color,
}: {
  label: string;
  value: number;
  suffix?: string;
  icon: string;
  color: string;
}) {
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.06)",
        borderRadius: "0.75rem",
        padding: "0.7rem 0.6rem",
        textAlign: "center",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <span style={{ fontSize: "1.1rem", display: "block", marginBottom: "0.2rem" }}>{icon}</span>
      <p style={{ margin: 0, fontSize: "1rem", fontWeight: 800, color }}>
        <AnimatedValue value={value} suffix={suffix} />
      </p>
      <p style={{ margin: "0.15rem 0 0", fontSize: "0.65rem", opacity: 0.6, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </p>
    </div>
  );
}

// ─── Skeleton / Loading state ─────────────────────────────────────────────

function SimulationSkeleton() {
  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      <div
        style={{
          height: "14px",
          width: "60%",
          borderRadius: "999px",
          background: "rgba(255,255,255,0.08)",
          animation: "simShimmer 1.4s infinite",
        }}
      />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.5rem" }}>
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              height: "72px",
              borderRadius: "0.75rem",
              background: "rgba(255,255,255,0.05)",
              animation: "simShimmer 1.4s infinite",
              animationDelay: `${i * 0.15}s`,
            }}
          />
        ))}
      </div>
      <div
        style={{
          height: "14px",
          width: "40%",
          borderRadius: "999px",
          background: "rgba(255,255,255,0.08)",
          animation: "simShimmer 1.4s infinite",
          animationDelay: "0.3s",
        }}
      />
    </div>
  );
}

// ─── Error state ──────────────────────────────────────────────────────────

function SimulationError({ error, methodLabel }: { error: string; methodLabel?: string }) {
  return (
    <div
      style={{
        background: "rgba(255,77,77,0.08)",
        border: "1px solid rgba(255,77,77,0.25)",
        borderRadius: "0.85rem",
        padding: "1rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
        <span style={{ fontSize: "1.1rem" }}>⚠️</span>
        <p style={{ margin: 0, fontWeight: 700, color: "#ff6b6b", fontSize: "0.85rem" }}>
          Simulation {methodLabel ? `"${methodLabel}"` : ""}Failed
        </p>
      </div>
      <p style={{ margin: 0, fontSize: "0.78rem", opacity: 0.75, lineHeight: 1.5, fontFamily: "monospace" }}>
        {error}
      </p>
      <p style={{ margin: "0.5rem 0 0", fontSize: "0.72rem", opacity: 0.5 }}>
        The transaction may revert. Proceed with caution or cancel.
      </p>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────

export function SimulationPreview({ result, loading, methodLabel }: SimulationPreviewProps) {
  if (loading) {
    return <SimulationSkeleton />;
  }

  if (!result) {
    return null;
  }

  if (!result.success) {
    return <SimulationError error={result.error ?? "Unknown simulation error"} methodLabel={methodLabel} />;
  }

  const instPct = Math.min(100, Math.round((result.resources.instructions / 10_000_000) * 100));
  const memPct = Math.min(100, Math.round(((result.resources.readBytes + result.resources.writeBytes) / 200_000) * 100));

  return (
    <div style={{ display: "grid", gap: "0.85rem" }}>
      {/* Metrics grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.5rem" }}>
        <MetricTile
          icon="⚡"
          label="CPU Instructions"
          value={result.resources.instructions}
          color="#a78bfa"
        />
        <MetricTile
          icon="💾"
          label="Read Bytes"
          value={result.resources.readBytes}
          suffix=" B"
          color="#34d399"
        />
        <MetricTile
          icon="✍️"
          label="Write Bytes"
          value={result.resources.writeBytes}
          suffix=" B"
          color="#fbbf24"
        />
      </div>

      {/* Fee display */}
      <div
        style={{
          background: "rgba(255,255,255,0.04)",
          borderRadius: "0.7rem",
          padding: "0.65rem 0.85rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <span style={{ fontSize: "0.78rem", opacity: 0.7, fontWeight: 600 }}>Estimated Network Fee</span>
        <span style={{ fontSize: "0.95rem", fontWeight: 800, color: "#a78bfa" }}>
          ≈ {result.feeXlm} XLM
        </span>
      </div>

      {/* Resource bars */}
      <div style={{ display: "grid", gap: "0.5rem" }}>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.7rem", marginBottom: "0.2rem" }}>
            <span style={{ opacity: 0.6 }}>CPU</span>
            <span style={{ opacity: 0.6 }}>{result.resources.instructions.toLocaleString()} / 10M</span>
          </div>
          <Progress value={instPct} className="h-1.5" />
        </div>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.7rem", marginBottom: "0.2rem" }}>
            <span style={{ opacity: 0.6 }}>Memory</span>
            <span style={{ opacity: 0.6 }}>{(result.resources.readBytes + result.resources.writeBytes).toLocaleString()} B / 200KB</span>
          </div>
          <Progress value={memPct} className="h-1.5" />
        </div>
      </div>

      {/* Footprint entries */}
      <p style={{ margin: 0, fontSize: "0.7rem", opacity: 0.45, textAlign: "center" }}>
        {result.resources.ledgerFootprintEntries} ledger entr{result.resources.ledgerFootprintEntries === 1 ? "y" : "ies"} in footprint
      </p>

      <style
        dangerouslySetInnerHTML={{
          __html: `
            @keyframes simShimmer {
              0% { opacity: 0.05; }
              50% { opacity: 0.12; }
              100% { opacity: 0.05; }
            }
          `,
        }}
      />
    </div>
  );
}
