#!/usr/bin/env bash

# Upgrade Script for TrustLend Soroban Smart Contracts
# Usage: ./upgrade_contract.sh <CONTRACT_CRATE> <CONTRACT_ID_ENV_VAR> <ADMIN_SECRET_KEY>
# Example: ./upgrade_contract.sh lending LENDING_CONTRACT_ID SABC...

set -e

CRATE=$1
CONTRACT_ID_VAR=$2
SECRET_KEY=$3
NETWORK="${NETWORK:-testnet}"

if [ -z "$CRATE" ] || [ -z "$CONTRACT_ID_VAR" ] || [ -z "$SECRET_KEY" ]; then
    echo "Usage: ./scripts/upgrade_contract.sh <CRATE_NAME> <CONTRACT_ID_ENV_VAR> <ADMIN_SECRET_KEY>"
    exit 1
fi

# 1. Compile the contract
echo "[1/4] Compiling $CRATE..."
cd contracts
cargo build --target wasm32-unknown-unknown --release -p "$CRATE"
cd ..

WASM_PATH="contracts/target/wasm32-unknown-unknown/release/${CRATE}.wasm"

# 2. Optimize the WASM
echo "[2/4] Optimizing $WASM_PATH..."
soroban contract optimize --wasm "$WASM_PATH"
OPT_WASM_PATH="contracts/target/wasm32-unknown-unknown/release/${CRATE}.optimized.wasm"

# 3. Install the new WASM on-chain to get its hash
echo "[3/4] Installing WASM to network ($NETWORK)..."
WASM_HASH=$(soroban contract install \
    --wasm "$OPT_WASM_PATH" \
    --source "$SECRET_KEY" \
    --network "$NETWORK")

echo "WASM Hash: $WASM_HASH"

# 4. Invoke the \`upgrade\` function on the existing contract
echo "[4/4] Invoking upgrade on contract ID..."
# Note: we need the actual contract ID string. If passed as an env var name, evaluate it
# or assume it's just the contract ID string if it starts with C.
if [[ $CONTRACT_ID_VAR == C* ]]; then
    CONTRACT_ID=$CONTRACT_ID_VAR
else
    CONTRACT_ID=${!CONTRACT_ID_VAR}
fi

if [ -z "$CONTRACT_ID" ]; then
    echo "Error: Could not determine Contract ID for $CONTRACT_ID_VAR"
    exit 1
fi

# The caller argument is the admin account, so we need to get the pubkey of the secret key
# Soroban CLI automatically handles the caller argument if it matches the invoker source
# We pass the wasm hash as an argument to the \`upgrade\` function.

if [[ "$CRATE" == "multisig_admin" ]]; then
    echo "Upgrading multisig_admin via self-proposal is not directly supported by this script."
    exit 1
fi

soroban contract invoke \
    --id "$CONTRACT_ID" \
    --source "$SECRET_KEY" \
    --network "$NETWORK" \
    -- \
    upgrade \
    --caller "$(soroban keys address "$SECRET_KEY" || echo "$SECRET_KEY")" \
    --new_wasm_hash "$WASM_HASH"

echo "✅ Contract $CRATE successfully upgraded to $WASM_HASH!"
