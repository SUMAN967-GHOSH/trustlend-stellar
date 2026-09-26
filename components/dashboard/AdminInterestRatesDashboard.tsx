"use client";

/**
 * Admin editor for the loan-origination APR schedules (issue #321).
 *
 * Reads and publishes through /api/admin/interest-rates. Rates used to be
 * hardcoded in the loan apply route; this is the interface that replaces the
 * deployment those changes needed.
 *
 * Publishing is versioned and append-only, so the panel is explicit that a
 * change only affects *new* applications — existing loans keep the APR they
 * were quoted at.
 */

import { useCallback, useMemo, useState, type CSSProperties } from "react";
import {
  AmountTier,
  InterestRateConfig,
  RATE_CONFIG_BOUNDS,
  RateModel,
  ReputationTier,
  previewRateSchedule,
  priceLoanApr,
  validateRateConfigDraft,
} from "@/lib/loans/rate-config";

interface AdminInterestRatesDashboardProps {
  initialActive: Record<RateModel, InterestRateConfig>;
  initialHistory: InterestRateConfig[];
  usingFallbackDefaults: boolean;
  adminEmail: string;
}

/** Editable mirror of a schedule, with APRs as percentages for the inputs. */
interface DraftForm {
  baseAprPct: number;
  minAprPct: number;
  maxAprPct: number;
  amountTiers: { minAmount: number; aprPct: number }[];
  reputationTiers: { minScore: number; multiplierX: number }[];
}

function configToForm(config: InterestRateConfig): DraftForm {
  return {
    baseAprPct: config.baseAprBps / 100,
    minAprPct: config.minAprBps / 100,
    maxAprPct: config.maxAprBps / 100,
    amountTiers: config.amountTiers.map((tier) => ({
      minAmount: tier.minAmount,
      aprPct: tier.aprBps / 100,
    })),
    reputationTiers: config.reputationTiers.map((tier) => ({
      minScore: tier.minScore,
      multiplierX: tier.multiplierBps / 10000,
    })),
  };
}

function formToDraft(form: DraftForm) {
  return {
    baseAprBps: Math.round(form.baseAprPct * 100),
    minAprBps: Math.round(form.minAprPct * 100),
    maxAprBps: Math.round(form.maxAprPct * 100),
    amountTiers: form.amountTiers.map(
      (tier): AmountTier => ({
        minAmount: Number(tier.minAmount),
        aprBps: Math.round(tier.aprPct * 100),
      }),
    ),
    reputationTiers: form.reputationTiers.map(
      (tier): ReputationTier => ({
        minScore: Number(tier.minScore),
        multiplierBps: Math.round(tier.multiplierX * 10000),
      }),
    ),
  };
}

const CARD_LABEL: CSSProperties = {
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  fontWeight: 700,
};

const SECTION_TITLE: CSSProperties = {
  fontSize: "1.05rem",
  fontWeight: 800,
  margin: 0,
  color: "var(--fg)",
};

