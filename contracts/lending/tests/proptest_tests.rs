//! Property-based tests for the TrustLend lending contract.
//!
//! These tests use the `proptest` crate to fuzz-test mathematical and
//! accounting invariants with randomly generated inputs. Unlike Kani
//! proofs (which exhaustively check bounded input spaces), proptest
//! explores the input space stochastically and can discover edge cases
//! that manual test cases miss.
//!
//! # Running
//!
//! ```bash
//! cargo test -p lending --test proptest_tests
//! ```

use proptest::prelude::*;

/// Mirrors `LendingContract::calculate_interest`.
/// `interest = principal × rate_bps × days / (10_000 × 365)`
fn calculate_interest(principal: i128, rate_bps: u32, days: u32) -> Option<i128> {
    let numerator = (principal as i128)
        .checked_mul(rate_bps as i128)?
        .checked_mul(days as i128)?;
    Some(numerator / (10_000_i128 * 365))
}

/// Mirrors `LendingContract::calculate_liquidation_threshold`.
fn calculate_liquidation_threshold(score: u32, volatility: u32) -> u32 {
    let base: u32 = 7500;
    let bonus = (score as u64 * 15 / 10) as u32;
    let penalty = volatility / 2;
    base.saturating_add(bonus)
        .saturating_sub(penalty)
        .clamp(5000, 9000)
}

/// Platform fee: `interest × fee_bps / 10_000`.
fn calculate_platform_fee(interest: i128, fee_bps: u32) -> Option<i128> {
    (interest as i128)
        .checked_mul(fee_bps as i128)?
        .checked_div(10_000)
}

/// Flash loan fee: `amount × fee_bps / 10_000`.
fn calculate_flash_loan_fee(amount: i128, fee_bps: u32) -> Option<i128> {
    (amount as i128)
        .checked_mul(fee_bps as i128)?
        .checked_div(10_000)
}

/// Rate switch fee: `remaining_due × 50 / 10_000`.
fn calculate_rate_switch_fee(remaining_due: i128) -> Option<i128> {
    (remaining_due as i128)
        .checked_mul(50_i128)?
        .checked_div(10_000)
}

// ─── Strategies ──────────────────────────────────────────────────────────────

/// Valid principal: 1 to 100_000 XLM in stroops.
fn arb_principal() -> impl Strategy<Value = i128> {
    1i128..=100_000_000_000i128
}

/// Valid interest rate in basis points: 1 to 1500 (0.01% to 15%).
fn arb_rate_bps() -> impl Strategy<Value = u32> {
    1u32..=1500u32
}

/// Valid duration in days: 1 to 365.
fn arb_days() -> impl Strategy<Value = u32> {
    1u32..=365u32
}

/// Valid platform fee in basis points: 0 to 1000.
fn arb_platform_fee_bps() -> impl Strategy<Value = u32> {
    0u32..=1000u32
}

/// Valid flash loan fee in basis points: 0 to 500.
fn arb_flash_loan_fee_bps() -> impl Strategy<Value = u32> {
    0u32..=500u32
}

// ─── Interest Calculation Tests ──────────────────────────────────────────────

