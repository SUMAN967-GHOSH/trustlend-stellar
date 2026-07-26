#![cfg(test)]
#![allow(clippy::inconsistent_digit_grouping)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    Address, Env,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn setup() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LendingContract, ());
    let client = LendingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);

    client.initialize(&admin);

    let collateral_asset = Address::generate(&env);
    client.whitelist_asset(&admin, &collateral_asset);

    (env, contract_id, admin, borrower, collateral_asset)
}

// Maximum i128 value — useful for overflow boundary checks.
const I128_MAX: i128 = i128::MAX;

// ─── Normal-case tests ────────────────────────────────────────────────────────

/// Basic happy-path: loan request created with correct totals.
#[test]
fn test_create_loan_request_basic() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // 1 000 XLM at 10 % for 30 days
    // interest = 1_000_0000000 * 1000 * 30 / (10_000 * 365) = 8_219_178 stroops ≈ 0.82 XLM
    let principal: i128 = 1_000_0000000;
    let rate_bps: u32 = 1000;
    let days: u32 = 30;
    let max_loan: i128 = 100_000_0000000;

    let loan_id = client.create_loan_request(&borrower, &principal, &days, &rate_bps, &max_loan, &collateral_asset, &100_000_0000000);
    assert_eq!(loan_id, 1);

    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.amount, principal);
    assert_eq!(loan.duration_days, days);
    assert_eq!(loan.interest_rate_bps, rate_bps);
    assert!(loan.total_due > principal, "total_due must exceed principal");
    assert_eq!(loan.remaining_due, loan.total_due);
    assert_eq!(loan.status, LoanStatus::Pending);
}

/// Verify the interest formula numerically for a known input.
#[test]
fn test_interest_calculation_is_correct() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // 10 000 XLM at 15 % for 365 days → full annual interest = 10_000 * 15 % = 1 500 XLM
    let principal: i128 = 10_000_0000000; // 10 000 XLM in stroops
    let rate_bps: u32 = 1500;
    let days: u32 = 365;
    let expected_interest: i128 = principal * 1500 / 10_000; // = 1 500 XLM

    let loan_id =
        client.create_loan_request(&borrower, &principal, &days, &rate_bps, &(principal * 2), &collateral_asset, &100_000_0000000);
    let loan = client.get_loan(&loan_id);

    let actual_interest = loan.total_due - principal;
    assert_eq!(actual_interest, expected_interest);
}

/// Maximum allowed duration (365 days) must succeed.
#[test]
fn test_create_loan_max_duration_365_days() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let principal: i128 = 500_0000000; // 500 XLM
    let rate_bps: u32 = 800;
    let days: u32 = 365;
    let max_loan: i128 = 1_000_000_0000000;

    let loan_id = client.create_loan_request(&borrower, &principal, &days, &rate_bps, &max_loan, &collateral_asset, &100_000_0000000);
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.duration_days, 365);
    assert!(loan.total_due > principal);
}

/// A loan with duration 1 day (minimum) must succeed.
#[test]
fn test_create_loan_min_duration_1_day() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = client.create_loan_request(
        &borrower,
        &1_000_0000000,
        &1,
        &1500,
        &100_000_0000000,
     &collateral_asset, &100_000_0000000);
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.duration_days, 1);
}

// ─── Overflow-protection tests ────────────────────────────────────────────────

/// A very large but still valid principal (Platinum tier max: 100 000 XLM)
/// at the highest rate (1500 bps) for the longest valid duration (365 days)
/// must NOT overflow — this is the extreme-but-legal boundary.
#[test]
fn test_no_overflow_at_maximum_valid_inputs() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Platinum tier max = 100 000 XLM = 100_000 * 10_000_000 stroops
    let principal: i128 = 100_000_0000000_i128; // 100 000 XLM
    let rate_bps: u32 = 1500; // highest rate (None tier)
    let days: u32 = 365; // maximum duration

    // Verify the multiplication fits in i128 without panicking:
    // principal × rate_bps × days = 100_000_0000000 × 1500 × 365 ≈ 5.475 × 10^19
    // i128::MAX ≈ 1.7 × 10^38 — plenty of headroom.
    let loan_id =
        client.create_loan_request(&borrower, &principal, &days, &rate_bps, &principal, &collateral_asset, &100_000_0000000);
    let loan = client.get_loan(&loan_id);
    assert!(loan.total_due > principal);
}

