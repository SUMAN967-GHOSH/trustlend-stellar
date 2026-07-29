# Dynamic APR Yield Calculation — Mathematical Formulas

> **Last updated:** July 29, 2026  
> **Source contracts:** `contracts/lending/src/lib.rs`, `contracts/borrower_reputation/src/lib.rs`  
> **TypeScript reference:** `lib/dashboard/interest-rates.ts`, `types/contracts.ts`

---

## Table of Contents

1. [Overview](#1-overview)
2. [Core Interest Formula](#2-core-interest-formula)
3. [Interest Rate Models](#3-interest-rate-models)
   - [Rate Determination Flow](#31-rate-determination-flow)
   - [Fixed Rate](#32-fixed-rate)
   - [Floating Rate (Utilization Curve)](#33-floating-rate-utilization-curve)
   - [Floating Rate Recalculation](#34-floating-rate-recalculation-on-chain)
4. [Pool Utilization Rate](#4-pool-utilization-rate)
5. [Reputation Tier Multipliers](#5-reputation-tier-multipliers)
6. [Rate Model Switching](#6-rate-model-switching)
7. [Platform Fee](#7-platform-fee)
8. [Flash Loan Fee](#8-flash-loan-fee)
9. [Liquidation Threshold](#9-liquidation-threshold)
10. [Oracle Credit Score Boost](#10-oracle-credit-score-boost)
11. [Worked Examples](#11-worked-examples)
12. [Constants Reference](#12-constants-reference)
13. [Formal Verification](#13-formal-verification)

---

## 1. Overview

TrustLend uses a **dual interest-rate model** that borrowers can choose between:

| Model | Behaviour | Best For |
|---|---|---|
| **Fixed** | Rate locked at loan creation, based on pool utilization snapshot + 50 bps premium | Borrowers wanting predictable payments |
| **Floating** | Rate adjusts dynamically with pool utilization via a linear curve | Borrowers who expect utilization to decrease |

Both models are overlaid with **reputation-tier multipliers** — higher-reputation borrowers always get better rates regardless of which model they choose.

---

## 2. Core Interest Formula

The fundamental interest calculation for any loan is:

$$\text{Interest} = \frac{P \times R \times D}{10,\!000 \times 365}$$

Where:
| Variable | Description | Unit |
|---|---|---|
| $P$ | Principal amount | stroops ($1$ XLM $= 10^7$ stroops) |
| $R$ | Interest rate | basis points (bps). $100$ bps $= 1\%$ |
| $D$ | Loan duration | days |

**Source:** `contracts/lending/src/lib.rs` — `fn calculate_interest()`:

```rust
fn calculate_interest(principal: i128, rate_bps: u32, days: u32) -> i128 {
    let numerator = principal
        .checked_mul(rate_bps as i128)
        .expect("Overflow: principal × rate_bps")
        .checked_mul(days as i128)
        .expect("Overflow: (principal × rate_bps) × days");
    numerator / (10_000_i128 * 365)
}
```

**Identity:** For a full year ($D = 365$), the formula simplifies to:

$$\text{Interest}_{365} = \frac{P \times R}{10,\!000}$$

This is formally verified in **INV-MATH-12** — see [Formal Verification](#13-formal-verification).

---

## 3. Interest Rate Models

### 3.1 Rate Determination Flow

It is critical to understand the two-layer architecture:

| Layer | What it does | File(s) |
|---|---|---|
| **On-chain (Contract)** | Stores the `interest_rate_bps` parameter verbatim. For new Fixed-rate loans, the rate passed in is the **reputation tier rate** fetched from the Reputation contract. The lending contract does **not** compute any blended or curve-adjusted rate on-chain. | `contracts/lending/src/lib.rs` (`create_loan_request`), `contracts/borrower_reputation/src/lib.rs` (`calculate_interest_rate`) |
| **Frontend (Dashboard)** | Computes **suggested/display** rates using the utilization curve and fixed premium. These are guidance values shown in the UI to help borrowers decide. | `lib/dashboard/interest-rates.ts` (`computeFixedRate`, `computeFloatingRate`) |

### 3.2 Fixed Rate

**On-chain behaviour:** The rate passed to `create_loan_request` is the borrower's **reputation tier rate** and is locked for the entire loan duration. It never changes.

**Dashboard suggested rate (frontend utility):** The UI can compute a suggested fixed rate based on the average pool utilization, adding a 50 bps premium for the predictability guarantee:

$$R_{\text{fixed\_suggested}} = \text{clamp}\Big(R_{\text{base}} + \lfloor U_{\text{avg}} \times S \rfloor + P_{\text{fixed}},\; R_{\text{min}},\; R_{\text{max}}\Big)$$

| Symbol | Value | Description |
|---|---|---|
| $R_{\text{base}}$ | `500` bps ($5\%$) | Base rate |
| $U_{\text{avg}}$ | varies | Average utilization ratio $[0, 1]$ |
| $S$ | `2000` bps | Slope (produces up to $20\%$ at $100\%$ utilization) |
| $P_{\text{fixed}}$ | `50` bps ($0.5\%$) | Fixed-rate premium for predictability |
| $R_{\text{min}}$ | `200` bps ($2\%$) | Rate floor |
| $R_{\text{max}}$ | `5000` bps ($50\%$) | Rate ceiling |

**Source:** `lib/dashboard/interest-rates.ts` — `computeFixedRate()`:

```typescript
export function computeFixedRate(
  avgUtilization: number,
  baseRateBps: number = FLOATING_BASE_RATE_BPS,
  slopeBps: number = FLOATING_SLOPE_BPS,
): number {
  const clampedUtil = Math.min(1, Math.max(0, avgUtilization));
  const baseFloating = baseRateBps + Math.floor(clampedUtil * slopeBps);
  const fixedPremium = 50;
  const rawRate = baseFloating + fixedPremium;
  return Math.min(MAX_FLOATING_RATE_BPS, Math.max(MIN_FLOATING_RATE_BPS, rawRate));
}
```

### 3.3 Floating Rate (Utilization Curve)

**On-chain behaviour:** The floating rate starts at the borrower's reputation tier rate (set at loan creation). The admin can subsequently call `update_floating_rate(new_rate_bps)` to adjust the rate based on pool utilization. When the floating rate changes, the outstanding interest is recalculated using the formula in [§3.4](#34-floating-rate-recalculation).

**Dashboard suggested rate (frontend utility):** The UI computes a dynamic rate suggestion based on the pool's current utilization:

$$R_{\text{floating\_suggested}} = \text{clamp}\Big(R_{\text{base}} + \lfloor U \times S \rfloor,\; R_{\text{min}},\; R_{\text{max}}\Big)$$

Where $U$ is the current utilization ratio (see [§4](#4-pool-utilization-rate)).

**Graphical representation:**

```
Rate (%)
  ^
  |   R_max = 50% ────────────────•────────────────
  |                              /
  |                             /
  |                            /
  |                           /
  |                          /
  |                         /
20% ─────────────────────•───────────────────────────
  |                      /|
  |                     / |
  |                    /  |
  |                   /   |
  |                  /    |
  |                 /     |
  |     R_base = 5% •─────•──────────────────────────→ Utilization
  |                 0%   100%
```

**Key properties:**
- **Linear:** Rate increases linearly with utilization (slope = 2000 bps)
- **Floored at 2%:** Even with zero utilization, rate never goes below 200 bps
- **Capped at 50%:** Even at extreme utilization, rate never exceeds 5000 bps
- **No fixed premium:** Unlike the fixed model, there is no +50 bps premium

**Source:** `lib/dashboard/interest-rates.ts` — `computeFloatingRate()`:

```typescript
export function computeFloatingRate(params: FloatingRateParams): number {
  const baseRate = params.baseRateBps ?? FLOATING_BASE_RATE_BPS;
  const slope = params.slopeBps ?? FLOATING_SLOPE_BPS;
  const utilization = computeUtilization(params.totalBorrowed, params.totalLiquidity);
  const rawRate = baseRate + Math.floor(utilization * slope);
  return Math.min(MAX_FLOATING_RATE_BPS, Math.max(MIN_FLOATING_RATE_BPS, rawRate));
}
```

### 3.4 Floating Rate Recalculation (On-Chain)

When the admin calls `update_floating_rate(loan_id, new_rate_bps)` on a Floating-rate loan, the contract recalculates the remaining interest:

**Step 1 — Compute remaining days:**

$$D_{\text{remaining}} = \max\left(0,\; \frac{T_{\text{due}} - T_{\text{now}}}{86,\!400}\right)$$

Where $T_{\text{due}}$ and $T_{\text{now}}$ are ledger timestamps in seconds.

**Step 2 — Recalculate interest on remaining principal:**

$$I_{\text{new}} = \frac{P_{\text{remaining}} \times R_{\text{new}} \times D_{\text{remaining}}}{10,\!000 \times 365}$$

Where $P_{\text{remaining}}$ is the original principal amount (not the remaining debt — principal is tracked separately).

**Step 3 — Compute new totals:**

$$\text{TotalDue}^{\prime} = P + I_{\text{new}}$$

$$\text{RemainingDue}^{\prime} = \text{TotalDue}^{\prime} - \text{PaidSoFar}$$

Where $\text{PaidSoFar} = \text{TotalDue}_{\text{old}} - \text{RemainingDue}_{\text{old}}$.

**Source:** `contracts/lending/src/lib.rs` — `update_floating_rate()`:

```rust
let now = env.ledger().timestamp();
let remaining_secs = loan.due_at.saturating_sub(now);
let remaining_days = (remaining_secs / 86_400) as u32;

let paid_so_far = loan.total_due - loan.remaining_due;
let remaining_principal = loan.amount;

let new_interest =
    Self::calculate_interest(remaining_principal, new_rate_bps, remaining_days);
let new_total_due = loan.amount.checked_add(new_interest).unwrap();
loan.total_due = new_total_due;
loan.remaining_due = new_total_due.checked_sub(paid_so_far).unwrap();
loan.interest_rate_bps = new_rate_bps;
loan.last_rate_update = now;
```

---

## 4. Pool Utilization Rate

The utilization rate is the fraction of total pool liquidity that is currently borrowed:

$$U = \min\!\left(1,\; \max\!\left(0,\; \frac{B_{\text{total}}}{L_{\text{total}}}\right)\right)$$

| Symbol | Description |
|---|---|
| $B_{\text{total}}$ | Total amount currently borrowed from the pool |
| $L_{\text{total}}$ | Total liquidity (borrowed + idle) |

Returns $0$ if $L_{\text{total}} \leq 0$.

**Source:** `lib/dashboard/interest-rates.ts` — `computeUtilization()`:

```typescript
export function computeUtilization(totalBorrowed: number, totalLiquidity: number): number {
  if (totalLiquidity <= 0) return 0;
  return Math.min(1, Math.max(0, totalBorrowed / totalLiquidity));
}
```

---

## 5. Reputation Tier Multipliers

Borrowers earn reputation scores through on-chain behaviour (timely repayments, default-free history). Their tier determines both their **interest rate** and **maximum loan amount**.

### Tier Thresholds

| Tier | Score Range | Interest Rate (bps) | Max Loan (XLM) |
|---|---|---|---|
| **None** | $< 50$ | `1500` ($15.00\%$) | `1,000` |
| **Beginner** | $50$ – $149$ | `1300` ($13.00\%$) | `2,000` |
| **Silver** | $150$ – $499$ | `1200` ($12.00\%$) | `5,000` |
| **Gold** | $500$ – $999$ | `1000$ ($10.00\%$) | `10,000` |
| **Platinum** | $\geq 1000$ | `800$ ($8.00\%$) | `100,000` |

**Source:** `contracts/borrower_reputation/src/lib.rs`:

```rust
fn score_to_tier(score: i128) -> ReputationTier {
    if score < 50 { ReputationTier::None }
    else if score < 150 { ReputationTier::Beginner }
    else if score < 500 { ReputationTier::Silver }
    else if score < 1000 { ReputationTier::Gold }
    else { ReputationTier::Platinum }
}

fn tier_interest_rate(tier: &ReputationTier) -> u32 {
    match tier {
        ReputationTier::None     => 1500,  // 15.00 %
        ReputationTier::Beginner => 1300,  // 13.00 %
        ReputationTier::Silver   => 1200,  // 12.00 %
        ReputationTier::Gold     => 1000,  // 10.00 %
        ReputationTier::Platinum =>  800,  //  8.00 %
    }
}
```

### Reputation Events

Events adjust the borrower's reputation score, which may move them between tiers:

| Event | Delta (points) | Flags |
|---|---|---|
| `TestLoanRepaid` | $+50$ | Counts as repaid loan |
| `LoanRepaidOnTime` | $+20$ | Counts as repaid loan |
| `LoanPaidEarly` | $+30$ | Counts as repaid loan |
| `LoanLate1Day` | $-5$ | — |
| `LoanLate7Days` | $-50$ | — |
| `LoanDefaulted` | $-100$ | Counts as default |
| `LateWarning` | $-50$ | — |

---

## 6. Rate Model Switching

Borrowers may switch between Fixed and Floating rate models at any time, subject to a **fee** and **cooldown**.

### Switch Fee

$$F_{\text{switch}} = \frac{D_{\text{remaining}} \times F_{\text{bps}}}{10,\!000}$$

Where:
- $D_{\text{remaining}}$ = remaining debt (stroops)
- $F_{\text{bps}} = 50$ bps ($0.5\%$ of remaining debt)

### Cooldown

$$\Delta_{\text{switch}} \geq C_{\text{cooldown}} = 86,\!400 \text{ seconds } (24 \text{ hours})$$

Both conditions are enforced on-chain in `switch_rate_model()`.

### Effect of Switching

When switching:
1. The switch fee is added to `remaining_due` and `total_due`
2. The rate model toggles (`Fixed ⇄ Floating`)
3. A 24-hour cooldown timer starts
4. The last-rate-update timestamp is set to the current ledger time

For Floating → Fixed switches, the floating rate at the time of switch is used as the new fixed rate (with the +50 bps premium applied).

---

## 7. Platform Fee

The protocol charges a platform fee on every loan's interest:

$$F_{\text{platform}} = \frac{I \times F_{\text{protocol}}}{10,\!000}$$

| Symbol | Default | Max | Description |
|---|---|---|---|
| $F_{\text{protocol}}$ | `100` bps ($1\%$) | `1000` bps ($10\%$) | Platform fee rate |
| $I$ | varies | — | Total interest on the loan |

The fee is collected at loan creation and stored as `UncollectedFees`. It can be swept to the Treasury contract by calling `collect_fees()`.

The platform fee rate can only be changed by a successful DAO governance vote — there is no admin override path.

---

## 8. Flash Loan Fee

Flash loans (uncollateralized, same-transaction borrowing) carry a fee:

$$F_{\text{flash}} = \frac{A \times F_{\text{flash\_bps}}}{10,\!000}$$

| Symbol | Default | Max | Description |
|---|---|---|---|
| $F_{\text{flash\_bps}}$ | `9` bps ($0.09\%$) | `500` bps ($5\%$) | Flash loan fee rate |
| $A$ | varies | — | Flash loan amount (stroops) |

The flash loan receiver must return $A + F_{\text{flash}}$ before the transaction ends, or the entire transaction (including the initial disbursement) reverts atomically.

---

## 9. Liquidation Threshold

The liquidation threshold determines the Loan-to-Value (LTV) ratio at which a position becomes eligible for liquidation.

$$\text{Threshold} = \text{clamp}\Big(7500 + B_{\text{rep}} - P_{\text{vol}},\; 5000,\; 9000\Big)$$

Where:
| Component | Formula | Description |
|---|---|---|
| Base | $7500$ bps ($75\%$) | Default LTV threshold |
| Reputation bonus | $B_{\text{rep}} = \lfloor \frac{S_{\text{score}} \times 15}{10} \rfloor$ | Max $+1500$ bps ($+15\%$) |
| Volatility penalty | $P_{\text{vol}} = \lfloor \frac{V_{\text{bps}}}{2} \rfloor$ | Half of asset volatility |

**Clamping range:** $[5000,\; 9000]$ bps ($[50\%,\; 90\%]$)

**Key properties:**
- Higher reputation scores → higher threshold (harder to liquidate)
- Higher asset volatility → lower threshold (easier to liquidate)
- Always within $[50\%, 90\%]$ regardless of inputs

**Source:** `contracts/lending/src/lib.rs` — `calculate_liquidation_threshold()`:

```rust
pub fn calculate_liquidation_threshold(
    _env: Env,
    borrower_reputation_score: u32,
    asset_volatility_bps: u32,
) -> u32 {
    let base_threshold: u32 = 7500;
    let reputation_bonus = (borrower_reputation_score as u64)
        .checked_mul(15)
        .and_then(|v| v.checked_div(10))
        .expect("Overflow calculating reputation bonus");
    let volatility_penalty = (asset_volatility_bps as u64)
        .checked_div(2)
        .expect("Overflow calculating volatility penalty");
    let threshold = (base_threshold as u64)
        .checked_add(reputation_bonus)
        .expect("Overflow adding reputation bonus")
        .saturating_sub(volatility_penalty);
    threshold.clamp(5000, 9000) as u32
}
```

---

## 10. Oracle Credit Score Boost

The Decentralized Credit Oracle can post verified off-chain credit scores to boost a borrower's maximum loan limit beyond their reputation tier's base limit.

### Boost Calculation

$$B_{\text{boost}} = \frac{S_{\text{credit}} \times 10,\!000}{1000} = S_{\text{credit}} \times 10 \text{ bps}$$

Where $S_{\text{credit}} \in [0, 1000]$ is the normalised credit score.

| Credit Score | Boost (bps) | Boost (%) |
|---|---|---|
| $0$ | $0$ | $+0\%$ |
| $300$ | $3000$ | $+30\%$ |
| $500$ | $5000$ | $+50\%$ |
| $800$ | $8000$ | $+80\%$ |
| $1000$ | $10,\!000$ | $+100\%$ |

### Application to Max Loan

$$\text{MaxLoan} = L_{\text{base}} + \frac{L_{\text{base}} \times B_{\text{boost}}}{10,\!000}$$

### Freshness Check

Oracle data is only considered valid for **90 days**:

$$\text{is\_fresh} = \text{now} - T_{\text{updated}} \leq 90 \times 24 \times 60 \times 60 \text{ sec}$$

Stale records are ignored, and the base tier limit applies unchanged.

### Restrictions

- **Frozen accounts** receive no oracle boost (only base tier limit)
- The boost is capped at $+100\%$ ($B_{\text{boost}} \leq 10,\!000$ bps)

---

## 11. Worked Examples

### Example 1: Fixed-Rate Loan, Silver Tier

**Inputs:**
- Principal: $P = 2,\!500$ XLM $= 25,\!000,\!000,\!000$ stroops
- Duration: $D = 90$ days
- Borrower tier: Silver ($R_{\text{tier}} = 1200$ bps)

The on-chain rate **is** the tier rate — no curve blending is applied by the contract.

**Step 1 — Calculate interest:**
$$I = \frac{25,\!000,\!000,\!000 \times 1200 \times 90}{10,\!000 \times 365} = 739,\!726,\!027 \text{ stroops} \approx 73.97 \text{ XLM}$$

**Step 2 — Total due:**
$$\text{TotalDue} = 25,\!000,\!000,\!000 + 739,\!726,\!027 = 25,\!739,\!726,\!027 \text{ stroops}$$

**Step 3 — Platform fee (1% of interest):**
$$F_{\text{platform}} = \frac{739,\!726,\!027 \times 100}{10,\!000} = 7,\!397,\!260 \text{ stroops} \approx 0.74 \text{ XLM}$$

> **Dashboard display only:** The UI might suggest a rate of $1550$ bps (utilization curve + fixed premium) as a reference, but the actual on-chain rate is always the borrower's tier rate.

---

### Example 2: Floating-Rate Loan, Gold Tier

**Inputs:**
- Principal: $P = 5,\!000$ XLM $= 50,\!000,\!000,\!000$ stroops
- Duration: $D = 30$ days
- Borrower tier: Gold ($R_{\text{tier}} = 1000$ bps)

The initial on-chain rate is the tier rate ($1000$ bps). The admin may later update it via `update_floating_rate` based on utilization.

**Step 1 — Initial interest (at tier rate):**
$$I = \frac{50,\!000,\!000,\!000 \times 1000 \times 30}{10,\!000 \times 365} = 410,\!958,\!904 \text{ stroops} \approx 41.10 \text{ XLM}$$

If the admin later updates the rate to $2100$ bps (based on $80\%$ utilization) with 15 days remaining:

**Step 2 — Recalculated interest (update_floating_rate):**
$$I_{\text{new}} = \frac{50,\!000,\!000,\!000 \times 2100 \times 15}{10,\!000 \times 365} = 431,\!506,\!849 \text{ stroops} \approx 43.15 \text{ XLM}$$

---

### Example 3: Liquidation Threshold with Reputation Boost

**Inputs:**
- Borrower reputation score: $S_{\text{score}} = 750$
- Asset volatility: $V_{\text{bps}} = 800$ bps ($8\%$)

**Step 1 — Reputation bonus:**
$$B_{\text{rep}} = \lfloor 750 \times 15 / 10 \rfloor = \lfloor 1125 \rfloor = 1125 \text{ bps}$$

**Step 2 — Volatility penalty:**
$$P_{\text{vol}} = \lfloor 800 / 2 \rfloor = 400 \text{ bps}$$

**Step 3 — Threshold:**
$$\text{Threshold} = \text{clamp}(7500 + 1125 - 400,\; 5000,\; 9000) = \text{clamp}(8225,\; 5000,\; 9000) = 8225 \text{ bps}$$

This loan would be liquidated when its LTV reaches $82.25\%$.

---

### Example 4: Oracle Score Boost on Max Loan

**Inputs:**
- Borrower tier: Beginner ($L_{\text{base}} = 2,\!000$ XLM)
- Oracle credit score: $S_{\text{credit}} = 700$ (fresh)

**Step 1 — Compute boost:**
$$B_{\text{boost}} = \frac{700 \times 10,\!000}{1000} = 7000 \text{ bps} = 70\%$$

**Step 2 — Applied boost:**
$$\text{Boost} = \frac{2,\!000 \times 7000}{10,\!000} = 1,\!400 \text{ XLM}$$

**Step 3 — Enhanced max loan:**
$$\text{MaxLoan} = 2,\!000 + 1,\!400 = 3,\!400 \text{ XLM}$$

---

## 12. Constants Reference

### Lending Contract (`contracts/lending/src/lib.rs`)

| Constant | Value | Description |
|---|---|---|
| `DEFAULT_PLATFORM_FEE_BPS` | `100` | $1\%$ of interest |
| `MAX_PLATFORM_FEE_BPS` | `1000` | Hard ceiling ($10\%$) |
| `DEFAULT_FLASH_LOAN_FEE_BPS` | `9` | $0.09\%$ of borrowed amount |
| `MAX_FLASH_LOAN_FEE_BPS` | `500` | Hard ceiling ($5\%$) |
| `RATE_SWITCH_FEE_BPS` | `50` | $0.5\%$ of remaining debt |
| `RATE_SWITCH_COOLDOWN_SECS` | `86,400` | 24 hours |

### Interest Rate Model (`lib/dashboard/interest-rates.ts`)

| Constant | Value | Description |
|---|---|---|
| `FLOATING_BASE_RATE_BPS` | `500` | Base rate ($5\%$) |
| `FLOATING_SLOPE_BPS` | `2000` | Utilization curve slope |
| `MIN_FLOATING_RATE_BPS` | `200` | Rate floor ($2\%$) |
| `MAX_FLOATING_RATE_BPS` | `5000` | Rate ceiling ($50\%$) |
| `RATE_SWITCH_FEE_BPS` | `50` | Switch fee ($0.5\%$) |
| `RATE_SWITCH_COOLDOWN_SECS` | `86,400` | Cooldown (24h) |

### Reputation Contract (`contracts/borrower_reputation/src/lib.rs`)

| Constant | Value | Description |
|---|---|---|
| `MAX_ORACLE_SCORE` | `1000` | Max credit score |
| `MAX_LIMIT_TO_BOOST_BPS` | `10,000` | Max boost ($+100\%$) |
| `ORACLE_VALIDITY_SECONDS` | `7,776,000` | 90 days |

### Liquidation Threshold (`contracts/lending/src/lib.rs`)

| Constant | Value | Description |
|---|---|---|
| **Base threshold** | `7500` bps | $75\%$ LTV |
| **Min threshold** | `5000` bps | $50\%$ LTV floor |
| **Max threshold** | `9000` bps | $90\%$ LTV ceiling |
| **Volatility divisor** | $2$ | Half of asset volatility |
| **Reputation multiplier** | $\times 1.5$ | Score $\times 15 / 10$ |

---

## 13. Formal Verification

The lending contract's mathematical functions are formally verified using the **Kani Rust Verifier**. The proofs are in `contracts/lending/kani_proofs/math.rs`.

| Proof | Property Verified |
|---|---|
| **INV-MATH-1** | Interest does not overflow for bounded valid inputs ($P \leq 10^5$ XLM, $R \leq 1500$ bps, $D \leq 365$ days) |
| **INV-MATH-2** | Interest is non-negative for positive inputs |
| **INV-MATH-3** | Interest is strictly positive when $P \times R \times D \geq 3,\!650,\!000$ |
| **INV-MATH-4** | Interest is monotonically non-decreasing in principal |
| **INV-MATH-5** | Interest is monotonically non-decreasing in rate |
| **INV-MATH-6** | Interest is monotonically non-decreasing in days |
| **INV-MATH-7** | Liquidation threshold always falls within $[5000,\; 9000]$ |
| **INV-MATH-8** | Platform fee does not exceed interest |
| **INV-MATH-9** | Flash loan fee does not exceed borrowed amount |
| **INV-MATH-10** | Rate switch fee equals $D_{\text{remaining}} \times 50 / 10,\!000$ |
| **INV-MATH-11** | Interest for 1 day at minimum rate is $\geq \lfloor P / 3,\!650,\!000 \rfloor$ |
| **INV-MATH-12** | 365-day interest equals $P \times R / 10,\!000$ |

---

## References

| File | Content |
|---|---|
| `contracts/lending/src/lib.rs` | Core lending contract with interest calculation |
| `contracts/lending/kani_proofs/math.rs` | Formal verification of mathematical invariants |
| `contracts/borrower_reputation/src/lib.rs` | Reputation tiers, oracle credit scoring |
| `lib/dashboard/interest-rates.ts` | TypeScript implementation of rate models |
| `types/contracts.ts` | TypeScript constants and helper functions |
| `sql/05_interest_rate_model.sql` | Database schema for rate model columns |
