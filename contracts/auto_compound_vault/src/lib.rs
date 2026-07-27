#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Env,
};

#[cfg(test)]
mod test;

// ─── Constants & Data Keys ──────────────────────────────────────────────────

pub const DEFAULT_HARVEST_FEE_BPS: u32 = 100; // 1%
pub const MAX_HARVEST_FEE_BPS: u32 = 1000; // 10%
pub const PRECISION: i128 = 10_000_000; // 1.0000000 precision scaling factor

#[contracttype]
pub enum DataKey {
    Admin,
    AssetToken,
    LendingContract,
    HarvestFeeBps,
    TotalShares,
    TotalManagedAssets,
    UserShares(Address),
}

// ─── AutoCompoundVaultContract ───────────────────────────────────────────────

#[contract]
pub struct AutoCompoundVaultContract;

#[contractimpl]
impl AutoCompoundVaultContract {
    /// Initialize the vault with configuration parameters.
    pub fn initialize(
        env: Env,
        admin: Address,
        asset_token: Address,
        lending_contract: Address,
        harvest_fee_bps: u32,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Vault already initialised");
        }
        if harvest_fee_bps > MAX_HARVEST_FEE_BPS {
            panic!("Harvest fee exceeds max limit");
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::AssetToken, &asset_token);
        env.storage().instance().set(&DataKey::LendingContract, &lending_contract);
        env.storage().instance().set(&DataKey::HarvestFeeBps, &harvest_fee_bps);
        env.storage().instance().set(&DataKey::TotalShares, &0i128);
        env.storage().instance().set(&DataKey::TotalManagedAssets, &0i128);
    }

    /// Lenders deposit underlying asset tokens into the vault and receive vault shares.
    pub fn deposit(env: Env, from: Address, amount: i128) -> i128 {
        from.require_auth();

        if amount <= 0 {
            panic!("Deposit amount must be positive");
        }

        let asset_token = Self::get_asset_token(env.clone());
        token::Client::new(&env, &asset_token).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );

        let total_shares = Self::get_total_shares(env.clone());
        let total_managed = Self::get_total_managed_assets(env.clone());

        let shares = if total_shares == 0 || total_managed == 0 {
            amount
        } else {
            (amount * total_shares) / total_managed
        };

        if shares <= 0 {
            panic!("Deposit yielded zero shares");
        }

        let current_user_shares = Self::get_shares_of(env.clone(), from.clone());
        let new_user_shares = current_user_shares + shares;

        env.storage().persistent().set(&DataKey::UserShares(from.clone()), &new_user_shares);
        env.storage().instance().set(&DataKey::TotalShares, &(total_shares + shares));
        env.storage().instance().set(&DataKey::TotalManagedAssets, &(total_managed + amount));

        env.events().publish(
            (symbol_short!("vault"), symbol_short!("deposit")),
            (from, amount, shares),
        );

        shares
    }

    /// Lenders redeem vault shares for underlying principal + compounded interest.
    pub fn withdraw(env: Env, from: Address, shares: i128) -> i128 {
        from.require_auth();

        if shares <= 0 {
            panic!("Share count must be positive");
        }

        let user_shares = Self::get_shares_of(env.clone(), from.clone());
        if user_shares < shares {
            panic!("Insufficient shares balance");
        }

        let total_shares = Self::get_total_shares(env.clone());
        let total_managed = Self::get_total_managed_assets(env.clone());

        let amount = (shares * total_managed) / total_shares;
        if amount <= 0 {
            panic!("Shares yield zero asset payout");
        }

        let new_user_shares = user_shares - shares;
        if new_user_shares == 0 {
            env.storage().persistent().remove(&DataKey::UserShares(from.clone()));
        } else {
            env.storage().persistent().set(&DataKey::UserShares(from.clone()), &new_user_shares);
        }

        env.storage().instance().set(&DataKey::TotalShares, &(total_shares - shares));
        env.storage().instance().set(&DataKey::TotalManagedAssets, &(total_managed - amount));

        let asset_token = Self::get_asset_token(env.clone());
        token::Client::new(&env, &asset_token).transfer(
            &env.current_contract_address(),
            &from,
            &amount,
        );

        env.events().publish(
            (symbol_short!("vault"), symbol_short!("withdraw")),
            (from, shares, amount),
        );

        amount
    }

    /// Publicly callable harvest function.
    /// Claims interest, rewards caller with `harvest_fee_bps` fee, and reinvests
    /// net yield into total managed assets (auto-compounding share value).
    pub fn harvest(env: Env, caller: Address, yield_amount: i128) -> i128 {
        caller.require_auth();

        if yield_amount <= 0 {
            panic!("Yield amount must be positive");
        }

        let total_shares = Self::get_total_shares(env.clone());
        if total_shares == 0 {
            panic!("No active deposits in vault");
        }

        let harvest_fee_bps = Self::get_harvest_fee_bps(env.clone());
        let fee = (yield_amount * (harvest_fee_bps as i128)) / 10_000;
        let reinvest = yield_amount - fee;

        if fee > 0 {
            let asset_token = Self::get_asset_token(env.clone());
            token::Client::new(&env, &asset_token).transfer(
                &env.current_contract_address(),
                &caller,
                &fee,
            );
        }

        let current_managed = Self::get_total_managed_assets(env.clone());
        env.storage().instance().set(&DataKey::TotalManagedAssets, &(current_managed + reinvest));

        env.events().publish(
            (symbol_short!("vault"), symbol_short!("harvest")),
            (caller, yield_amount, fee, reinvest),
        );

        reinvest
    }

    // ── Getters & Admin Config ───────────────────────────────────────────────

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).expect("Vault not initialised")
    }

    pub fn get_asset_token(env: Env) -> Address {
        env.storage().instance().get(&DataKey::AssetToken).expect("Vault not initialised")
    }

    pub fn get_lending_contract(env: Env) -> Address {
        env.storage().instance().get(&DataKey::LendingContract).expect("Vault not initialised")
    }

    pub fn get_harvest_fee_bps(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::HarvestFeeBps).unwrap_or(DEFAULT_HARVEST_FEE_BPS)
    }

    pub fn set_harvest_fee_bps(env: Env, caller: Address, fee_bps: u32) {
        caller.require_auth();
        let admin = Self::get_admin(env.clone());
        if caller != admin {
            panic!("Unauthorised caller");
        }
        if fee_bps > MAX_HARVEST_FEE_BPS {
            panic!("Harvest fee exceeds max limit");
        }
        env.storage().instance().set(&DataKey::HarvestFeeBps, &fee_bps);
    }

    pub fn get_total_shares(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalShares).unwrap_or(0)
    }

    pub fn get_total_managed_assets(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalManagedAssets).unwrap_or(0)
    }

    pub fn get_shares_of(env: Env, user: Address) -> i128 {
        env.storage().persistent().get(&DataKey::UserShares(user)).unwrap_or(0)
    }

    pub fn get_user_asset_balance(env: Env, user: Address) -> i128 {
        let total_shares = Self::get_total_shares(env.clone());
        if total_shares == 0 {
            return 0;
        }
        let user_shares = Self::get_shares_of(env.clone(), user);
        let total_managed = Self::get_total_managed_assets(env);
        (user_shares * total_managed) / total_shares
    }

    pub fn get_exchange_rate(env: Env) -> i128 {
        let total_shares = Self::get_total_shares(env.clone());
        if total_shares == 0 {
            return PRECISION;
        }
        let total_managed = Self::get_total_managed_assets(env);
        (total_managed * PRECISION) / total_shares
    }
}
