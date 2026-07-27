#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::Address as _, token, Address, Env,
};

fn setup_test() -> (Env, Address, Address, Address, Address, AutoCompoundVaultContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset_token_id = env.register_stellar_asset_contract_v2(token_admin.clone()).address();
    let lending_id = Address::generate(&env);

    let vault_id = env.register(AutoCompoundVaultContract, ());
    let client = AutoCompoundVaultContractClient::new(&env, &vault_id);
    client.initialize(&admin, &asset_token_id, &lending_id, &100); // 1% harvest fee

    (env, admin, asset_token_id, lending_id, vault_id, client)
}

fn mint_tokens(env: &Env, asset_token: &Address, recipient: &Address, amount: i128) {
    let token_admin_client = token::StellarAssetClient::new(env, asset_token);
    token_admin_client.mint(recipient, &amount);
}

#[test]
fn test_initialize_sets_config() {
    let (_env, admin, asset_token, lending_id, _vault_id, client) = setup_test();
    assert_eq!(client.get_admin(), admin);
    assert_eq!(client.get_asset_token(), asset_token);
    assert_eq!(client.get_lending_contract(), lending_id);
    assert_eq!(client.get_harvest_fee_bps(), 100);
    assert_eq!(client.get_total_shares(), 0);
    assert_eq!(client.get_total_managed_assets(), 0);
    assert_eq!(client.get_exchange_rate(), PRECISION);
}

#[test]
fn test_first_deposit_mints_equal_shares() {
    let (env, _admin, asset_token, _lending_id, _vault_id, client) = setup_test();
    let alice = Address::generate(&env);
    let deposit_amount = 1_000_0000000i128;

    mint_tokens(&env, &asset_token, &alice, deposit_amount);

    let shares = client.deposit(&alice, &deposit_amount);
    assert_eq!(shares, deposit_amount);
    assert_eq!(client.get_shares_of(&alice), deposit_amount);
    assert_eq!(client.get_total_shares(), deposit_amount);
    assert_eq!(client.get_total_managed_assets(), deposit_amount);
    assert_eq!(client.get_user_asset_balance(&alice), deposit_amount);
    assert_eq!(client.get_exchange_rate(), PRECISION);
}

#[test]
fn test_subsequent_deposit_mints_proportional_shares() {
    let (env, _admin, asset_token, _lending_id, _vault_id, client) = setup_test();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    mint_tokens(&env, &asset_token, &alice, 1_000_0000000i128);
    mint_tokens(&env, &asset_token, &bob, 500_0000000i128);

    client.deposit(&alice, &1_000_0000000i128);
    let bob_shares = client.deposit(&bob, &500_0000000i128);

    assert_eq!(bob_shares, 500_0000000i128);
    assert_eq!(client.get_total_shares(), 1_500_0000000i128);
    assert_eq!(client.get_total_managed_assets(), 1_500_0000000i128);
}

#[test]
fn test_harvest_pays_caller_fee_and_compounds_yield() {
    let (env, _admin, asset_token, _lending_id, vault_id, client) = setup_test();
    let alice = Address::generate(&env);
    let harvester = Address::generate(&env);

    mint_tokens(&env, &asset_token, &alice, 1_000_0000000i128);
    client.deposit(&alice, &1_000_0000000i128);

    // Simulate yield generated and transferred to vault
    let yield_amount = 100_0000000i128; // 100 XLM yield
    mint_tokens(&env, &asset_token, &vault_id, yield_amount);

    let reinvested = client.harvest(&harvester, &yield_amount);

    // 1% of 100 XLM = 1 XLM fee, 99 XLM reinvested
    let expected_fee = 1_0000000i128;
    let expected_reinvest = 99_0000000i128;

    assert_eq!(reinvested, expected_reinvest);
    assert_eq!(token::Client::new(&env, &asset_token).balance(&harvester), expected_fee);
    assert_eq!(client.get_total_shares(), 1_000_0000000i128);
    assert_eq!(client.get_total_managed_assets(), 1_099_0000000i128);

    // Exchange rate should appreciate
    let new_rate = client.get_exchange_rate();
    assert!(new_rate > PRECISION);
}

#[test]
fn test_withdraw_principal_and_compounded_interest() {
    let (env, _admin, asset_token, _lending_id, vault_id, client) = setup_test();
    let alice = Address::generate(&env);
    let harvester = Address::generate(&env);

    let initial_deposit = 1_000_0000000i128;
    mint_tokens(&env, &asset_token, &alice, initial_deposit);
    let alice_shares = client.deposit(&alice, &initial_deposit);

    // Harvest yield
    let yield_amount = 200_0000000i128;
    mint_tokens(&env, &asset_token, &vault_id, yield_amount);
    client.harvest(&harvester, &yield_amount);

    // Alice withdraws all her shares
    let withdrawn = client.withdraw(&alice, &alice_shares);

    // 1000 deposit + 198 net compounded yield = 1198 XLM
    let expected_payout = 1_198_0000000i128;
    assert_eq!(withdrawn, expected_payout);
    assert_eq!(token::Client::new(&env, &asset_token).balance(&alice), expected_payout);
    assert_eq!(client.get_shares_of(&alice), 0);
    assert_eq!(client.get_total_shares(), 0);
    assert_eq!(client.get_total_managed_assets(), 0);
}

#[test]
#[should_panic(expected = "Deposit amount must be positive")]
fn test_deposit_zero_panics() {
    let (env, _admin, _asset_token, _lending_id, _vault_id, client) = setup_test();
    let alice = Address::generate(&env);
    client.deposit(&alice, &0);
}

#[test]
#[should_panic(expected = "Insufficient shares balance")]
fn test_withdraw_insufficient_shares_panics() {
    let (env, _admin, asset_token, _lending_id, _vault_id, client) = setup_test();
    let alice = Address::generate(&env);
    mint_tokens(&env, &asset_token, &alice, 1000);
    client.deposit(&alice, &1000);
    client.withdraw(&alice, &2000);
}

#[test]
#[should_panic(expected = "Unauthorised caller")]
fn test_set_harvest_fee_by_non_admin_panics() {
    let (env, _admin, _asset_token, _lending_id, _vault_id, client) = setup_test();
    let attacker = Address::generate(&env);
    client.set_harvest_fee_bps(&attacker, &200);
}

#[test]
#[should_panic(expected = "Harvest fee exceeds max limit")]
fn test_set_harvest_fee_over_max_panics() {
    let (_env, admin, _asset_token, _lending_id, _vault_id, client) = setup_test();
    client.set_harvest_fee_bps(&admin, &1500); // > 1000 max limit
}
