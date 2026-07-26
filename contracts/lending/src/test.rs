#![cfg(test)]
#![allow(clippy::inconsistent_digit_grouping)]

extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    token, Address, Bytes, Env,
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
    // Multisig-gated functions are exercised for real in `multisig_admin`'s
    // integration tests; here `admin` stands in as its own "multisig" so the
    // rest of this suite can focus on loan-lifecycle behaviour.
    client.set_multisig_admin(&admin, &admin);

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

    let loan_id = client.create_loan_request(&borrower, &principal, &days, &rate_bps, &max_loan, &collateral_asset, &100_000_0000000, &InterestRateModel::Fixed);
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
        client.create_loan_request(&borrower, &principal, &days, &rate_bps, &(principal * 2), &collateral_asset, &100_000_0000000, &InterestRateModel::Fixed);
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

    let loan_id = client.create_loan_request(&borrower, &principal, &days, &rate_bps, &max_loan, &collateral_asset, &100_000_0000000, &InterestRateModel::Fixed);
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
     &collateral_asset, &100_000_0000000, &InterestRateModel::Fixed);
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
        client.create_loan_request(&borrower, &principal, &days, &rate_bps, &principal, &collateral_asset, &100_000_0000000, &InterestRateModel::Fixed);
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
     &collateral_asset, &100_000_0000000, &InterestRateModel::Fixed);
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
     &collateral_asset, &100_000_0000000, &InterestRateModel::Fixed);
}

// ─── Validation-guard tests ───────────────────────────────────────────────────

/// Duration of 0 must be rejected before any arithmetic happens.
#[test]
#[should_panic(expected = "Duration must be between 1 and 365 days")]
fn test_duration_zero_is_rejected() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    client.create_loan_request(&borrower, &1_000_0000000, &0, &1500, &100_000_0000000, &collateral_asset, &100_000_0000000, &InterestRateModel::Fixed);
}

/// Duration exceeding 365 days must be rejected.
#[test]
#[should_panic(expected = "Duration must be between 1 and 365 days")]
fn test_duration_366_is_rejected() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    client.create_loan_request(&borrower, &1_000_0000000, &366, &1500, &100_000_0000000, &collateral_asset, &100_000_0000000, &InterestRateModel::Fixed);
}

/// Zero-amount loan must be rejected.
#[test]
#[should_panic(expected = "Loan amount must be positive")]
fn test_zero_amount_is_rejected() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    client.create_loan_request(&borrower, &0, &30, &1500, &100_000_0000000, &collateral_asset, &100_000_0000000, &InterestRateModel::Fixed);
}

/// Amount exceeding the reputation-based limit must be rejected.
#[test]
#[should_panic(expected = "Amount exceeds reputation-based limit")]
fn test_amount_over_max_is_rejected() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let max_loan: i128 = 1_000_0000000; // 1 000 XLM
    client.create_loan_request(&borrower, &(max_loan + 1), &30, &1500, &max_loan, &collateral_asset, &100_000_0000000, &InterestRateModel::Fixed);
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
        client.create_loan_request(&borrower, &1_000_0000000, &days, &1500, &100_000_0000000, &collateral_asset, &100_000_0000000, &InterestRateModel::Fixed);
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
        client.create_loan_request(&borrower, &principal, &days, &rate_bps, &(principal * 2), &collateral_asset, &100_000_0000000, &InterestRateModel::Fixed);
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

// ─── Flash loan tests ───────────────────────────────────────────────────────────

// ── Mock receiver contracts ─────────────────────────────────────────────────────
// Each implements the `FlashLoanReceiver` callback interface that any protocol
// wanting to consume a TrustLend flash loan must expose. Each lives in its own
// module: `#[contractimpl]` generates module-level symbols keyed by method name,
// which collide if two `impl FlashLoanReceiver for ...` blocks share a module.

/// Repays the loan in full (amount + fee). Represents a well-behaved
/// arbitrageur/re-leveraging strategy that turned a profit covering the fee.
mod good_receiver {
    use super::*;

    #[contract]
    pub struct GoodReceiver;

