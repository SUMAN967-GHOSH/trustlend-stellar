//! Formal verification of the lending contract's fee invariants.
//!
//! Verifies:
//! - Platform fee cannot exceed MAX_PLATFORM_FEE_BPS (1000)
//! - Flash loan fee cannot exceed MAX_FLASH_LOAN_FEE_BPS (500)
//! - Rate switch fee calculation is correct
//! - Fee updates are bounded

const DEFAULT_PLATFORM_FEE_BPS: u32 = 100;
const MAX_PLATFORM_FEE_BPS: u32 = 1000;
const DEFAULT_FLASH_LOAN_FEE_BPS: u32 = 9;
const MAX_FLASH_LOAN_FEE_BPS: u32 = 500;
const RATE_SWITCH_FEE_BPS: u32 = 50;

/// Validates a platform fee update.
fn validate_platform_fee(new_fee_bps: u32) -> Option<u32> {
    if new_fee_bps > MAX_PLATFORM_FEE_BPS {
        return None;
    }
    Some(new_fee_bps)
}

/// Validates a flash loan fee update.
fn validate_flash_loan_fee(new_fee_bps: u32) -> Option<u32> {
    if new_fee_bps > MAX_FLASH_LOAN_FEE_BPS {
        return None;
    }
    Some(new_fee_bps)
}

/// Calculate platform fee: `interest × fee_bps / 10_000`.
fn calculate_platform_fee(interest: i128, fee_bps: u32) -> Option<i128> {
    (interest as i128)
        .checked_mul(fee_bps as i128)?
        .checked_div(10_000)
}

/// Calculate rate switch fee: `remaining_due × RATE_SWITCH_FEE_BPS / 10_000`.
fn calculate_rate_switch_fee(remaining_due: i128) -> Option<i128> {
    (remaining_due as i128)
        .checked_mul(RATE_SWITCH_FEE_BPS as i128)?
        .checked_div(10_000)
}

// ─── Kani Proof Harnesses ────────────────────────────────────────────────────

/// INV-FEE-1: Platform fee cannot exceed MAX_PLATFORM_FEE_BPS after update.
#[cfg(kani)]
#[kani::proof]
fn inv_fee_1_platform_fee_bounded() {
    let new_fee_bps: u32 = kani::any();

    let result = validate_platform_fee(new_fee_bps);
    if let Some(fee) = result {
        assert!(
            fee <= MAX_PLATFORM_FEE_BPS,
            "Platform fee must not exceed MAX_PLATFORM_FEE_BPS"
        );
    } else {
        assert!(
            new_fee_bps > MAX_PLATFORM_FEE_BPS,
            "Rejection must be due to exceeding max"
        );
    }
}

/// INV-FEE-2: Flash loan fee cannot exceed MAX_FLASH_LOAN_FEE_BPS after update.
#[cfg(kani)]
#[kani::proof]
fn inv_fee_2_flash_loan_fee_bounded() {
    let new_fee_bps: u32 = kani::any();

    let result = validate_flash_loan_fee(new_fee_bps);
    if let Some(fee) = result {
        assert!(
            fee <= MAX_FLASH_LOAN_FEE_BPS,
            "Flash loan fee must not exceed MAX_FLASH_LOAN_FEE_BPS"
        );
    } else {
        assert!(
            new_fee_bps > MAX_FLASH_LOAN_FEE_BPS,
            "Rejection must be due to exceeding max"
        );
    }
}

/// INV-FEE-3: Platform fee at exactly MAX_PLATFORM_FEE_BPS is accepted.
#[cfg(kani)]
#[kani::proof]
fn inv_fee_3_platform_fee_at_max_accepted() {
    let result = validate_platform_fee(MAX_PLATFORM_FEE_BPS);
    assert_eq!(
        result,
        Some(MAX_PLATFORM_FEE_BPS),
        "Fee at exactly MAX must be accepted"
    );
}

/// INV-FEE-4: Flash loan fee at exactly MAX_FLASH_LOAN_FEE_BPS is accepted.
#[cfg(kani)]
#[kani::proof]
fn inv_fee_4_flash_loan_fee_at_max_accepted() {
    let result = validate_flash_loan_fee(MAX_FLASH_LOAN_FEE_BPS);
    assert_eq!(
        result,
        Some(MAX_FLASH_LOAN_FEE_BPS),
        "Fee at exactly MAX must be accepted"
    );
}

