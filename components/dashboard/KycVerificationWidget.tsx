"use client";

/**
 * KycVerificationWidget
 *
 * Renders the SumSub Web SDK in an iframe for in-app identity verification.
 * The SDK is loaded from the SumSub CDN (no npm package required — keeps CI clean).
 *
 * In dev mode (no SUMSUB_APP_TOKEN), shows a realistic demo UI.
 *
 * Usage:
 *   <KycVerificationWidget
 *     kycStatus="pending"
 *     kycProviderId={null}
 *     onStatusChange={(status) => console.log(status)}
 *   />
 */

import { useState, useEffect, useRef } from "react";

// Extend Window to allow SumSub SDK globals
declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    idensic?: any;
  }
}

interface KycVerificationWidgetProps {
  kycStatus: string;
  kycProviderId?: string | null;
  onStatusChange?: (status: string) => void;
}

type WidgetPhase =
  | "idle"
  | "loading"
  | "sdk_ready"
  | "sdk_active"
  | "submitted"
  | "verified"
  | "rejected"
  | "error";

const STATUS_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  pending:   { bg: "rgba(107,114,128,0.06)",  color: "#6b7280", border: "rgba(107,114,128,0.2)" },
  submitted: { bg: "rgba(126,47,208,0.08)",   color: "#7e2fd0", border: "rgba(126,47,208,0.25)" },
  verified:  { bg: "rgba(22,160,122,0.08)",   color: "#16a07a", border: "rgba(22,160,122,0.25)" },
  rejected:  { bg: "rgba(220,38,38,0.08)",    color: "#dc2626", border: "rgba(220,38,38,0.25)" },
};

const STATUS_ICONS: Record<string, string> = {
  pending:   "⏳",
  submitted: "🔍",
  verified:  "✅",
  rejected:  "❌",
};

const STATUS_LABELS: Record<string, string> = {
  pending:   "Not Started",
  submitted: "Under Review",
  verified:  "Verified",
  rejected:  "Action Required",
};

