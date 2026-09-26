"use client";

/**
 * Interactive earnings calculator for the lender pools dashboard (issue #322).
 *
 * Replaces the TODO block in app/dashboard/lender/pools/page.tsx. Lenders model
 * a deposit — amount, lock-up, and target borrower tier — and see the forecast
 * update live before they commit any XLM.
 *
 * All arithmetic lives in lib/dashboard/lender-earnings.ts so it stays pure and
 * testable; this component only renders it.
 */

import { useMemo, useState, type CSSProperties } from "react";
import {
  LENDER_TIERS,
  MAX_DEPOSIT_XLM,
  MAX_DURATION_DAYS,
  MIN_DEPOSIT_XLM,
  MIN_DURATION_DAYS,
  PLATFORM_FEE_BPS,
  TIER_CONFIGS,
  clampDeposit,
  estimateLenderEarnings,
  type LenderTier,
} from "@/lib/dashboard/lender-earnings";
import { formatCurrency, formatXlmPrecise } from "@/lib/utils/formatting";

interface LenderEarningsEstimatorProps {
  /** Pool APR in bps the forecast starts from — the best active pool rate. */
  poolAprBps: number;
  /** Name of the pool that APR came from, shown as context. */
  poolName?: string | null;
  /** Prefill for the deposit slider, e.g. the lender's wallet balance. */
  initialDepositXlm?: number;
}

/** Accent colour per tier, so the toggles read as a progression. */
const TIER_COLOR: Record<LenderTier, string> = {
  Bronze: "#b06b3a",
  Silver: "var(--fg-muted)",
  Gold: "var(--warning)",
  Platinum: "var(--primary)",
};

const TIER_EMOJI: Record<LenderTier, string> = {
  Bronze: "🥉",
  Silver: "🥈",
  Gold: "🥇",
  Platinum: "💎",
};

/** Fraction of the way along a slider's track, for the filled-progress style. */
function trackPct(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return ((value - min) / (max - min)) * 100;
}