    #[contractimpl]
    impl FlashLoanReceiver for GoodReceiver {
        fn execute_operation(
            env: Env,
            token: Address,
            amount: i128,
            fee: i128,
            initiator: Address,
            _params: Bytes,
        ) {
            let token_client = token::Client::new(&env, &token);
            token_client.transfer(&env.current_contract_address(), &initiator, &(amount + fee));
        }
    }
}
use good_receiver::GoodReceiver;

/// Never repays anything — simulates a malicious or buggy receiver.
mod stingy_receiver {
    use super::*;

    #[contract]
    pub struct StingyReceiver;

    #[contractimpl]
    impl FlashLoanReceiver for StingyReceiver {
        fn execute_operation(
            _env: Env,
            _token: Address,
            _amount: i128,
            _fee: i128,
            _initiator: Address,
            _params: Bytes,
        ) {
            // Intentionally does nothing — keeps the borrowed funds.
        }
    }
}
use stingy_receiver::StingyReceiver;

/// Repays only the principal, not the fee.
mod partial_receiver {
    use super::*;

    #[contract]
    pub struct PartialReceiver;

    #[contractimpl]
    impl FlashLoanReceiver for PartialReceiver {
        fn execute_operation(
            env: Env,
            token: Address,
            amount: i128,
            _fee: i128,
            initiator: Address,
            _params: Bytes,
        ) {
            let token_client = token::Client::new(&env, &token);
            token_client.transfer(&env.current_contract_address(), &initiator, &amount);
        }
    }
}
use partial_receiver::PartialReceiver;

/// Repays more than required — should still succeed (>= check, not ==).
mod generous_receiver {
    use super::*;

    #[contract]
    pub struct GenerousReceiver;

    #[contractimpl]
    impl FlashLoanReceiver for GenerousReceiver {
        fn execute_operation(
            env: Env,
            token: Address,
            amount: i128,
            fee: i128,
            initiator: Address,
            _params: Bytes,
        ) {
            let token_client = token::Client::new(&env, &token);
            token_client.transfer(
                &env.current_contract_address(),
                &initiator,
                &(amount + fee + 1_000),
            );
        }
    }
}
use generous_receiver::GenerousReceiver;

// ── Helpers ──────────────────────────────────────────────────────────────────────

/// Sets up a lending contract + a SEP-41 test token, with `pool_liquidity`
/// minted directly into the pool (the lending contract's own balance).
fn setup_flash(pool_liquidity: i128) -> (Env, Address, Address, token::Client<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(LendingContract, ());
    let client_addr = contract_id.clone();
    let client = LendingContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    client.set_multisig_admin(&admin, &admin);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_id = sac.address();
    let asset_client = token::StellarAssetClient::new(&env, &token_id);
    asset_client.mint(&client_addr, &pool_liquidity);

    let token_client = token::Client::new(&env, &token_id);
    (env, contract_id, token_id, token_client)
}

/// Pre-funds `receiver` with `extra` tokens (its own capital / "profit") so it
/// can cover the flash-loan fee on top of the amount it borrows.
fn fund_receiver(env: &Env, token_id: &Address, receiver: &Address, extra: i128) {
    let asset_client = token::StellarAssetClient::new(env, token_id);
    asset_client.mint(receiver, &extra);
}

// ── Success cases ─────────────────────────────────────────────────────────────────

#[test]
fn test_flash_loan_success_full_repayment() {
    let pool_liquidity: i128 = 1_000_000_0000000; // 1,000,000 XLM
    let (env, contract_id, token_id, token_client) = setup_flash(pool_liquidity);
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(GoodReceiver, ());
    let borrow_amount: i128 = 100_000_0000000; // 100,000 XLM

    // Default fee = 9 bps = 0.09%.
    let expected_fee = borrow_amount * 9 / 10_000;
    fund_receiver(&env, &token_id, &receiver_id, expected_fee);

    client.flash_loan(&receiver_id, &token_id, &borrow_amount, &Bytes::new(&env));

    // Pool ends up with its original liquidity PLUS the fee.
    assert_eq!(token_client.balance(&contract_id), pool_liquidity + expected_fee);
    // Receiver ends with zero — it borrowed, used, and repaid everything.
    assert_eq!(token_client.balance(&receiver_id), 0);
}

