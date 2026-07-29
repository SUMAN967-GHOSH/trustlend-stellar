#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env, IntoVal, Symbol,
    Vec,
};

#[cfg(test)]
mod test;

// ─── Types & Storage ─────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DistributionRecord {
    pub id: u32,
    pub timestamp: u64,
    pub asset_token: Address,
    pub insurance_amount: i128,
    pub dao_amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DistributionRules {
    pub insurance_share_bps: u32,
    pub dao_share_bps: u32,
}

#[contracttype]
pub enum DataKey {
    Admin,
    InsuranceFund,
    DaoTreasury,
    InsuranceShareBps,
    DaoShareBps,
    TotalCollectedFees,
    TotalDistributedInsurance,
    TotalDistributedDao,
    DistributionCount,
    Distribution(u32),
    TokenBalance(Address),
}

pub const DEFAULT_INSURANCE_SHARE_BPS: u32 = 5000; // 50%
pub const DEFAULT_DAO_SHARE_BPS: u32 = 5000; // 50%
pub const BPS_TOTAL: u32 = 10_000; // 100%

// ─── TreasuryContract ────────────────────────────────────────────────────────

#[contract]
pub struct TreasuryContract;

#[contractimpl]
impl TreasuryContract {
    /// Initialize the Treasury with admin and destination configuration.
    pub fn initialize(
        env: Env,
        admin: Address,
        insurance_fund: Address,
        dao_treasury: Address,
        insurance_share_bps: u32,
        dao_share_bps: u32,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Treasury already initialised");
        }
        if insurance_share_bps + dao_share_bps != BPS_TOTAL {
            panic!("Distribution share BPS must equal 10,000 (100%)");
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::InsuranceFund, &insurance_fund);
        env.storage().instance().set(&DataKey::DaoTreasury, &dao_treasury);
        env.storage().instance().set(&DataKey::InsuranceShareBps, &insurance_share_bps);
        env.storage().instance().set(&DataKey::DaoShareBps, &dao_share_bps);
        env.storage().instance().set(&DataKey::TotalCollectedFees, &0i128);
        env.storage().instance().set(&DataKey::TotalDistributedInsurance, &0i128);
        env.storage().instance().set(&DataKey::TotalDistributedDao, &0i128);
        env.storage().instance().set(&DataKey::DistributionCount, &0u32);
    }

    /// Upgrade the contract's code while preserving its storage.
    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) {
        caller.require_auth();
        let admin = Self::get_admin(env.clone());
        if caller != admin {
            panic!("Unauthorised caller");
        }
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Update 50/50 split ratios (admin only).
    pub fn set_distribution_rules(
        env: Env,
        caller: Address,
        insurance_share_bps: u32,
        dao_share_bps: u32,
    ) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        if insurance_share_bps + dao_share_bps != BPS_TOTAL {
            panic!("Distribution share BPS must equal 10,000 (100%)");
        }

        env.storage().instance().set(&DataKey::InsuranceShareBps, &insurance_share_bps);
        env.storage().instance().set(&DataKey::DaoShareBps, &dao_share_bps);
    }

    /// Update Insurance Fund and DAO Treasury destination addresses (admin only).
    pub fn set_destinations(
        env: Env,
        caller: Address,
        insurance_fund: Address,
        dao_treasury: Address,
    ) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        env.storage().instance().set(&DataKey::InsuranceFund, &insurance_fund);
        env.storage().instance().set(&DataKey::DaoTreasury, &dao_treasury);
    }

    /// Collect accrued platform fees from lending contract into Treasury.
    pub fn collect_protocol_fees(
        env: Env,
        caller: Address,
        lending_contract: Address,
    ) -> i128 {
        caller.require_auth();

        let args = soroban_sdk::vec![
            &env,
            caller.into_val(&env),
            env.current_contract_address().into_val(&env),
        ];
        let collected: i128 = env.invoke_contract(
            &lending_contract,
            &Symbol::new(&env, "collect_fees"),
            args,
        );

        if collected > 0 {
            let total: i128 = Self::get_total_collected_fees(env.clone());
            env.storage().instance().set(&DataKey::TotalCollectedFees, &(total + collected));

            env.events().publish(
                (symbol_short!("treasury"), symbol_short!("collect")),
                (lending_contract, collected),
            );
        }

        collected
    }

    /// Deposit fee tokens directly into the Treasury.
    pub fn deposit_fees(env: Env, from: Address, asset_token: Address, amount: i128) {
        from.require_auth();

        if amount <= 0 {
            panic!("Deposit amount must be positive");
        }

        token::Client::new(&env, &asset_token).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );

        let current_bal = Self::get_treasury_balance(env.clone(), asset_token.clone());
        env.storage().persistent().set(&DataKey::TokenBalance(asset_token.clone()), &(current_bal + amount));

        let total = Self::get_total_collected_fees(env.clone());
        env.storage().instance().set(&DataKey::TotalCollectedFees, &(total + amount));

        env.events().publish(
            (symbol_short!("treasury"), symbol_short!("deposit")),
            (from, asset_token, amount),
        );
    }

    /// Distribute Treasury holdings (e.g. 50% to Insurance Fund, 50% to DAO).
    pub fn distribute(env: Env, caller: Address, asset_token: Address) -> (i128, i128) {
        caller.require_auth();

        let balance = Self::get_treasury_balance(env.clone(), asset_token.clone());
        if balance <= 0 {
            panic!("No balance available to distribute");
        }

        let rules = Self::get_distribution_rules(env.clone());
        let insurance_amount = (balance * (rules.insurance_share_bps as i128)) / (BPS_TOTAL as i128);
        let dao_amount = balance - insurance_amount;

        let insurance_fund = Self::get_insurance_fund(env.clone());
        let dao_treasury = Self::get_dao_treasury(env.clone());

        let client = token::Client::new(&env, &asset_token);

        if insurance_amount > 0 {
            client.transfer(&env.current_contract_address(), &insurance_fund, &insurance_amount);
        }
        if dao_amount > 0 {
            client.transfer(&env.current_contract_address(), &dao_treasury, &dao_amount);
        }

        env.storage().persistent().set(&DataKey::TokenBalance(asset_token.clone()), &0i128);

        let tot_ins = Self::get_total_distributed_insurance(env.clone());
        env.storage().instance().set(&DataKey::TotalDistributedInsurance, &(tot_ins + insurance_amount));

        let tot_dao = Self::get_total_distributed_dao(env.clone());
        env.storage().instance().set(&DataKey::TotalDistributedDao, &(tot_dao + dao_amount));

        let count: u32 = env.storage().instance().get(&DataKey::DistributionCount).unwrap_or(0);
        let new_count = count + 1;

        let record = DistributionRecord {
            id: new_count,
            timestamp: env.ledger().timestamp(),
            asset_token: asset_token.clone(),
            insurance_amount,
            dao_amount,
        };

        env.storage().persistent().set(&DataKey::Distribution(new_count), &record);
        env.storage().instance().set(&DataKey::DistributionCount, &new_count);

        env.events().publish(
            (symbol_short!("treasury"), symbol_short!("distrib")),
            (asset_token, insurance_amount, dao_amount),
        );

        (insurance_amount, dao_amount)
    }

    // ── Getters ──────────────────────────────────────────────────────────────

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).expect("Treasury not initialised")
    }

    pub fn get_insurance_fund(env: Env) -> Address {
        env.storage().instance().get(&DataKey::InsuranceFund).expect("Treasury not initialised")
    }

    pub fn get_dao_treasury(env: Env) -> Address {
        env.storage().instance().get(&DataKey::DaoTreasury).expect("Treasury not initialised")
    }

    pub fn get_distribution_rules(env: Env) -> DistributionRules {
        let insurance_share_bps = env
            .storage()
            .instance()
            .get(&DataKey::InsuranceShareBps)
            .unwrap_or(DEFAULT_INSURANCE_SHARE_BPS);
        let dao_share_bps = env
            .storage()
            .instance()
            .get(&DataKey::DaoShareBps)
            .unwrap_or(DEFAULT_DAO_SHARE_BPS);

        DistributionRules {
            insurance_share_bps,
            dao_share_bps,
        }
    }

    pub fn get_treasury_balance(env: Env, asset_token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::TokenBalance(asset_token))
            .unwrap_or(0)
    }

    pub fn get_total_collected_fees(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalCollectedFees).unwrap_or(0)
    }

    pub fn get_total_distributed_insurance(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalDistributedInsurance).unwrap_or(0)
    }

    pub fn get_total_distributed_dao(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalDistributedDao).unwrap_or(0)
    }

    pub fn get_distribution_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::DistributionCount).unwrap_or(0)
    }

    pub fn get_distribution(env: Env, index: u32) -> DistributionRecord {
        env.storage()
            .persistent()
            .get(&DataKey::Distribution(index))
            .expect("Distribution record not found")
    }

    pub fn get_distribution_history(env: Env) -> Vec<DistributionRecord> {
        let count = Self::get_distribution_count(env.clone());
        let mut list = Vec::new(&env);
        for i in 1..=count {
            if let Some(record) = env.storage().persistent().get::<_, DistributionRecord>(&DataKey::Distribution(i)) {
                list.push_back(record);
            }
        }
        list
    }

    fn assert_admin(env: &Env, caller: &Address) {
        let admin = Self::get_admin(env.clone());
        if *caller != admin {
            panic!("Unauthorised caller: not admin");
        }
    }
}