/// Passing a principal of i128::MAX should panic with an overflow message,
/// not silently wrap around to a wrong value.
#[test]
#[should_panic(expected = "HostError")]
fn test_overflow_panics_with_near_max_principal() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // i128::MAX principal × any rate_bps > 1 will overflow the first checked_mul.
    client.create_loan_request(
        &borrower,
        &I128_MAX,
        &365,
        &1500,
        &I128_MAX,
     &collateral_asset, &100_000_0000000);
}

/// A principal that overflows only at the second multiplication step
/// (principal × rate_bps fits, but × days does not) must still panic cleanly.
#[test]
#[should_panic(expected = "HostError")]
fn test_overflow_panics_at_second_multiplication() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // i128::MAX / 1500 ≈ 2.27 × 10^35 — this value times 1500 fits in i128,
    // but multiplying again by 365 will overflow.
    let boundary_principal: i128 = I128_MAX / 1500;
    client.create_loan_request(
        &borrower,
        &boundary_principal,
        &365,
        &1500,
        &I128_MAX,
     &collateral_asset, &100_000_0000000);
}

// ─── Validation-guard tests ───────────────────────────────────────────────────

/// Duration of 0 must be rejected before any arithmetic happens.
#[test]
#[should_panic(expected = "Duration must be between 1 and 365 days")]
fn test_duration_zero_is_rejected() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    client.create_loan_request(&borrower, &1_000_0000000, &0, &1500, &100_000_0000000, &collateral_asset, &100_000_0000000);
}

/// Duration exceeding 365 days must be rejected.
#[test]
#[should_panic(expected = "Duration must be between 1 and 365 days")]
fn test_duration_366_is_rejected() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    client.create_loan_request(&borrower, &1_000_0000000, &366, &1500, &100_000_0000000, &collateral_asset, &100_000_0000000);
}

/// Zero-amount loan must be rejected.
#[test]
#[should_panic(expected = "Loan amount must be positive")]
fn test_zero_amount_is_rejected() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    client.create_loan_request(&borrower, &0, &30, &1500, &100_000_0000000, &collateral_asset, &100_000_0000000);
}

/// Amount exceeding the reputation-based limit must be rejected.
#[test]
#[should_panic(expected = "Amount exceeds reputation-based limit")]
fn test_amount_over_max_is_rejected() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let max_loan: i128 = 1_000_0000000; // 1 000 XLM
    client.create_loan_request(&borrower, &(max_loan + 1), &30, &1500, &max_loan, &collateral_asset, &100_000_0000000);
}

// ─── due_at overflow test ─────────────────────────────────────────────────────

/// Confirm that due_at is computed correctly without overflow.
/// For 365 days the offset is 365 * 86_400 = 31_536_000 seconds.
#[test]
fn test_due_at_computed_correctly() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    env.ledger().set_timestamp(1_000_000_000_u64);

    let days: u32 = 365;
    let loan_id =
        client.create_loan_request(&borrower, &1_000_0000000, &days, &1500, &100_000_0000000, &collateral_asset, &100_000_0000000);
    let loan = client.get_loan(&loan_id);

    let expected_due_at = 1_000_000_000_u64 + (365_u64 * 86_400);
    assert_eq!(loan.due_at, expected_due_at);
}

// ─── platform_fee test ────────────────────────────────────────────────────────

/// Platform fee must equal exactly 1 % of interest.
#[test]
fn test_platform_fee_is_one_percent_of_interest() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let principal: i128 = 10_000_0000000; // 10 000 XLM
    let rate_bps: u32 = 1500;
    let days: u32 = 365;

    let loan_id =
        client.create_loan_request(&borrower, &principal, &days, &rate_bps, &(principal * 2), &collateral_asset, &100_000_0000000);
    let loan = client.get_loan(&loan_id);

    let interest = loan.total_due - principal;
    assert_eq!(loan.platform_fee, interest / 100);
}

// ─── Dynamic liquidation threshold tests ─────────────────────────────────────