#[test]
fn test_flash_loan_accepts_overpayment() {
    let pool_liquidity: i128 = 500_000_0000000;
    let (env, contract_id, token_id, token_client) = setup_flash(pool_liquidity);
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(GenerousReceiver, ());
    let borrow_amount: i128 = 10_000_0000000;
    let expected_fee = borrow_amount * 9 / 10_000;
    fund_receiver(&env, &token_id, &receiver_id, expected_fee + 1_000);

    client.flash_loan(&receiver_id, &token_id, &borrow_amount, &Bytes::new(&env));

    // Pool gained the fee AND the extra 1_000 stroops the receiver overpaid.
    assert_eq!(token_client.balance(&contract_id), pool_liquidity + expected_fee + 1_000);
}

#[test]
fn test_flash_loan_emits_correct_fee_for_custom_bps() {
    let pool_liquidity: i128 = 1_000_000_0000000;
    let (env, contract_id, token_id, token_client) = setup_flash(pool_liquidity);
    let client = LendingContractClient::new(&env, &contract_id);
    let admin = client.get_admin();

    client.set_flash_loan_fee_bps(&admin, &50); // 0.50 %
    assert_eq!(client.get_flash_loan_fee_bps(), 50);

    let receiver_id = env.register(GoodReceiver, ());
    let borrow_amount: i128 = 100_000_0000000;
    let expected_fee = borrow_amount * 50 / 10_000;
    fund_receiver(&env, &token_id, &receiver_id, expected_fee);

    client.flash_loan(&receiver_id, &token_id, &borrow_amount, &Bytes::new(&env));
    assert_eq!(token_client.balance(&contract_id), pool_liquidity + expected_fee);
}

// ── Failure / rollback cases ────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Flash loan not repaid")]
fn test_flash_loan_reverts_when_receiver_repays_nothing() {
    let pool_liquidity: i128 = 1_000_000_0000000;
    let (env, contract_id, token_id, _token_client) = setup_flash(pool_liquidity);
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(StingyReceiver, ());
    let borrow_amount: i128 = 100_000_0000000;

    client.flash_loan(&receiver_id, &token_id, &borrow_amount, &Bytes::new(&env));
}

#[test]
#[should_panic(expected = "Flash loan not repaid")]
fn test_flash_loan_reverts_on_partial_repayment() {
    let pool_liquidity: i128 = 1_000_000_0000000;
    let (env, contract_id, token_id, _token_client) = setup_flash(pool_liquidity);
    let client = LendingContractClient::new(&env, &contract_id);

    // Repays principal but not the fee — must still be rejected.
    let receiver_id = env.register(PartialReceiver, ());
    let borrow_amount: i128 = 100_000_0000000;

    client.flash_loan(&receiver_id, &token_id, &borrow_amount, &Bytes::new(&env));
}

#[test]
fn test_failed_flash_loan_rolls_back_pool_balance() {
    let pool_liquidity: i128 = 1_000_000_0000000;
    let (env, contract_id, token_id, token_client) = setup_flash(pool_liquidity);
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(StingyReceiver, ());
    let borrow_amount: i128 = 100_000_0000000;

    // Catch the panic without poisoning the test — asserts the transaction
    // (including the initial disbursement) was fully rolled back.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.flash_loan(&receiver_id, &token_id, &borrow_amount, &Bytes::new(&env));
    }));
    assert!(result.is_err(), "flash loan should have panicked");

    // Pool balance is untouched — the disbursed `amount` was rolled back too.
    assert_eq!(token_client.balance(&contract_id), pool_liquidity);
    assert_eq!(token_client.balance(&receiver_id), 0);
}

#[test]
fn test_pool_usable_again_immediately_after_a_failed_flash_loan() {
    let pool_liquidity: i128 = 1_000_000_0000000;
    let (env, contract_id, token_id, token_client) = setup_flash(pool_liquidity);
    let client = LendingContractClient::new(&env, &contract_id);
    let borrow_amount: i128 = 100_000_0000000;

    // 1) A failing attempt against a StingyReceiver...
    let bad_receiver = env.register(StingyReceiver, ());
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.flash_loan(&bad_receiver, &token_id, &borrow_amount, &Bytes::new(&env));
    }));

    // 2) ...must not leave the pool short for a subsequent, well-behaved borrower.
    let good_receiver = env.register(GoodReceiver, ());
    let expected_fee = borrow_amount * 9 / 10_000;
    fund_receiver(&env, &token_id, &good_receiver, expected_fee);

    client.flash_loan(&good_receiver, &token_id, &borrow_amount, &Bytes::new(&env));
    assert_eq!(token_client.balance(&contract_id), pool_liquidity + expected_fee);
}