proptest! {
    #[test]
    fn prop_interest_non_negative(
        principal in arb_principal(),
        rate_bps in arb_rate_bps(),
        days in arb_days(),
    ) {
        let interest = calculate_interest(principal, rate_bps, days).unwrap();
        prop_assert!(interest >= 0, "interest={} must be >= 0", interest);
    }

    #[test]
    fn prop_interest_positive(
        principal in 3_650_000i128..=100_000_000_000i128,
        rate_bps in arb_rate_bps(),
        days in arb_days(),
    ) {
        // Constrained so that principal * rate_bps * days >= 3_650_000,
        // guaranteeing interest > 0 under integer division.
        let interest = calculate_interest(principal, rate_bps, days).unwrap();
        prop_assert!(interest > 0, "interest must be > 0 for sufficiently large inputs");
    }

    #[test]
    fn prop_interest_monotonic_principal(
        p1 in arb_principal(),
        p2 in arb_principal(),
        rate_bps in arb_rate_bps(),
        days in arb_days(),
    ) {
        let (lo, hi) = if p1 <= p2 { (p1, p2) } else { (p2, p1) };
        let i1 = calculate_interest(lo, rate_bps, days).unwrap();
        let i2 = calculate_interest(hi, rate_bps, days).unwrap();
        prop_assert!(i1 <= i2, "interest({})={} > interest({})={}", lo, i1, hi, i2);
    }

    #[test]
    fn prop_interest_monotonic_rate(
        principal in arb_principal(),
        r1 in arb_rate_bps(),
        r2 in arb_rate_bps(),
        days in arb_days(),
    ) {
        let (lo, hi) = if r1 <= r2 { (r1, r2) } else { (r2, r1) };
        let i1 = calculate_interest(principal, lo, days).unwrap();
        let i2 = calculate_interest(principal, hi, days).unwrap();
        prop_assert!(i1 <= i2, "interest(r={})={} > interest(r={})={}", lo, i1, hi, i2);
    }

    #[test]
    fn prop_interest_monotonic_days(
        principal in arb_principal(),
        rate_bps in arb_rate_bps(),
        d1 in arb_days(),
        d2 in arb_days(),
    ) {
        let (lo, hi) = if d1 <= d2 { (d1, d2) } else { (d2, d1) };
        let i1 = calculate_interest(principal, rate_bps, lo).unwrap();
        let i2 = calculate_interest(principal, rate_bps, hi).unwrap();
        prop_assert!(i1 <= i2, "interest(d={})={} > interest(d={})={}", lo, i1, hi, i2);
    }

    #[test]
    fn prop_annual_interest_identity(
        principal in arb_principal(),
        rate_bps in arb_rate_bps(),
    ) {
        let interest_365 = calculate_interest(principal, rate_bps, 365).unwrap();
        let expected = principal * (rate_bps as i128) / 10_000;
        prop_assert_eq!(interest_365, expected);
    }

    #[test]
    fn prop_interest_no_overflow(
        principal in arb_principal(),
        rate_bps in arb_rate_bps(),
        days in arb_days(),
    ) {
        let _ = calculate_interest(principal, rate_bps, days).unwrap();
    }
}

// ─── Accounting Tests ────────────────────────────────────────────────────────

proptest! {
    #[test]
    fn prop_total_due_ge_principal(
        principal in arb_principal(),
        rate_bps in arb_rate_bps(),
        days in arb_days(),
    ) {
        let interest = calculate_interest(principal, rate_bps, days).unwrap();
        let total_due = principal + interest;
        prop_assert!(total_due >= principal, "total_due={} < principal={}", total_due, principal);
    }

    #[test]
    fn prop_platform_fee_le_interest(
        interest in 0i128..=100_000_000_000i128,
        fee_bps in arb_platform_fee_bps(),
    ) {
        if let Some(fee) = calculate_platform_fee(interest, fee_bps) {
            prop_assert!(fee <= interest, "fee={} > interest={}", fee, interest);
        }
    }

    #[test]
    fn prop_payment_never_negative(
        principal in arb_principal(),
        rate_bps in arb_rate_bps(),
        days in arb_days(),
        payment in 1i128..=100_000_000_000i128,
    ) {
        let interest = calculate_interest(principal, rate_bps, days).unwrap();
        let total_due = principal + interest;
        let remaining = if payment >= total_due { 0 } else { total_due - payment };
        prop_assert!(remaining >= 0, "remaining={} is negative", remaining);
    }

    #[test]
    fn prop_full_payment_zeroes(
        principal in arb_principal(),
        rate_bps in arb_rate_bps(),
        days in arb_days(),
    ) {
        let interest = calculate_interest(principal, rate_bps, days).unwrap();
        let total_due = principal + interest;
        let payment = total_due + 1;
        let remaining = if payment >= total_due { 0 } else { total_due - payment };
        prop_assert_eq!(remaining, 0i128);
    }
}