export function LenderEarningsEstimator({
  poolAprBps,
  poolName,
  initialDepositXlm,
}: LenderEarningsEstimatorProps) {
  const [depositXlm, setDepositXlm] = useState(() =>
    clampDeposit(initialDepositXlm && initialDepositXlm > 0 ? initialDepositXlm : 1_000),
  );
  const [durationDays, setDurationDays] = useState(90);
  const [tier, setTier] = useState<LenderTier>("Bronze");

  /** Raw text of the number input, so a partially typed value isn't clobbered. */
  const [depositDraft, setDepositDraft] = useState<string | null>(null);

  const estimate = useMemo(
    () => estimateLenderEarnings({ depositXlm, durationDays, poolAprBps, tier }),
    [depositXlm, durationDays, poolAprBps, tier],
  );

  /** Bronze at the same inputs, to show what the tier choice is worth. */
  const baselineNet = useMemo(
    () =>
      estimateLenderEarnings({ depositXlm, durationDays, poolAprBps, tier: "Bronze" })
        .netRewards,
    [depositXlm, durationDays, poolAprBps],
  );
  const tierUplift = Number((estimate.netRewards - baselineNet).toFixed(4));

  const commitDeposit = (raw: string) => {
    const parsed = Number(raw);
    setDepositXlm(clampDeposit(Number.isFinite(parsed) ? parsed : MIN_DEPOSIT_XLM));
    setDepositDraft(null);
  };

  const summaryCards: {
    label: string;
    value: string;
    hint: string;
    emphasis?: boolean;
  }[] = [
    {
      label: "Net Expected Rewards",
      value: formatXlmPrecise(estimate.netRewards),
      hint: `After ${formatXlmPrecise(estimate.platformFee)} platform fee`,
      emphasis: true,
    },
    {
      label: "Dynamic Yield (APR)",
      value: `${estimate.dynamicAprPct.toFixed(2)}%`,
      hint: `${(poolAprBps / 100).toFixed(2)}% pool rate × ${estimate.tierConfig.multiplier.toFixed(2)}x ${tier}`,
    },
    {
      label: "Reputation Points Gained",
      value: `+${estimate.reputationPoints.toLocaleString()} pts`,
      hint: `Over ${estimate.durationDays} days at ${estimate.tierConfig.multiplier.toFixed(2)}x`,
    },
  ];

  return (
    <section aria-labelledby="lender-estimator-heading" className="lender-estimator">
      {/* ── Header ── */}
      <header className="lender-estimator__header">
        <div>
          <h2 id="lender-estimator-heading" className="lender-estimator__title">
            📊 Lender Earnings Estimator
          </h2>
          <p className="lender-estimator__subtitle">
            Forecast your returns before committing capital. Based on the{" "}
            {poolName ? <strong>{poolName}</strong> : "best active"} pool rate of{" "}
            <strong>{(poolAprBps / 100).toFixed(2)}%</strong> APR.
          </p>
        </div>
        <span className="lender-estimator__badge">Estimate only</span>
      </header>

      <div className="lender-estimator__body">
        {/* ── Left: inputs ── */}
        <div className="lender-estimator__controls">
          {/* Deposit amount */}
          <div className="lender-estimator__field">
            <div className="lender-estimator__field-head">
              <label className="lender-estimator__label" htmlFor="estimator-deposit">
                💰 Deposit Amount
              </label>
              <div className="lender-estimator__amount-input">
                <input
                  id="estimator-deposit-number"
                  type="number"
                  className="lender-estimator__number"
                  min={MIN_DEPOSIT_XLM}
                  max={MAX_DEPOSIT_XLM}
                  step={100}
                  value={depositDraft ?? depositXlm}
                  onChange={(e) => setDepositDraft(e.target.value)}
                  onBlur={(e) => commitDeposit(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitDeposit(e.currentTarget.value);
                  }}
                  aria-label="Deposit amount in XLM"
                />
                <span className="lender-estimator__unit">XLM</span>
              </div>
            </div>
            <input
              id="estimator-deposit"
              type="range"
              className="lender-estimator__slider"
              min={MIN_DEPOSIT_XLM}
              max={MAX_DEPOSIT_XLM}
              step={100}
              value={depositXlm}
              onChange={(e) => {
                setDepositXlm(Number(e.target.value));
                setDepositDraft(null);
              }}
              style={{ "--fill": `${trackPct(depositXlm, MIN_DEPOSIT_XLM, MAX_DEPOSIT_XLM)}%` } as CSSProperties}
              aria-label="Deposit amount slider"
              aria-valuetext={`${depositXlm.toLocaleString()} XLM`}
            />
            <div className="lender-estimator__scale">
              <span>{MIN_DEPOSIT_XLM.toLocaleString()}</span>
              <span>{MAX_DEPOSIT_XLM.toLocaleString()} XLM</span>
            </div>
          </div>

          {/* Lock-up duration */}
          <div className="lender-estimator__field">
            <div className="lender-estimator__field-head">
              <label className="lender-estimator__label" htmlFor="estimator-duration">
                🗓️ Lock-up Duration
              </label>
              <span className="lender-estimator__value">
                {durationDays} days
                <span className="lender-estimator__value-sub">
                  ≈ {(durationDays / 30).toFixed(1)} mo
                </span>
              </span>
            </div>
            <input
              id="estimator-duration"
              type="range"
              className="lender-estimator__slider"
              min={MIN_DURATION_DAYS}
              max={MAX_DURATION_DAYS}
              step={1}
              value={durationDays}
              onChange={(e) => setDurationDays(Number(e.target.value))}
              style={{ "--fill": `${trackPct(durationDays, MIN_DURATION_DAYS, MAX_DURATION_DAYS)}%` } as CSSProperties}
              aria-label="Lock-up duration slider"
              aria-valuetext={`${durationDays} days`}
            />
            <div className="lender-estimator__scale">
              <span>{MIN_DURATION_DAYS} days</span>
              <span>{MAX_DURATION_DAYS} days</span>
            </div>
          </div>

          {/* Tier toggles */}
          <div className="lender-estimator__field">
            <span className="lender-estimator__label" id="estimator-tier-label">
              🏅 Target Borrower Tier
            </span>
            <div
              className="lender-estimator__tiers"
              role="group"
              aria-labelledby="estimator-tier-label"
            >
              {LENDER_TIERS.map((candidate) => {
                const active = candidate === tier;
                return (
                  <button
                    key={candidate}
                    type="button"
                    className={`lender-estimator__tier${
                      active ? " lender-estimator__tier--active" : ""
                    }`}
                    style={
                      active
                        ? ({
                            borderColor: TIER_COLOR[candidate],
                            color: TIER_COLOR[candidate],
                            background: `color-mix(in srgb, ${TIER_COLOR[candidate]} 12%, transparent)`,
                          } as CSSProperties)
                        : undefined
                    }
                    onClick={() => setTier(candidate)}
                    aria-pressed={active}
                  >
                    <span aria-hidden="true">{TIER_EMOJI[candidate]}</span>
                    <span>{candidate}</span>
                    <span className="lender-estimator__tier-mult">
                      {TIER_CONFIGS[candidate].multiplier.toFixed(2)}x
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="lender-estimator__tier-blurb">{estimate.tierConfig.blurb}</p>
          </div>
        </div>

        {/* ── Right: results ── */}
        <div className="lender-estimator__results">
          {summaryCards.map((card) => (
            <article
              key={card.label}
              className={`lender-estimator__result${
                card.emphasis ? " lender-estimator__result--primary" : ""
              }`}
            >
              <p className="lender-estimator__result-label">{card.label}</p>
              <p className="lender-estimator__result-value">{card.value}</p>
              <p className="lender-estimator__result-hint">{card.hint}</p>
            </article>
          ))}

          {/* Breakdown */}
          <dl className="lender-estimator__breakdown">
            <div>
              <dt>Principal returned</dt>
              <dd>{formatCurrency(estimate.depositXlm)}</dd>
            </div>
            <div>
              <dt>Gross interest</dt>
              <dd>{formatXlmPrecise(estimate.interestYield)}</dd>
            </div>
            <div>
              <dt>Platform fee ({PLATFORM_FEE_BPS / 100}%)</dt>
              <dd className="lender-estimator__breakdown-fee">
                −{formatXlmPrecise(estimate.platformFee)}
              </dd>
            </div>
            {tierUplift > 0 && (
              <div>
                <dt>{tier} tier uplift</dt>
                <dd className="lender-estimator__breakdown-gain">
                  +{formatXlmPrecise(tierUplift)}
                </dd>
              </div>
            )}
            <div className="lender-estimator__breakdown-total">
              <dt>Total at maturity</dt>
              <dd>{formatCurrency(estimate.totalPayout)}</dd>
            </div>
          </dl>

          <p className="lender-estimator__disclaimer">
            Projections assume the pool APR holds for the full lock-up and your capital stays
            matched to borrowers of the selected tier. Actual returns vary with pool utilization
            and borrower repayment.
          </p>
        </div>
      </div>
    </section>
  );
}