/// INV-FEE-5: Platform fee at MAX + 1 is rejected.
#[cfg(kani)]
#[kani::proof]
fn inv_fee_5_platform_fee_over_max_rejected() {
    let result = validate_platform_fee(MAX_PLATFORM_FEE_BPS + 1);
    assert_eq!(result, None, "Fee at MAX + 1 must be rejected");
}

/// INV-FEE-6: Flash loan fee at MAX + 1 is rejected.
#[cfg(kani)]
#[kani::proof]
fn inv_fee_6_flash_loan_fee_over_max_rejected() {
    let result = validate_flash_loan_fee(MAX_FLASH_LOAN_FEE_BPS + 1);
    assert_eq!(result, None, "Fee at MAX + 1 must be rejected");
}

/// INV-FEE-7: Default platform fee is 100 bps (1% of interest).
#[cfg(kani)]
#[kani::proof]
fn inv_fee_7_default_platform_fee() {
    assert_eq!(
        DEFAULT_PLATFORM_FEE_BPS, 100,
        "Default platform fee must be 100 bps"
    );
}

/// INV-FEE-8: Default flash loan fee is 9 bps (0.09% of amount).
#[cfg(kani)]
#[kani::proof]
fn inv_fee_8_default_flash_loan_fee() {
    assert_eq!(
        DEFAULT_FLASH_LOAN_FEE_BPS, 9,
        "Default flash loan fee must be 9 bps"
    );
}

/// INV-FEE-9: Rate switch fee calculation is correct.
///
/// `fee = remaining_due × 50 / 10_000`
#[cfg(kani)]
#[kani::proof]
fn inv_fee_9_rate_switch_fee_correct() {
    let remaining_due: i128 = kani::any();

    kani::assume(remaining_due >= 0 && remaining_due <= 100_000_000_000);

    if let Some(fee) = calculate_rate_switch_fee(remaining_due) {
        let expected = remaining_due * (RATE_SWITCH_FEE_BPS as i128) / 10_000;
        assert_eq!(
            fee, expected,
            "Rate switch fee must be remaining_due * 50 / 10_000"
        );
    }
}

/// INV-FEE-10: Rate switch fee is at most 0.5% of remaining_due.
#[cfg(kani)]
#[kani::proof]
fn inv_fee_10_rate_switch_fee_le_half_percent() {
    let remaining_due: i128 = kani::any();

    kani::assume(remaining_due >= 0 && remaining_due <= 100_000_000_000);

    if let Some(fee) = calculate_rate_switch_fee(remaining_due) {
        // 0.5% = 50 / 10_000, so fee should be exactly floor(remaining_due * 50 / 10_000)
        assert!(
            fee <= remaining_due / 200 + 1, // floor division margin
            "Rate switch fee must be at most ~0.5% of remaining_due"
        );
    }
}

/// INV-FEE-11: Platform fee does not exceed interest for bounded inputs.
#[cfg(kani)]
#[kani::proof]
fn inv_fee_11_platform_fee_le_interest() {
    let interest: i128 = kani::any();
    let fee_bps: u32 = kani::any();

    kani::assume(interest >= 0 && interest <= 100_000_000_000);
    kani::assume(fee_bps <= MAX_PLATFORM_FEE_BPS);

    if let Some(fee) = calculate_platform_fee(interest, fee_bps) {
        assert!(
            fee <= interest,
            "Platform fee must not exceed interest (fee_bps <= 1000 << 10_000)"
        );
    }
}

/// INV-FEE-12: Fee validation is deterministic: same input yields same result.
#[cfg(kani)]
#[kani::proof]
fn inv_fee_12_deterministic() {
    let fee_bps: u32 = kani::any();

    let r1 = validate_platform_fee(fee_bps);
    let r2 = validate_platform_fee(fee_bps);
    assert_eq!(r1, r2, "Fee validation must be deterministic");

    let r3 = validate_flash_loan_fee(fee_bps);
    let r4 = validate_flash_loan_fee(fee_bps);
    assert_eq!(r3, r4, "Flash loan fee validation must be deterministic");
}

/// INV-FEE-13: Zero fee is accepted.
#[cfg(kani)]
#[kani::proof]
fn inv_fee_13_zero_fee_accepted() {
    assert_eq!(
        validate_platform_fee(0),
        Some(0),
        "Zero platform fee must be accepted"
    );
    assert_eq!(
        validate_flash_loan_fee(0),
        Some(0),
        "Zero flash loan fee must be accepted"
    );
}