export function AdminInterestRatesDashboard({
  initialActive,
  initialHistory,
  usingFallbackDefaults,
  adminEmail,
}: AdminInterestRatesDashboardProps) {
  const [active, setActive] = useState(initialActive);
  const [history, setHistory] = useState(initialHistory);
  const [usingFallback, setUsingFallback] = useState(usingFallbackDefaults);

  const [rateModel, setRateModel] = useState<RateModel>("fixed");
  const [form, setForm] = useState<DraftForm>(() => configToForm(initialActive.fixed));
  const [notes, setNotes] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const currentConfig = active[rateModel];

  /** Switching models discards an unpublished draft — reload from the active row. */
  const switchModel = useCallback(
    (model: RateModel) => {
      setRateModel(model);
      setForm(configToForm(active[model]));
      setConfirming(false);
      setError(null);
    },
    [active],
  );

  const draft = useMemo(() => formToDraft(form), [form]);

  /** The draft as a config object, so the preview uses the same math the server will. */
  const draftConfig = useMemo<InterestRateConfig>(
    () => ({
      rateModel,
      version: currentConfig.version + 1,
      ...draft,
    }),
    [rateModel, currentConfig.version, draft],
  );

  const previewRows = useMemo(() => {
    const amounts = [100, 500, 1000, 2000, 5000];
    const currentRows = previewRateSchedule(currentConfig, amounts);
    const draftRows = previewRateSchedule(draftConfig, amounts);
    return amounts.map((amount, index) => ({
      amount,
      currentPct: currentRows[index].aprPct,
      draftPct: draftRows[index].aprPct,
    }));
  }, [currentConfig, draftConfig]);

  /** Shows how the reputation ladder bends the rate at a fixed principal. */
  const reputationPreview = useMemo(() => {
    const sampleAmount = 1000;
    return [100, 250, 500, 750, 900].map((score) => ({
      score,
      aprPct: Number(
        (
          priceLoanApr(draftConfig, { amount: sampleAmount, reputationScore: score }).aprBps / 100
        ).toFixed(2),
      ),
    }));
  }, [draftConfig]);

  const validation = useMemo(() => validateRateConfigDraft(draft), [draft]);

  const isDirty = useMemo(() => {
    return JSON.stringify(draft) !== JSON.stringify({
      baseAprBps: currentConfig.baseAprBps,
      minAprBps: currentConfig.minAprBps,
      maxAprBps: currentConfig.maxAprBps,
      amountTiers: currentConfig.amountTiers,
      reputationTiers: currentConfig.reputationTiers,
    });
  }, [draft, currentConfig]);

  const handleStage = () => {
    setError(null);
    if (!validation.valid) {
      setError(validation.error ?? "Schedule is invalid");
      return;
    }
    if (!isDirty) {
      setError("No changes to publish");
      return;
    }
    setConfirming(true);
  };

  const handlePublish = async () => {
    if (notes.trim().length < RATE_CONFIG_BOUNDS.MIN_NOTES_LENGTH) {
      setError(
        `Please record a rationale of at least ${RATE_CONFIG_BOUNDS.MIN_NOTES_LENGTH} characters`,
      );
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/interest-rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rateModel, ...draft, notes: notes.trim() }),
      });
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json.error || "Failed to publish rate schedule");
      }

      setActive(json.data.active);
      setHistory(json.data.history);
      setUsingFallback(false);
      setForm(configToForm(json.data.active[rateModel]));
      setSuccess(json.message);
      setConfirming(false);
      setNotes("");
      setTimeout(() => setSuccess(null), 6000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setSubmitting(false);
    }
  };

  const updateAmountTier = (index: number, patch: Partial<{ minAmount: number; aprPct: number }>) => {
    setForm((prev) => ({
      ...prev,
      amountTiers: prev.amountTiers.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)),
    }));
  };

  const updateReputationTier = (
    index: number,
    patch: Partial<{ minScore: number; multiplierX: number }>,
  ) => {
    setForm((prev) => ({
      ...prev,
      reputationTiers: prev.reputationTiers.map((tier, i) =>
        i === index ? { ...tier, ...patch } : tier,
      ),
    }));
  };

  return (
    <div className="workspace-stack" style={{ gap: "1.5rem" }}>
      {/* ── Feedback banners ── */}
      {success && (
        <div
          style={{
            padding: "0.85rem 1.25rem",
            background: "color-mix(in srgb, var(--accent) 12%, transparent)",
            border: "1px solid color-mix(in srgb, var(--accent) 35%, transparent)",
            borderRadius: "0.75rem",
            color: "var(--accent-hover)",
            fontWeight: 600,
            fontSize: "0.9rem",
          }}
        >
          ✅ {success}
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "0.85rem 1.25rem",
            background: "color-mix(in srgb, var(--danger) 12%, transparent)",
            border: "1px solid color-mix(in srgb, var(--danger) 35%, transparent)",
            borderRadius: "0.75rem",
            color: "var(--danger)",
            fontWeight: 600,
            fontSize: "0.9rem",
          }}
        >
          ⚠️ {error}
        </div>
      )}

      {usingFallback && (
        <div
          style={{
            padding: "0.85rem 1.25rem",
            background: "color-mix(in srgb, var(--warning) 12%, transparent)",
            border: "1px solid color-mix(in srgb, var(--warning) 35%, transparent)",
            borderRadius: "0.75rem",
            color: "var(--warning)",
            fontWeight: 600,
            fontSize: "0.9rem",
          }}
        >
          ⚠️ No published schedule found in the database — new loans are being priced from the
          built-in defaults. Publish a schedule below to take control of origination rates.
        </div>
      )}

      {/* ── Active schedule summary ── */}
      <section className="workspace-grid workspace-grid--four">
        <div className="workspace-card">
          <span style={{ ...CARD_LABEL, color: "var(--primary)" }}>Fixed Base APR</span>
          <p style={{ fontSize: "1.75rem", fontWeight: 800, margin: "0.3rem 0 0", color: "var(--fg)" }}>
            {(active.fixed.baseAprBps / 100).toFixed(2)}%
          </p>
          <span style={{ fontSize: "0.78rem", color: "var(--fg-muted)" }}>
            Schedule v{active.fixed.version} · {active.fixed.amountTiers.length} amount tiers
          </span>
        </div>

        <div className="workspace-card">
          <span style={{ ...CARD_LABEL, color: "var(--accent)" }}>Floating Base APR</span>
          <p style={{ fontSize: "1.75rem", fontWeight: 800, margin: "0.3rem 0 0", color: "var(--fg)" }}>
            {(active.floating.baseAprBps / 100).toFixed(2)}%
          </p>
          <span style={{ fontSize: "0.78rem", color: "var(--fg-muted)" }}>
            Schedule v{active.floating.version} · {active.floating.amountTiers.length} amount tiers
          </span>
        </div>

        <div className="workspace-card">
          <span style={{ ...CARD_LABEL, color: "var(--warning)" }}>Editing</span>
          <p style={{ fontSize: "1.75rem", fontWeight: 800, margin: "0.3rem 0 0", color: "var(--fg)" }}>
            {rateModel === "fixed" ? "Fixed" : "Floating"}
          </p>
          <span style={{ fontSize: "0.78rem", color: "var(--fg-muted)" }}>
            {isDirty ? "Unpublished draft changes" : "In sync with live schedule"}
          </span>
        </div>

        <div className="workspace-card">
          <span style={{ ...CARD_LABEL, color: "var(--fg-muted)" }}>Publishes</span>
          <p style={{ fontSize: "1.75rem", fontWeight: 800, margin: "0.3rem 0 0", color: "var(--fg)" }}>
            {history.length}
          </p>
          <span style={{ fontSize: "0.78rem", color: "var(--fg-muted)" }}>
            Recorded rate changes across both models
          </span>
        </div>
      </section>

      {/* ── Retroactivity note ── */}
      <div
        style={{
          padding: "0.85rem 1.25rem",
          background: "color-mix(in srgb, var(--primary) 8%, transparent)",
          border: "1px solid color-mix(in srgb, var(--primary) 25%, transparent)",
          borderRadius: "0.75rem",
          color: "var(--fg-muted)",
          fontSize: "0.85rem",
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: "var(--fg)" }}>Changes apply to new applications only.</strong>{" "}
        Every loan stores the APR and schedule version it was quoted under, so publishing here never
        reprices a pending or active fixed-rate loan. Floating-rate loans track the live schedule by
        design — they are repriced on their next rate recalculation.
      </div>

      {/* ── Model selector ── */}
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        {(
          [
            { id: "fixed" as RateModel, label: "Fixed Rate Schedule", emoji: "🔒" },
            { id: "floating" as RateModel, label: "Floating Rate Schedule", emoji: "🌊" },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => switchModel(tab.id)}
            style={{
              padding: "0.6rem 1rem",
              borderRadius: "0.5rem",
              border: "none",
              background:
                rateModel === tab.id
                  ? "color-mix(in srgb, var(--primary) 12%, transparent)"
                  : "transparent",
              color: rateModel === tab.id ? "var(--primary)" : "var(--fg)",
              fontWeight: rateModel === tab.id ? 700 : 500,
              fontSize: "0.88rem",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
            }}
          >
            <span>{tab.emoji}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="workspace-grid workspace-grid--two" style={{ gap: "1.5rem" }}>
        {/* ── Editor ── */}
        <div className="workspace-card" style={{ padding: "1.25rem" }}>
          <h2 style={SECTION_TITLE}>Base &amp; Bounds</h2>
          <p style={{ fontSize: "0.82rem", color: "var(--fg-muted)", margin: "0.25rem 0 1rem" }}>
            The base APR applies when a loan clears no amount tier. Min and max clamp the final rate
            after tiers and trust multipliers are applied.
          </p>

          <div className="workspace-form-group">
            <label className="workspace-label" htmlFor="base-apr">
              Base APR (%)
            </label>
            <input
              id="base-apr"
              className="workspace-input"
              type="number"
              step="0.01"
              min={0}
              max={RATE_CONFIG_BOUNDS.MAX_APR_BPS / 100}
              value={form.baseAprPct}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, baseAprPct: Number(e.target.value) }))
              }
            />
            <p className="workspace-hint">
              Charged on loans below the smallest tier threshold. Ceiling:{" "}
              {RATE_CONFIG_BOUNDS.MAX_APR_BPS / 100}%
            </p>
          </div>

          <div className="workspace-grid workspace-grid--two" style={{ gap: "1rem" }}>
            <div className="workspace-form-group">
              <label className="workspace-label" htmlFor="min-apr">
                Minimum APR (%)
              </label>
              <input
                id="min-apr"
                className="workspace-input"
                type="number"
                step="0.01"
                min={0}
                value={form.minAprPct}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, minAprPct: Number(e.target.value) }))
                }
              />
            </div>

            <div className="workspace-form-group">
              <label className="workspace-label" htmlFor="max-apr">
                Maximum APR (%)
              </label>
              <input
                id="max-apr"
                className="workspace-input"
                type="number"
                step="0.01"
                min={0}
                value={form.maxAprPct}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, maxAprPct: Number(e.target.value) }))
                }
              />
            </div>
          </div>

          <h2 style={{ ...SECTION_TITLE, marginTop: "1.5rem" }}>Amount Tiers</h2>
          <p style={{ fontSize: "0.82rem", color: "var(--fg-muted)", margin: "0.25rem 0 1rem" }}>
            A loan takes the APR of the highest threshold its principal reaches.
          </p>

          {form.amountTiers.length === 0 && (
            <p style={{ fontSize: "0.85rem", color: "var(--fg-muted)" }}>
              No amount tiers — every loan is priced at the base APR.
            </p>
          )}

          {form.amountTiers.map((tier, index) => (
            <div
              key={index}
              className="workspace-grid workspace-grid--two"
              style={{ gap: "0.75rem", marginBottom: "0.75rem" }}
            >
              <div className="workspace-form-group">
                <label className="workspace-label" htmlFor={`tier-amount-${index}`}>
                  Min principal (XLM)
                </label>
                <input
                  id={`tier-amount-${index}`}
                  className="workspace-input"
                  type="number"
                  min={0}
                  step="1"
                  value={tier.minAmount}
                  onChange={(e) => updateAmountTier(index, { minAmount: Number(e.target.value) })}
                />
              </div>
              <div className="workspace-form-group">
                <label className="workspace-label" htmlFor={`tier-apr-${index}`}>
                  APR (%)
                </label>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <input
                    id={`tier-apr-${index}`}
                    className="workspace-input"
                    type="number"
                    step="0.01"
                    min={0}
                    value={tier.aprPct}
                    onChange={(e) => updateAmountTier(index, { aprPct: Number(e.target.value) })}
                  />
                  <button
                    type="button"
                    className="workspace-button workspace-button--secondary"
                    onClick={() =>
                      setForm((prev) => ({
                        ...prev,
                        amountTiers: prev.amountTiers.filter((_, i) => i !== index),
                      }))
                    }
                    aria-label={`Remove amount tier at ${tier.minAmount} XLM`}
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          ))}

          {form.amountTiers.length < RATE_CONFIG_BOUNDS.MAX_AMOUNT_TIERS && (
            <button
              type="button"
              className="workspace-button workspace-button--secondary"
              onClick={() =>
                setForm((prev) => ({
                  ...prev,
                  amountTiers: [...prev.amountTiers, { minAmount: 0, aprPct: prev.baseAprPct }],
                }))
              }
            >
              + Add amount tier
            </button>
          )}

          <h2 style={{ ...SECTION_TITLE, marginTop: "1.5rem" }}>Trust Score Multipliers</h2>
          <p style={{ fontSize: "0.82rem", color: "var(--fg-muted)", margin: "0.25rem 0 1rem" }}>
            Applied to the tier APR. 1.00x leaves the rate unchanged; 0.90x is a 10% discount for
            borrowers who clear that score.
          </p>

          {form.reputationTiers.map((tier, index) => (
            <div
              key={index}
              className="workspace-grid workspace-grid--two"
              style={{ gap: "0.75rem", marginBottom: "0.75rem" }}
            >
              <div className="workspace-form-group">
                <label className="workspace-label" htmlFor={`rep-score-${index}`}>
                  Min trust score
                </label>
                <input
                  id={`rep-score-${index}`}
                  className="workspace-input"
                  type="number"
                  min={0}
                  step="1"
                  value={tier.minScore}
                  onChange={(e) => updateReputationTier(index, { minScore: Number(e.target.value) })}
                />
              </div>
              <div className="workspace-form-group">
                <label className="workspace-label" htmlFor={`rep-mult-${index}`}>
                  Multiplier (x)
                </label>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <input
                    id={`rep-mult-${index}`}
                    className="workspace-input"
                    type="number"
                    step="0.01"
                    min={RATE_CONFIG_BOUNDS.MIN_MULTIPLIER_BPS / 10000}
                    max={RATE_CONFIG_BOUNDS.MAX_MULTIPLIER_BPS / 10000}
                    value={tier.multiplierX}
                    onChange={(e) =>
                      updateReputationTier(index, { multiplierX: Number(e.target.value) })
                    }
                  />
                  <button
                    type="button"
                    className="workspace-button workspace-button--secondary"
                    onClick={() =>
                      setForm((prev) => ({
                        ...prev,
                        reputationTiers: prev.reputationTiers.filter((_, i) => i !== index),
                      }))
                    }
                    aria-label={`Remove trust tier at score ${tier.minScore}`}
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          ))}

          {form.reputationTiers.length < RATE_CONFIG_BOUNDS.MAX_REPUTATION_TIERS && (
            <button
              type="button"
              className="workspace-button workspace-button--secondary"
              onClick={() =>
                setForm((prev) => ({
                  ...prev,
                  reputationTiers: [...prev.reputationTiers, { minScore: 0, multiplierX: 1 }],
                }))
              }
            >
              + Add trust tier
            </button>
          )}

          <div className="workspace-form-actions" style={{ marginTop: "1.5rem" }}>
            <button
              type="button"
              className="workspace-button workspace-button--primary"
              onClick={handleStage}
              disabled={submitting || !isDirty}
            >
              Review &amp; publish v{currentConfig.version + 1}
            </button>
            <button
              type="button"
              className="workspace-button workspace-button--secondary"
              onClick={() => switchModel(rateModel)}
              disabled={submitting || !isDirty}
            >
              Reset to live schedule
            </button>
          </div>

          {!validation.valid && isDirty && (
            <p style={{ fontSize: "0.82rem", color: "var(--danger)", marginTop: "0.75rem" }}>
              {validation.error}
            </p>
          )}
        </div>

        {/* ── Preview ── */}
        <div className="workspace-card" style={{ padding: "1.25rem" }}>
          <h2 style={SECTION_TITLE}>Quote Preview</h2>
          <p style={{ fontSize: "0.82rem", color: "var(--fg-muted)", margin: "0.25rem 0 1rem" }}>
            What a borrower with a 250 trust score would be quoted, live schedule versus your draft.
          </p>

          <div className="workspace-table-wrap">
            <table className="workspace-table">
              <thead>
                <tr>
                  <th>Principal</th>
                  <th>Live (v{currentConfig.version})</th>
                  <th>Draft</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row) => {
                  const delta = Number((row.draftPct - row.currentPct).toFixed(2));
                  return (
                    <tr key={row.amount}>
                      <td>{row.amount.toLocaleString()} XLM</td>
                      <td>{row.currentPct.toFixed(2)}%</td>
                      <td
                        style={{
                          fontWeight: 700,
                          color:
                            delta === 0
                              ? "var(--fg)"
                              : delta > 0
                                ? "var(--danger)"
                                : "var(--accent)",
                        }}
                      >
                        {row.draftPct.toFixed(2)}%
                        {delta !== 0 && (
                          <span style={{ fontSize: "0.75rem", marginLeft: "0.35rem" }}>
                            ({delta > 0 ? "+" : ""}
                            {delta.toFixed(2)})
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <h2 style={{ ...SECTION_TITLE, marginTop: "1.5rem" }}>Trust Score Effect</h2>
          <p style={{ fontSize: "0.82rem", color: "var(--fg-muted)", margin: "0.25rem 0 1rem" }}>
            Draft APR on a 1,000 XLM loan across trust scores.
          </p>

          <div className="workspace-table-wrap">
            <table className="workspace-table">
              <thead>
                <tr>
                  <th>Trust score</th>
                  <th>Draft APR</th>
                </tr>
              </thead>
              <tbody>
                {reputationPreview.map((row) => (
                  <tr key={row.score}>
                    <td>{row.score}</td>
                    <td style={{ fontWeight: 700 }}>{row.aprPct.toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Publish history ── */}
      <section className="workspace-stack" style={{ gap: "1rem" }}>
        <div>
          <h2 style={SECTION_TITLE}>Rate Change History</h2>
          <p style={{ fontSize: "0.85rem", color: "var(--fg-muted)", margin: "0.2rem 0 0" }}>
            Every published schedule is kept, so a loan&apos;s pricing can always be traced back to
            the version it was quoted under.
          </p>
        </div>

        <div className="workspace-table-wrap">
          <table className="workspace-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Version</th>
                <th>Base APR</th>
                <th>Tiers</th>
                <th>Published by</th>
                <th>Rationale</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 && (
                <tr>
                  <td className="workspace-empty-row" colSpan={6}>
                    No rate schedules published yet.
                  </td>
                </tr>
              )}
              {history.map((entry) => (
                <tr key={`${entry.rateModel}-${entry.version}`}>
                  <td style={{ textTransform: "capitalize" }}>{entry.rateModel}</td>
                  <td>v{entry.version}</td>
                  <td>{(entry.baseAprBps / 100).toFixed(2)}%</td>
                  <td>
                    {entry.amountTiers.length} amount · {entry.reputationTiers.length} trust
                  </td>
                  <td>{entry.updatedByEmail ?? "—"}</td>
                  <td style={{ maxWidth: "22rem" }}>{entry.notes ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Confirmation modal ── */}
      {confirming && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm rate schedule publish"
          style={{
            position: "fixed",
            inset: 0,
            background: "color-mix(in srgb, #000 55%, transparent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1.5rem",
            zIndex: 50,
          }}
        >
          <div
            className="workspace-card"
            style={{ maxWidth: "34rem", width: "100%", padding: "1.5rem" }}
          >
            <h2 style={SECTION_TITLE}>
              Publish {rateModel} schedule v{currentConfig.version + 1}?
            </h2>
            <p style={{ fontSize: "0.85rem", color: "var(--fg-muted)", margin: "0.5rem 0 1rem" }}>
              New {rateModel}-rate applications will be quoted from this schedule immediately.
              Existing loans keep the APR they were quoted at. Publishing as {adminEmail}.
            </p>

            <div className="workspace-table-wrap" style={{ marginBottom: "1rem" }}>
              <table className="workspace-table">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Live</th>
                    <th>New</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Base APR</td>
                    <td>{(currentConfig.baseAprBps / 100).toFixed(2)}%</td>
                    <td>{(draft.baseAprBps / 100).toFixed(2)}%</td>
                  </tr>
                  <tr>
                    <td>APR clamp</td>
                    <td>
                      {(currentConfig.minAprBps / 100).toFixed(2)}%–
                      {(currentConfig.maxAprBps / 100).toFixed(2)}%
                    </td>
                    <td>
                      {(draft.minAprBps / 100).toFixed(2)}%–{(draft.maxAprBps / 100).toFixed(2)}%
                    </td>
                  </tr>
                  <tr>
                    <td>Amount tiers</td>
                    <td>{currentConfig.amountTiers.length}</td>
                    <td>{draft.amountTiers.length}</td>
                  </tr>
                  <tr>
                    <td>Trust tiers</td>
                    <td>{currentConfig.reputationTiers.length}</td>
                    <td>{draft.reputationTiers.length}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="workspace-form-group">
              <label className="workspace-label" htmlFor="publish-notes">
                Rationale (required)
              </label>
              <input
                id="publish-notes"
                className="workspace-input"
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Lowered mid-tier APR to match market funding costs"
              />
              <p className="workspace-hint">
                Stored with the schedule version for the audit trail (min{" "}
                {RATE_CONFIG_BOUNDS.MIN_NOTES_LENGTH} characters).
              </p>
            </div>

            <div className="workspace-form-actions">
              <button
                type="button"
                className="workspace-button workspace-button--primary"
                onClick={handlePublish}
                disabled={submitting}
              >
                {submitting ? "Publishing…" : "Confirm publish"}
              </button>
              <button
                type="button"
                className="workspace-button workspace-button--secondary"
                onClick={() => {
                  setConfirming(false);
                  setError(null);
                }}
                disabled={submitting}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