#[test]
#[should_panic(expected = "Insufficient pool liquidity")]
fn test_flash_loan_rejects_amount_over_pool_liquidity() {
    let pool_liquidity: i128 = 1_000_0000000; // only 1,000 XLM in the pool
    let (env, contract_id, token_id, _token_client) = setup_flash(pool_liquidity);
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(GoodReceiver, ());
    // Ask for far more than the pool holds.
    client.flash_loan(&receiver_id, &token_id, &(pool_liquidity * 2), &Bytes::new(&env));
}

#[test]
#[should_panic(expected = "must be positive")]
fn test_flash_loan_rejects_zero_amount() {
    let pool_liquidity: i128 = 1_000_000_0000000;
    let (env, contract_id, token_id, _token_client) = setup_flash(pool_liquidity);
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(GoodReceiver, ());
    client.flash_loan(&receiver_id, &token_id, &0, &Bytes::new(&env));
}

#[test]
#[should_panic(expected = "must be positive")]
fn test_flash_loan_rejects_negative_amount() {
    let pool_liquidity: i128 = 1_000_000_0000000;
    let (env, contract_id, token_id, _token_client) = setup_flash(pool_liquidity);
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(GoodReceiver, ());
    client.flash_loan(&receiver_id, &token_id, &-1, &Bytes::new(&env));
}

#[test]
#[should_panic(expected = "Unauthorised")]
fn test_only_admin_can_change_flash_loan_fee() {
    let pool_liquidity: i128 = 1_000_000_0000000;
    let (env, contract_id, token_id, _token_client) = setup_flash(pool_liquidity);
    let client = LendingContractClient::new(&env, &contract_id);
    let _ = token_id;

    let attacker = Address::generate(&env);
    client.set_flash_loan_fee_bps(&attacker, &10);
}

#[test]
#[should_panic(expected = "exceeds MAX_FLASH_LOAN_FEE_BPS")]
fn test_flash_loan_fee_capped() {
    let pool_liquidity: i128 = 1_000_000_0000000;
    let (env, contract_id, token_id, _token_client) = setup_flash(pool_liquidity);
    let client = LendingContractClient::new(&env, &contract_id);
    let _ = token_id;
    let admin = client.get_admin();

    client.set_flash_loan_fee_bps(&admin, &501); // > MAX_FLASH_LOAN_FEE_BPS (500)
}

// ─── Interest rate model tests ────────────────────────────────────────────────

/// Helper: creates and activates a loan, returning its ID.
fn create_and_activate_loan(
    env: &Env,
    client: &LendingContractClient,
    admin: &Address,
    borrower: &Address,
    collateral_asset: &Address,
    rate_model: &InterestRateModel,
) -> u32 {
    let principal: i128 = 1_000_0000000;
    let rate_bps: u32 = 1000;
    let days: u32 = 30;
    let max_loan: i128 = 100_000_0000000;

    let loan_id = client.create_loan_request(
        borrower, &principal, &days, &rate_bps, &max_loan,
        collateral_asset, &100_000_0000000, rate_model,
    );

    // Approve (lender = admin for simplicity)
    client.approve_loan(admin, &loan_id, &1);
    // Activate
    client.activate_loan(admin, &loan_id);
    loan_id
}

/// Creating a Fixed-rate loan stores the model correctly.
#[test]
fn test_create_loan_with_fixed_rate_model() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = client.create_loan_request(
        &borrower, &1_000_0000000, &30, &1000, &100_000_0000000,
        &collateral_asset, &100_000_0000000, &InterestRateModel::Fixed,
    );
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.rate_model, InterestRateModel::Fixed);
    assert_eq!(loan.base_rate_bps, 1000);
}

/// Creating a Floating-rate loan stores the model correctly.
#[test]
fn test_create_loan_with_floating_rate_model() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = client.create_loan_request(
        &borrower, &1_000_0000000, &30, &500, &100_000_0000000,
        &collateral_asset, &100_000_0000000, &InterestRateModel::Floating,
    );
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.rate_model, InterestRateModel::Floating);
    assert_eq!(loan.base_rate_bps, 500);
}