#[test]
fn test_liquidation_threshold_base() {
    let (env, contract_id, _admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Reputation = 0, Volatility = 0
    // Expected: base threshold = 7500
    let threshold = client.calculate_liquidation_threshold(&0, &0);
    assert_eq!(threshold, 7500);
}

#[test]
fn test_liquidation_threshold_reputation_boost() {
    let (env, contract_id, _admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Reputation = 500, Volatility = 0
    // Expected: 7500 + (500 * 1.5) = 7500 + 750 = 8250
    let threshold = client.calculate_liquidation_threshold(&500, &0);
    assert_eq!(threshold, 8250);

    // Reputation = 1000, Volatility = 0
    // Expected: 7500 + (1000 * 1.5) = 7500 + 1500 = 9000 (upper bound cap)
    let threshold = client.calculate_liquidation_threshold(&1000, &0);
    assert_eq!(threshold, 9000);
}

#[test]
fn test_liquidation_threshold_volatility_penalty() {
    let (env, contract_id, _admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Reputation = 0, Volatility = 2000 (20%)
    // Expected: 7500 - (2000 / 2) = 7500 - 1000 = 6500
    let threshold = client.calculate_liquidation_threshold(&0, &2000);
    assert_eq!(threshold, 6500);
}

#[test]
fn test_liquidation_threshold_clamping_bounds() {
    let (env, contract_id, _admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Upper bound clamp: Reputation = 1000, Volatility = 0
    // Calculated: 7500 + 1500 = 9000
    let threshold = client.calculate_liquidation_threshold(&1000, &0);
    assert_eq!(threshold, 9000);

    // Check Reputation = 2000 (abnormal), Volatility = 0
    // Calculated: 7500 + 3000 = 10500 -> Clamped to 9000
    let threshold = client.calculate_liquidation_threshold(&2000, &0);
    assert_eq!(threshold, 9000);

    // Lower bound clamp: Reputation = 0, Volatility = 8000 (80% volatility)
    // Calculated: 7500 - 4000 = 3500 -> Clamped to 5000
    let threshold = client.calculate_liquidation_threshold(&0, &8000);
    assert_eq!(threshold, 5000);
}

#[test]
fn test_liquidation_threshold_extreme_inputs_no_overflow() {
    let (env, contract_id, _admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Verify u32::MAX handles safely and clamps to bounds
    let threshold = client.calculate_liquidation_threshold(&u32::MAX, &u32::MAX);
    assert!((5000..=9000).contains(&threshold));
}

// ─── Pausable / Multi-sig tests ──────────────────────────────────────────────

fn setup_with_multisig() -> (Env, Address, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LendingContract, ());
    let client = LendingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);
    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);

    client.initialize(&admin);
    let collateral_asset = Address::generate(&env);
    client.whitelist_asset(&admin, &collateral_asset);

    let admins = soroban_sdk::vec![&env, admin.clone(), signer1.clone(), signer2.clone()];
    client.setup_multisig(&admin, &admins, &2);

    (env, contract_id, admin, borrower, collateral_asset, signer1, signer2)
}

#[test]
fn test_setup_multisig() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, signer2) = setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    let admins = client.get_multisig_admins();
    assert_eq!(admins.len(), 3);
    assert!(admins.iter().any(|a| a == admin));
    assert!(admins.iter().any(|a| a == signer1));
    assert!(admins.iter().any(|a| a == signer2));
    assert_eq!(client.get_multisig_threshold(), 2);
    assert!(!client.is_paused());
}

#[test]
#[should_panic(expected = "Threshold must be at least 1")]
fn test_setup_multisig_zero_threshold_rejected() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, signer2) = setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    let admins = soroban_sdk::vec![&env, admin.clone(), signer1, signer2];
    client.setup_multisig(&admin, &admins, &0);
}

#[test]
#[should_panic(expected = "Threshold exceeds number of admins")]
fn test_setup_multisig_threshold_too_high_rejected() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, signer2) = setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    let admins = soroban_sdk::vec![&env, signer1, signer2];
    client.setup_multisig(&admin, &admins, &5);
}

#[test]
#[should_panic(expected = "Signer has already authorised pause")]
fn test_duplicate_pause_signer_rejected() {
    let (env, contract_id, admin, _borrower, _collateral_asset, _signer1, _signer2) = setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    // Admin calls pause twice
    client.pause(&admin);
    client.pause(&admin);
}

