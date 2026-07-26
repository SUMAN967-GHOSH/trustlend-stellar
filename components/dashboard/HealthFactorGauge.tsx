"use client";

import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import {
  computeHealthFactor,
  getHealthFactorColor,
  getHealthFactorLabel,
  simulateHealthFactor,
  healthFactorToArcPosition,
} from "@/lib/dashboard/health-factor";

interface HealthFactorGaugeProps {
  /** Total collateral value in USD. */
  collateralValueUsd: number;
  /** Total outstanding debt in USD. */
  debtValueUsd: number;
  /** Symbol of the collateral asset (e.g. "USDC") for slider labels. */
  collateralAssetSymbol?: string;
  /** Symbol of the debt asset (e.g. "XLM") for slider labels. */
  debtAssetSymbol?: string;
}

// ─── SVG gauge constants ──────────────────────────────────────────────────
const CX = 110;
const CY = 110;
const R = 90;
const STROKE_WIDTH = 16;

/** Build an SVG arc path for a semi-circle (180° → 0°, i.e. left to right). */
function describeArc(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
): string {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? 0 : 1;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
}

function polarToCartesian(
  cx: number,
  cy: number,
  r: number,
  angleDeg: number,
) {
  const rad = ((angleDeg - 180) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

/** Map a 0..1 position to a rotation angle for the needle (−90° to +90°). */
function positionToNeedleAngle(pos: number): number {
  return -90 + pos * 180;
}

// ─── Main component ──────────────────────────────────────────────────────

export function HealthFactorGauge({
  collateralValueUsd,
  debtValueUsd,
  collateralAssetSymbol = "USD",
  debtAssetSymbol = "USD",
}: HealthFactorGaugeProps) {
  const [collateralDelta, setCollateralDelta] = useState(0);
  const [debtDelta, setDebtDelta] = useState(0);

  const baseHf = useMemo(
    () => computeHealthFactor({ collateralValueUsd, debtValueUsd }),
    [collateralValueUsd, debtValueUsd],
  );

  const params = useMemo(
    () => ({ collateralValueUsd, debtValueUsd }),
    [collateralValueUsd, debtValueUsd],
  );

  const isSimulating = collateralDelta !== 0 || debtDelta !== 0;
  const displayHf = isSimulating
    ? simulateHealthFactor(params, collateralDelta, debtDelta)
    : baseHf;

  const displayValue = Number.isFinite(displayHf)
    ? displayHf.toFixed(2)
    : "∞";
  const color = getHealthFactorColor(displayHf);
  const label = getHealthFactorLabel(displayHf);
  const arcPos = healthFactorToArcPosition(displayHf);
  const needleAngle = positionToNeedleAngle(arcPos);

  // Slider max values — proportional to current position for intuitive ranges
  const maxCollateralAdd = Math.max(100, collateralValueUsd * 2);
  const maxDebtAdd = Math.max(100, debtValueUsd * 2);

  // Arc path for the full semi-circle background track
  const trackPath = describeArc(CX, CY, R, 0, 180);

  // Gradient arc segments (red → yellow → green)
  const redArc = describeArc(CX, CY, R, 0, 60);
  const yellowArc = describeArc(CX, CY, R, 55, 120);
  const greenArc = describeArc(CX, CY, R, 115, 180);

  // Simulated HF color + label for the result badge
  const simHfColor = isSimulating ? getHealthFactorColor(displayHf) : null;
  const simHfLabel = isSimulating ? getHealthFactorLabel(displayHf) : null;

  return (
    <div className="hf-gauge" id="health-factor-gauge">
      {/* Header + tooltip */}
      <div className="hf-gauge__header">
        <h2 className="hf-gauge__title">Health Factor</h2>
        <div className="hf-gauge__info-wrap">
          <button
            className="hf-gauge__info-btn"
            aria-label="Health Factor formula explanation"
            type="button"
          >
            ?
          </button>
          <div className="hf-gauge__tooltip" role="tooltip">
            <strong>Health Factor</strong> = Collateral Value ({collateralAssetSymbol}) ÷
            Outstanding Debt ({debtAssetSymbol}).
            <br /><br />
            Values <strong>below 1.0</strong> trigger liquidation. Keep your Health Factor{" "}
            <strong>above 1.5</strong> for a safe buffer. Add collateral or repay debt to improve it.
          </div>
        </div>
      </div>

      {/* SVG Gauge */}
      <div className="hf-gauge__meter">
        <svg
          className="hf-gauge__svg"
          viewBox="0 0 220 130"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="hf-red-grad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#dc2626" />
              <stop offset="100%" stopColor="#f59e0b" />
            </linearGradient>
            <linearGradient id="hf-yellow-grad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#f59e0b" />
              <stop offset="100%" stopColor="#84cc16" />
            </linearGradient>
            <linearGradient id="hf-green-grad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#84cc16" />
              <stop offset="100%" stopColor="#22cf9d" />
            </linearGradient>
            <filter id="hf-glow">
              <feGaussianBlur stdDeviation="3" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Background track */}
          <path
            d={trackPath}
            fill="none"
            stroke="rgba(122,138,177,0.12)"
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
          />

          {/* Colored arc segments */}
          <path
            d={redArc}
            fill="none"
            stroke="url(#hf-red-grad)"
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
            opacity={0.85}
          />
          <path
            d={yellowArc}
            fill="none"
            stroke="url(#hf-yellow-grad)"
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
            opacity={0.85}
          />
          <path
            d={greenArc}
            fill="none"
            stroke="url(#hf-green-grad)"
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
            opacity={0.85}
          />

          {/* Needle */}
          <motion.g
            style={{ originX: `${CX}px`, originY: `${CY}px` }}
            animate={{ rotate: needleAngle }}
            transition={{ type: "spring", stiffness: 60, damping: 15 }}
          >
            <line
              x1={CX}
              y1={CY}
              x2={CX}
              y2={CY - R + STROKE_WIDTH + 4}
              stroke={color}
              strokeWidth={3}
              strokeLinecap="round"
              filter="url(#hf-glow)"
            />
            <circle cx={CX} cy={CY} r={6} fill={color} />
            <circle cx={CX} cy={CY} r={3} fill="white" />
          </motion.g>
        </svg>
      </div>

      {/* Zone markers */}
      <div className="hf-gauge__zone-markers">
        <span style={{ color: "#ef4444" }}>Risk</span>
        <span style={{ color: "#f59e0b" }}>Warning</span>
        <span style={{ color: "#22cf9d" }}>Safe</span>
      </div>

      {/* Numeric value */}
      <div className="hf-gauge__value-block">
        <motion.p
          className="hf-gauge__value"
          style={{ color }}
          key={displayValue}
          initial={{ scale: 0.9, opacity: 0.5 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.3 }}
        >
          {displayValue}
        </motion.p>
        <p className="hf-gauge__zone-label" style={{ color }}>
          {label}
        </p>
      </div>

      {/* Simulation sliders */}
      <div className="hf-gauge__sim">
        <p className="hf-gauge__sim-title">Simulate Changes</p>

        {/* Add Collateral slider */}
        <div className="hf-gauge__slider-row">
          <div className="hf-gauge__slider-header">
            <span className="hf-gauge__slider-label">
              ➕ Add Collateral
            </span>
            <span
              className="hf-gauge__slider-value"
              style={{ color: collateralDelta > 0 ? "#22cf9d" : undefined }}
            >
              +${collateralDelta.toFixed(0)}
            </span>
          </div>
          <input
            id="hf-sim-collateral"
            type="range"
            className="hf-gauge__slider"
            min={0}
            max={maxCollateralAdd}
            step={1}
            value={collateralDelta}
            onChange={(e) => setCollateralDelta(Number(e.target.value))}
            aria-label={`Simulate adding collateral in ${collateralAssetSymbol}`}
          />
        </div>

        {/* Borrow More slider */}
        <div className="hf-gauge__slider-row">
          <div className="hf-gauge__slider-header">
            <span className="hf-gauge__slider-label">
              📈 Borrow More
            </span>
            <span
              className="hf-gauge__slider-value"
              style={{ color: debtDelta > 0 ? "#ef4444" : undefined }}
            >
              +${debtDelta.toFixed(0)}
            </span>
          </div>
          <input
            id="hf-sim-debt"
            type="range"
            className="hf-gauge__slider"
            min={0}
            max={maxDebtAdd}
            step={1}
            value={debtDelta}
            onChange={(e) => setDebtDelta(Number(e.target.value))}
            aria-label={`Simulate borrowing more in ${debtAssetSymbol}`}
          />
        </div>

        {/* Simulated result */}
        {isSimulating && simHfColor && simHfLabel && (
          <motion.div
            className="hf-gauge__sim-result"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
          >
            <span style={{ color: "#56658b", fontSize: "0.78rem" }}>Simulated HF:</span>
            <span
              className="hf-gauge__sim-badge"
              style={{ background: simHfColor }}
            >
              {Number.isFinite(displayHf) ? displayHf.toFixed(2) : "∞"} — {simHfLabel}
            </span>
          </motion.div>
        )}
      </div>
    </div>
  );
}