/// Switching from Fixed to Floating and back works, charges fee, and toggles model.
#[test]
fn test_switch_rate_model_fixed_to_floating() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = create_and_activate_loan(
        &env, &client, &admin, &borrower, &collateral_asset, &InterestRateModel::Fixed,
    );
    let loan_before = client.get_loan(&loan_id);
    assert_eq!(loan_before.rate_model, InterestRateModel::Fixed);

    // Switch Fixed -> Floating
    client.switch_rate_model(&borrower, &loan_id);
    let loan_after = client.get_loan(&loan_id);
    assert_eq!(loan_after.rate_model, InterestRateModel::Floating);

    // Fee was charged: 0.5% of remaining_due
    let expected_fee = loan_before.remaining_due * 50 / 10_000;
    assert_eq!(
        loan_after.remaining_due,
        loan_before.remaining_due + expected_fee,
    );
}

/// Switching is blocked during the 24h cooldown.
#[test]
#[should_panic(expected = "Rate switch cooldown not elapsed")]
fn test_switch_rate_model_cooldown_enforced() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = create_and_activate_loan(
        &env, &client, &admin, &borrower, &collateral_asset, &InterestRateModel::Fixed,
    );

    // First switch should succeed
    client.switch_rate_model(&borrower, &loan_id);

    // Second switch within 24h should fail
    env.ledger().set_timestamp(env.ledger().timestamp() + 3600); // +1 hour
    client.switch_rate_model(&borrower, &loan_id);
}

/// Switching succeeds again after cooldown expires.
#[test]
fn test_switch_rate_model_allowed_after_cooldown() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = create_and_activate_loan(
        &env, &client, &admin, &borrower, &collateral_asset, &InterestRateModel::Fixed,
    );

    // First switch
    client.switch_rate_model(&borrower, &loan_id);
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.rate_model, InterestRateModel::Floating);

    // Advance time past cooldown
    env.ledger().set_timestamp(env.ledger().timestamp() + 86_401);

    // Second switch should succeed
    client.switch_rate_model(&borrower, &loan_id);
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.rate_model, InterestRateModel::Fixed);
}

/// Only the borrower can switch the rate model.
#[test]
#[should_panic(expected = "Caller is not the borrower")]
fn test_switch_rate_model_only_borrower() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = create_and_activate_loan(
        &env, &client, &admin, &borrower, &collateral_asset, &InterestRateModel::Fixed,
    );

    let attacker = Address::generate(&env);
    client.switch_rate_model(&attacker, &loan_id);
}

/// Can only switch rate model on ACTIVE loans.
#[test]
#[should_panic(expected = "Can only switch rate model on ACTIVE loans")]
fn test_switch_rate_model_only_active() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Create but don't activate
    let loan_id = client.create_loan_request(
        &borrower, &1_000_0000000, &30, &1000, &100_000_0000000,
        &collateral_asset, &100_000_0000000, &InterestRateModel::Fixed,
    );
    client.switch_rate_model(&borrower, &loan_id);
}

/// Admin can update the floating rate and remaining totals are recalculated.
#[test]
fn test_update_floating_rate() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = create_and_activate_loan(
        &env, &client, &admin, &borrower, &collateral_asset, &InterestRateModel::Floating,
    );
    let loan_before = client.get_loan(&loan_id);
    assert_eq!(loan_before.interest_rate_bps, 1000);

    // Update to a higher rate
    client.update_floating_rate(&admin, &loan_id, &2000);
    let loan_after = client.get_loan(&loan_id);
    assert_eq!(loan_after.interest_rate_bps, 2000);
    // With a higher rate, total_due should be different from original
    // (exact value depends on remaining days)
}

/// update_floating_rate panics on a Fixed-rate loan.
#[test]
#[should_panic(expected = "Loan is not using floating rate model")]
fn test_update_floating_rate_rejects_fixed() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = create_and_activate_loan(
        &env, &client, &admin, &borrower, &collateral_asset, &InterestRateModel::Fixed,
    );
    client.update_floating_rate(&admin, &loan_id, &2000);
}