export function KycVerificationWidget({
  kycStatus,
  kycProviderId,
  onStatusChange,
}: KycVerificationWidgetProps) {
  const [phase, setPhase] = useState<WidgetPhase>(
    kycStatus === "verified" ? "verified"
    : kycStatus === "rejected" ? "rejected"
    : kycStatus === "submitted" ? "submitted"
    : "idle"
  );
  const [sdkToken, setSdkToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDevMode, setIsDevMode] = useState(false);
  const sdkContainerRef = useRef<HTMLDivElement>(null);

  // Detect dev mode on mount
  useEffect(() => {
    fetch("/api/kyc/token", { method: "GET" })
      .then((r) => r.json())
      .then((data) => {
        if (data.applicantId?.startsWith("dev-")) setIsDevMode(true);
      })
      .catch(() => {});
  }, []);

  const handleStartVerification = async () => {
    setPhase("loading");
    setError(null);

    try {
      const res = await fetch("/api/kyc/token", { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? "Failed to start verification");
      }

      const data = await res.json() as { token: string; applicantId: string };
      setSdkToken(data.token);

      if (data.token.startsWith("dev-")) {
        // Dev mode: simulate the SDK UI
        setIsDevMode(true);
        setPhase("sdk_active");
        return;
      }

      setPhase("sdk_ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setPhase("error");
    }
  };

  // Load and mount the SumSub Web SDK when token is ready
  useEffect(() => {
    if (phase !== "sdk_ready" || !sdkToken || !sdkContainerRef.current) return;

    const containerId = "sumsub-websdk-container";

    const loadSdk = () => {
      if (!window.idensic) return;

      const sdk = window.idensic.init(
        `#${containerId}`,
        {
          clientId: sdkToken,
          uiConf: {
            customCssStr: `
              .sumsub-branding { display: none !important; }
              .sumsub-container { font-family: 'Inter', sans-serif !important; }
            `,
          },
        },
        (messageType: string, payload: { reviewStatus?: string }) => {
          console.log("[SumSub SDK]", messageType, payload);
          if (messageType === "idCheck.onApplicantStatusChanged") {
            const reviewStatus = payload?.reviewStatus;
            if (reviewStatus === "completed" || reviewStatus === "onHold") {
              setPhase("submitted");
              onStatusChange?.("submitted");
            }
          }
          if (messageType === "idCheck.onReady") {
            setPhase("sdk_active");
          }
        }
      );

      return sdk;
    };

    // SDK script already loaded
    if (window.idensic) {
      loadSdk();
      return;
    }

    // Load from CDN
    const script = document.createElement("script");
    script.src = "https://static.sumsub.com/idensic/static/sns-websdk-builder.js";
    script.async = true;
    script.onload = loadSdk;
    script.onerror = () => {
      setError("Failed to load verification SDK. Please check your connection and try again.");
      setPhase("error");
    };
    document.head.appendChild(script);

    return () => {
      // Don't remove script on cleanup — it may be used by other instances
    };
  }, [phase, sdkToken, onStatusChange]);

  const currentColors = STATUS_COLORS[kycStatus] ?? STATUS_COLORS.pending;

  // ── Verified state ────────────────────────────────────────────────────────
  if (phase === "verified" || kycStatus === "verified") {
    return (
      <div
        style={{
          padding: "1.25rem",
          borderRadius: "0.75rem",
          background: "rgba(22,160,122,0.06)",
          border: "1px solid rgba(22,160,122,0.2)",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>✅</div>
        <p style={{ fontWeight: 700, color: "#16a07a", fontSize: "0.95rem", marginBottom: "0.25rem" }}>
          Identity Verified
        </p>
        <p style={{ fontSize: "0.8rem", color: "#4b5563" }}>
          Your identity has been successfully verified. You now have full access to all lending pools.
        </p>
      </div>
    );
  }

  // ── Under Review state ────────────────────────────────────────────────────
  if (phase === "submitted" || kycStatus === "submitted") {
    return (
      <div
        style={{
          padding: "1.25rem",
          borderRadius: "0.75rem",
          background: "rgba(126,47,208,0.06)",
          border: "1px solid rgba(126,47,208,0.2)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.75rem" }}>
          <span style={{ fontSize: "1.5rem" }}>🔍</span>
          <div>
            <p style={{ fontWeight: 700, color: "#7e2fd0", fontSize: "0.9rem" }}>
              Under Review
            </p>
            <p style={{ fontSize: "0.78rem", color: "#6b7280" }}>
              Your documents are being reviewed. Usually 1–2 business days.
            </p>
          </div>
        </div>
        <div
          style={{
            height: "4px",
            borderRadius: "2px",
            background: "rgba(126,47,208,0.15)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: "65%",
              background: "linear-gradient(90deg, #7e2fd0, #22cf9d)",
              borderRadius: "2px",
              animation: "pulse 2s ease-in-out infinite",
            }}
          />
        </div>
        <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.6}}`}</style>
      </div>
    );
  }

  // ── Rejected state ────────────────────────────────────────────────────────
  if (phase === "rejected" || kycStatus === "rejected") {
    return (
      <div
        style={{
          padding: "1.25rem",
          borderRadius: "0.75rem",
          background: "rgba(220,38,38,0.06)",
          border: "1px solid rgba(220,38,38,0.2)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem", marginBottom: "1rem" }}>
          <span style={{ fontSize: "1.5rem" }}>❌</span>
          <div>
            <p style={{ fontWeight: 700, color: "#dc2626", fontSize: "0.9rem" }}>
              Verification Required
            </p>
            <p style={{ fontSize: "0.78rem", color: "#6b7280", lineHeight: 1.5 }}>
              Your previous submission was rejected. Please re-submit with a clear, valid government-issued ID.
            </p>
          </div>
        </div>
        <button
          id="kyc-resubmit-btn"
          onClick={handleStartVerification}
          style={{
            width: "100%",
            padding: "0.65rem 1rem",
            borderRadius: "0.5rem",
            background: "linear-gradient(135deg, #dc2626 0%, #ef4444 100%)",
            color: "#fff",
            fontWeight: 600,
            fontSize: "0.85rem",
            border: "none",
            cursor: "pointer",
          }}
        >
          Re-submit Documents
        </button>
      </div>
    );
  }

  // ── Dev mode simulation ───────────────────────────────────────────────────
  if (phase === "sdk_active" && isDevMode) {
    return (
      <div
        style={{
          padding: "1.25rem",
          borderRadius: "0.75rem",
          background: "rgba(126,47,208,0.04)",
          border: "1px dashed rgba(126,47,208,0.3)",
        }}
      >
        <p
          style={{
            fontSize: "0.72rem",
            fontWeight: 700,
            color: "#7e2fd0",
            textTransform: "uppercase",
            marginBottom: "0.75rem",
          }}
        >
          🧪 Development Mode — KYC Simulator
        </p>
        <p style={{ fontSize: "0.8rem", color: "#6b7280", marginBottom: "1rem", lineHeight: 1.6 }}>
          In production, the SumSub Web SDK iframe loads here. Set{" "}
          <code
            style={{
              background: "rgba(126,47,208,0.08)",
              padding: "0.1em 0.35em",
              borderRadius: "3px",
              fontSize: "0.78rem",
            }}
          >
            SUMSUB_APP_TOKEN
          </code>{" "}
          and{" "}
          <code
            style={{
              background: "rgba(126,47,208,0.08)",
              padding: "0.1em 0.35em",
              borderRadius: "3px",
              fontSize: "0.78rem",
            }}
          >
            SUMSUB_SECRET_KEY
          </code>{" "}
          to activate live verification.
        </p>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            id="kyc-sim-approve-btn"
            onClick={() => {
              setPhase("submitted");
              onStatusChange?.("submitted");
            }}
            style={{
              flex: 1,
              padding: "0.55rem",
              borderRadius: "0.4rem",
              background: "rgba(22,160,122,0.1)",
              color: "#16a07a",
              fontWeight: 600,
              fontSize: "0.8rem",
              border: "1px solid rgba(22,160,122,0.3)",
              cursor: "pointer",
            }}
          >
            ✅ Simulate Approval
          </button>
          <button
            id="kyc-sim-reject-btn"
            onClick={() => {
              setPhase("rejected");
              onStatusChange?.("rejected");
            }}
            style={{
              flex: 1,
              padding: "0.55rem",
              borderRadius: "0.4rem",
              background: "rgba(220,38,38,0.1)",
              color: "#dc2626",
              fontWeight: 600,
              fontSize: "0.8rem",
              border: "1px solid rgba(220,38,38,0.3)",
              cursor: "pointer",
            }}
          >
            ❌ Simulate Rejection
          </button>
        </div>
      </div>
    );
  }

  // ── SDK active (real) ─────────────────────────────────────────────────────
  if (phase === "sdk_ready" || phase === "sdk_active") {
    return (
      <div
        id="sumsub-websdk-container"
        ref={sdkContainerRef}
        style={{
          minHeight: "400px",
          borderRadius: "0.75rem",
          overflow: "hidden",
          border: "1px solid rgba(126,47,208,0.15)",
        }}
      />
    );
  }

  // ── Error state ───────────────────────────────────────────────────────────
  if (phase === "error") {
    return (
      <div
        style={{
          padding: "1rem",
          borderRadius: "0.75rem",
          background: "rgba(220,38,38,0.06)",
          border: "1px solid rgba(220,38,38,0.2)",
        }}
      >
        <p style={{ fontSize: "0.85rem", color: "#dc2626", fontWeight: 600, marginBottom: "0.5rem" }}>
          ⚠️ Verification Error
        </p>
        <p style={{ fontSize: "0.8rem", color: "#6b7280", marginBottom: "0.75rem" }}>
          {error}
        </p>
        <button
          id="kyc-retry-btn"
          onClick={handleStartVerification}
          style={{
            padding: "0.55rem 1rem",
            borderRadius: "0.4rem",
            background: "rgba(220,38,38,0.1)",
            color: "#dc2626",
            fontWeight: 600,
            fontSize: "0.8rem",
            border: "1px solid rgba(220,38,38,0.3)",
            cursor: "pointer",
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  // ── Loading state ─────────────────────────────────────────────────────────
  if (phase === "loading") {
    return (
      <div
        style={{
          padding: "1.5rem",
          borderRadius: "0.75rem",
          background: "rgba(126,47,208,0.04)",
          border: "1px solid rgba(126,47,208,0.12)",
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: "28px",
            height: "28px",
            borderRadius: "50%",
            border: "3px solid rgba(126,47,208,0.2)",
            borderTop: "3px solid #7e2fd0",
            animation: "spin 0.8s linear infinite",
            margin: "0 auto 0.75rem",
          }}
        />
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        <p style={{ fontSize: "0.85rem", color: "#7e2fd0", fontWeight: 600 }}>
          Initialising verification…
        </p>
      </div>
    );
  }

  // ── Default: CTA to start ─────────────────────────────────────────────────
  const colors = currentColors;
  const icon = STATUS_ICONS[kycStatus] ?? "⏳";
  const label = STATUS_LABELS[kycStatus] ?? "Not Started";

  return (
    <div>
      {/* Current status badge */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.65rem",
          padding: "0.85rem 1rem",
          borderRadius: "0.6rem",
          background: colors.bg,
          border: `1px solid ${colors.border}`,
          marginBottom: "1rem",
        }}
      >
        <span style={{ fontSize: "1.2rem" }}>{icon}</span>
        <div>
          <p style={{ fontWeight: 700, color: colors.color, fontSize: "0.85rem", margin: 0 }}>
            KYC Status · {label}
          </p>
          {kycProviderId && (
            <p style={{ fontSize: "0.72rem", color: "#9ca3af", margin: 0, marginTop: "0.1rem" }}>
              Ref: {kycProviderId.slice(0, 16)}…
            </p>
          )}
        </div>
      </div>

      {/* What to expect */}
      <div
        style={{
          padding: "0.85rem",
          borderRadius: "0.5rem",
          background: "rgba(126,47,208,0.03)",
          border: "1px dashed rgba(126,47,208,0.2)",
          marginBottom: "1rem",
        }}
      >
        <p style={{ fontSize: "0.78rem", fontWeight: 700, color: "#7e2fd0", marginBottom: "0.35rem" }}>
          What you&apos;ll need:
        </p>
        <ul
          style={{
            margin: 0,
            paddingLeft: "1.25rem",
            fontSize: "0.78rem",
            color: "#6b7280",
            lineHeight: 1.8,
          }}
        >
          <li>Government-issued photo ID (passport, national ID, or driver&apos;s licence)</li>
          <li>A selfie or short video for liveness check</li>
          <li>Approximately 3–5 minutes to complete</li>
        </ul>
      </div>

      {/* CTA */}
      <button
        id="kyc-start-verification-btn"
        onClick={handleStartVerification}
        style={{
          width: "100%",
          padding: "0.75rem 1rem",
          borderRadius: "0.6rem",
          background: "linear-gradient(135deg, #7e2fd0 0%, #22cf9d 100%)",
          color: "#fff",
          fontWeight: 700,
          fontSize: "0.9rem",
          border: "none",
          cursor: "pointer",
          letterSpacing: "0.01em",
          transition: "opacity 0.2s",
        }}
        onMouseEnter={(e) => ((e.target as HTMLButtonElement).style.opacity = "0.9")}
        onMouseLeave={(e) => ((e.target as HTMLButtonElement).style.opacity = "1")}
      >
        🔐 Start Identity Verification
      </button>

      <p
        style={{
          fontSize: "0.72rem",
          color: "#9ca3af",
          textAlign: "center",
          marginTop: "0.65rem",
          lineHeight: 1.5,
        }}
      >
        Powered by SumSub · Your data is encrypted and never shared with third parties
      </p>
    </div>
  );
}