// ─── Liquidation Threshold Tests ─────────────────────────────────────────────

proptest! {
    #[test]
    fn prop_liquidation_threshold_bounds(
        score in 0u32..=2000u32,
        volatility in 0u32..=10000u32,
    ) {
        let threshold = calculate_liquidation_threshold(score, volatility);
        prop_assert!(threshold >= 5000, "threshold={} < 5000", threshold);
        prop_assert!(threshold <= 9000, "threshold={} > 9000", threshold);
    }

    #[test]
    fn prop_liquidation_threshold_monotonic_score(
        s1 in 0u32..=1000u32,
        s2 in 0u32..=1000u32,
        volatility in 0u32..=5000u32,
    ) {
        let (lo, hi) = if s1 <= s2 { (s1, s2) } else { (s2, s1) };
        let t1 = calculate_liquidation_threshold(lo, volatility);
        let t2 = calculate_liquidation_threshold(hi, volatility);
        prop_assert!(t1 <= t2, "t(low_score)={} > t(high_score)={}", t1, t2);
    }
}

// ─── Flash Loan Fee Tests ────────────────────────────────────────────────────

proptest! {
    #[test]
    fn prop_flash_fee_le_amount(
        amount in 1i128..=100_000_000_000i128,
        fee_bps in arb_flash_loan_fee_bps(),
    ) {
        if let Some(fee) = calculate_flash_loan_fee(amount, fee_bps) {
            prop_assert!(fee <= amount, "fee={} > amount={}", fee, amount);
        }
    }

    #[test]
    fn prop_flash_fee_monotonic_amount(
        a1 in 1i128..=100_000_000_000i128,
        a2 in 1i128..=100_000_000_000i128,
        fee_bps in arb_flash_loan_fee_bps(),
    ) {
        let (lo, hi) = if a1 <= a2 { (a1, a2) } else { (a2, a1) };
        let f1 = calculate_flash_loan_fee(lo, fee_bps);
        let f2 = calculate_flash_loan_fee(hi, fee_bps);
        if let (Some(fee1), Some(fee2)) = (f1, f2) {
            prop_assert!(fee1 <= fee2, "fee(a={})={} > fee(a={})={}", lo, fee1, hi, fee2);
        }
    }

    #[test]
    fn prop_flash_fee_formula(
        amount in 1i128..=100_000_000_000i128,
        fee_bps in arb_flash_loan_fee_bps(),
    ) {
        let fee = calculate_flash_loan_fee(amount, fee_bps).unwrap();
        let expected = amount * (fee_bps as i128) / 10_000;
        prop_assert_eq!(fee, expected);
    }
}

// ─── Rate Switch Fee Tests ───────────────────────────────────────────────────

proptest! {
    #[test]
    fn prop_rate_switch_fee_nonnegative(
        remaining in 0i128..=100_000_000_000i128,
    ) {
        let fee = calculate_rate_switch_fee(remaining).unwrap();
        prop_assert!(fee >= 0, "rate switch fee={} is negative", fee);
    }

    #[test]
    fn prop_rate_switch_fee_at_most_half_percent(
        remaining in 0i128..=100_000_000_000i128,
    ) {
        let fee = calculate_rate_switch_fee(remaining).unwrap();
        prop_assert!(
            fee <= remaining / 200 + 1,
            "rate switch fee={} exceeds ~0.5% of remaining={}",
            fee,
            remaining
        );
    }

    #[test]
    fn prop_rate_switch_increases_debt(
        remaining in 1i128..=100_000_000_000i128,
    ) {
        let fee = calculate_rate_switch_fee(remaining).unwrap();
        let new_remaining = remaining + fee;
        prop_assert!(
            new_remaining >= remaining,
            "new_remaining={} < old_remaining={}",
            new_remaining,
            remaining
        );
    }
}