#[test]
fn test_pause_activates_with_threshold() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, _signer2) = setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    assert!(!client.is_paused());
    assert_eq!(client.get_pause_signer_count(), 0);

    // First signer (below threshold)
    client.pause(&admin);
    assert!(!client.is_paused());
    assert_eq!(client.get_pause_signer_count(), 1);

    // Second signer reaches threshold (2) -> paused
    client.pause(&signer1);
    assert!(client.is_paused());
    assert_eq!(client.get_pause_signer_count(), 0); // reset after activation
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_create_loan_request_blocked_when_paused() {
    let (env, contract_id, admin, borrower, collateral_asset, signer1, _signer2) = setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    // Pause with 2 signers
    client.pause(&admin);
    client.pause(&signer1);

    client.create_loan_request(
        &borrower, &1_000_0000000, &30, &1500, &100_000_0000000, &collateral_asset, &100_000_0000000,
    );
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_approve_loan_blocked_when_paused() {
    let (env, contract_id, admin, borrower, collateral_asset, signer1, _signer2) = setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    // Create a loan while unpaused
    let loan_id = client.create_loan_request(
        &borrower, &1_000_0000000, &30, &1500, &100_000_0000000, &collateral_asset, &100_000_0000000,
    );

    // Pause
    client.pause(&admin);
    client.pause(&signer1);

    let lender = Address::generate(&env);
    client.approve_loan(&lender, &loan_id, &1);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_mark_defaulted_blocked_when_paused() {
    let (env, contract_id, admin, borrower, collateral_asset, signer1, _signer2) = setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    // Create + approve + activate a loan while unpaused
    let lender = Address::generate(&env);
    let loan_id = client.create_loan_request(
        &borrower, &1_000_0000000, &30, &1500, &100_000_0000000, &collateral_asset, &100_000_0000000,
    );
    client.approve_loan(&lender, &loan_id, &1);
    client.activate_loan(&admin, &loan_id);

    // Pause
    client.pause(&admin);
    client.pause(&signer1);

    // Try to mark defaulted
    client.mark_defaulted(&admin, &loan_id);
}

#[test]
fn test_record_payment_allowed_when_paused() {
    let (env, contract_id, admin, borrower, collateral_asset, signer1, _signer2) = setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    let lender = Address::generate(&env);
    let loan_id = client.create_loan_request(
        &borrower, &1_000_0000000, &30, &1500, &100_000_0000000, &collateral_asset, &100_000_0000000,
    );
    client.approve_loan(&lender, &loan_id, &1);
    client.activate_loan(&admin, &loan_id);

    // Pause
    client.pause(&admin);
    client.pause(&signer1);

    // Repayments should still work
    let status = client.record_payment(&admin, &loan_id, &500_0000000);
    assert_eq!(status, LoanStatus::Active);
}

#[test]
#[should_panic(expected = "Contract is not paused")]
fn test_unpause_when_not_paused_rejected() {
    let (env, contract_id, admin, _borrower, _collateral_asset, _signer1, _signer2) = setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    client.unpause(&admin);
}

#[test]
fn test_unpause_deactivates_with_threshold() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, _signer2) = setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    // Pause first
    client.pause(&admin);
    client.pause(&signer1);
    assert!(client.is_paused());

    // Unpause with 2 signers
    client.unpause(&admin);
    assert!(client.is_paused()); // still paused (1 < threshold 2)
    client.unpause(&signer1);
    assert!(!client.is_paused());
}

#[test]
#[should_panic(expected = "Signer has already authorised unpause")]
fn test_duplicate_unpause_signer_rejected() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, _signer2) = setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    // Pause first
    client.pause(&admin);
    client.pause(&signer1);

    // Try to unpause with same signer twice
    client.unpause(&admin);
    client.unpause(&admin);
}

#[test]
#[should_panic(expected = "Unauthorised: caller is not a multisig admin")]
fn test_non_admin_cannot_pause() {
    let (env, contract_id, _admin, _borrower, _collateral_asset, _signer1, _signer2) = setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    let random = Address::generate(&env);
    client.pause(&random);
}

#[test]
#[should_panic(expected = "Multisig not configured")]
fn test_pause_without_multisig_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LendingContract, ());
    let client = LendingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize(&admin);

    // No setup_multisig called
    client.pause(&admin);
}

#[test]
fn test_resume_operations_after_unpause() {
    let (env, contract_id, admin, borrower, collateral_asset, signer1, signer2) = setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    // Pause
    client.pause(&admin);
    client.pause(&signer1);
    assert!(client.is_paused());

    // Unpause
    client.unpause(&admin);
    client.unpause(&signer2);
    assert!(!client.is_paused());

    // Create a loan again — should work
    let loan_id = client.create_loan_request(
        &borrower, &1_000_0000000, &30, &1500, &100_000_0000000, &collateral_asset, &100_000_0000000,
    );
    assert_eq!(loan_id, 1);
}

#[test]
fn test_multisig_admin_can_still_use_admin_functions_when_paused() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, _signer2) = setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    // Pause
    client.pause(&admin);
    client.pause(&signer1);
    assert!(client.is_paused());

    // Admin should still be able to whitelist assets
    let new_asset = Address::generate(&env);
    client.whitelist_asset(&admin, &new_asset);
    assert!(client.is_asset_whitelisted(&new_asset));
}

#[test]
fn test_pause_unpause_events_emitted() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, _signer2) = setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    // Pause
    client.pause(&admin);
    client.pause(&signer1);

    // One "paused" event is emitted when the threshold is met
    let events = env.events().all();
    assert!(!events.is_empty());
}
