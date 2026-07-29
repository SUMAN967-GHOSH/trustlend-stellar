# Getting Started with TrustLend

Welcome, contributor! This guide walks you through setting up your local development environment for TrustLend — from installing the Soroban CLI and Node dependencies to running the full test suite.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Clone the Repository](#2-clone-the-repository)
3. [Frontend Setup (Next.js)](#3-frontend-setup-nextjs)
4. [Smart Contract Setup (Soroban / Rust)](#4-smart-contract-setup-soroban--rust)
5. [Running the Test Suite](#5-running-the-test-suite)
6. [Common Tasks & Workflows](#6-common-tasks--workflows)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Prerequisites

Install these tools on your machine before cloning the repo.

| Tool | Version | Purpose |
|---|---|---|
| **Node.js** | ^20 (LTS) | Next.js frontend & tooling |
| **npm** | ^10 | Package manager |
| **Rust** | stable (via `rustup`) | Soroban smart contract compilation |
| **Soroban CLI** | latest | Contract deployment & interaction |
| **Docker** (optional) | ^24 | Alternative dev environment via Compose |
| **Freighter Wallet** | latest (browser ext.) | Stellar wallet for testnet interactions |

### Verify Installations

```bash
node --version   # Should be >= 20.x
npm --version    # Should be >= 10.x
rustc --version  # Should be >= 1.80
cargo --version  # Should match rustc
```

### Install Rust

If you don't have Rust installed:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

### Install the `wasm32-unknown-unknown` Target

Soroban contracts compile to WebAssembly. Add the target:

```bash
rustup target add wasm32-unknown-unknown
```

### Install the Soroban CLI

The Soroban CLI (`stellar`) is used to deploy and interact with contracts:

```bash
cargo install stellar-cli --locked
```

> **Note:** This compiles from source and takes a few minutes. On macOS you may need `pkg-config` and `libssl-dev`. On Linux: `sudo apt install pkg-config libssl-dev`.

Verify the CLI:

```bash
stellar --version
```

---

## 2. Clone the Repository

### Fork First

If you plan to contribute, [fork the repository](https://github.com/thisisouvik/trustlend-stellar/fork) on GitHub, then clone your fork:

```bash
git clone https://github.com/<your-username>/trustlend-stellar.git
cd trustlend-stellar
```

Add the original repo as an upstream remote so you can sync changes:

```bash
git remote add upstream https://github.com/thisisouvik/trustlend-stellar.git
```

---

## 3. Frontend Setup (Next.js)

### 3.1 Install Node Dependencies

```bash
npm install
```

This installs all frontend dependencies listed in `package.json` (React 19, Next.js 16, Tailwind CSS 4, Supabase SDK, Stellar SDK, etc.). The install also triggers Husky's `prepare` script which activates the commit-msg hook for conventional commit enforcement.

### 3.2 Configure Environment Variables

Copy the example environment file:

```bash
cp .env.example .env.local
```

Open `.env.local` and set the required values. For **local development with an offline Supabase project**, at minimum configure:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<your-project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
NEXT_PUBLIC_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
```

> Refer to `.env.example` for the full list of supported variables and their descriptions.

### 3.3 Set Up Supabase (Database)

The project uses Supabase for auth, Postgres, and storage. Run the SQL migration files in your Supabase SQL editor **in order**:

| Order | File | Purpose |
|---|---|---|
| 1 | `sql/01_core_schema.sql` | Core tables: users, loans, pools, etc. |
| 2 | `sql/02_security_rls.sql` | Row-level security policies |
| 3 | `sql/03_functions_rpcs.sql` | PostgreSQL functions & RPCs |
| 4 | `sql/04_pool_performance_rpc.sql` | Optimized pool-query RPCs |
| 5 | `sql/05_interest_rate_model.sql` | Interest rate model logic |
| 6 | `sql/05_horizon_sync_schema.sql` | Horizon sync tables |
| 7 | `sql/06_kyc_provider.sql` | KYC provider schema |

Also create a private storage bucket named **`kyc-documents`** in the Supabase dashboard for user document uploads.

### 3.4 Start the Development Server

```bash
npm run dev
```

The app starts at **http://localhost:3000** with hot-reloading enabled.

### 3.5 Using Docker (Alternative)

If you prefer a containerized setup, run:

```bash
docker-compose up
```

This starts the Next.js dev server and any required services. The app is available at `http://localhost:3000`.

---

## 4. Smart Contract Setup (Soroban / Rust)

The contracts live in the `contracts/` directory — a Cargo workspace with 8 crates:

| Crate | Path | Purpose |
|---|---|---|
| `borrower-reputation` | `contracts/borrower_reputation/` | On-chain reputation scoring |
| `escrow` | `contracts/escrow/` | Escrow-assisted disbursement |
| `lending` | `contracts/lending/` | Core lending logic |
| `default-management` | `contracts/default_management/` | Default & insurance pool |
| `governance` | `contracts/governance/` | DAO governance controls |
| `multisig-admin` | `contracts/multisig_admin/` | Multi-signature admin gating |
| `auto-compound-vault` | `contracts/auto_compound_vault/` | Auto-compounding interest vault |
| `treasury` | `contracts/treasury/` | Fee collection & distribution |

### 4.1 Build All Contracts

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
```

This compiles each contract to a `.wasm` binary in `contracts/target/wasm32-unknown-unknown/release/`.

### 4.2 Run Contract Tests

```bash
cd contracts
cargo test
```

This runs **all** unit tests across the entire workspace. Expect **100+ tests** to pass.

To run tests for a specific contract:

```bash
cargo test -p lending          # Lending contract only
cargo test -p governance       # Governance contract only
cargo test -p multisig-admin   # MultiSig admin contract
```

To run property-based tests (proptest) for the lending contract:

```bash
cargo test -p lending --test proptest_tests -- --test-threads=1
```

### 4.3 Deploy Contracts to Testnet (Maintainers)

> This requires a Stellar testnet account with a funded `G...` address.

Generate a keypair and fund it:

```bash
stellar keys generate trustlend-admin --global
stellar keys address trustlend-admin
# -> GABCDE...
curl "https://friendbot.stellar.org?addr=GABCDE..."
```

Deploy a specific contract:

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/lending.wasm \
  --source trustlend-admin \
  --network testnet
```

For a full workspace deployment, see `contracts/scripts/deploy.sh`.

---

## 5. Running the Test Suite

TrustLend has two separate test suites: **frontend** (TypeScript / vitest) and **smart contracts** (Rust / `cargo test`).

### 5.1 Frontend Tests (vitest)

```bash
# Run all frontend tests
npx vitest run

# Run with coverage report
npx vitest run --coverage

# Run a specific test file
npx vitest run lib/utils/formatting.test.ts

# Run tests in watch mode (development)
npx vitest
```

### 5.2 Smart Contract Tests (Rust)

```bash
# Run all contract tests
cd contracts && cargo test

# Run tests with output (useful for debugging)
cd contracts && cargo test -- --nocapture

# Run a specific test by name
cd contracts && cargo test test_flash_loan_success_full_repayment
```

### 5.3 Type Checking

```bash
# Frontend TypeScript check
npx tsc --noEmit

# Rust check (without running tests)
cd contracts && cargo check
```

### 5.4 Linting

```bash
# ESLint for frontend
npm run lint

# Clippy for Rust contracts
cd contracts && cargo clippy --all-targets -- -D warnings -A clippy::inconsistent_digit_grouping
```

### 5.5 Full CI Pipeline (What CI Runs)

Our GitHub Actions CI runs these checks on every PR:

| Workflow | What It Does |
|---|---|
| `ci.yml` — **Test Soroban Contracts** | `cargo test` + WASM build |
| `ci.yml` — **Build Next.js** | `tsc --noEmit` → `eslint` → `next build` |
| `contract-security.yml` | `cargo clippy` + `cargo audit` |
| `formal-verification.yml` | proptest + Kani model checking |
| `coverage.yml` | `cargo tarpaulin` → Codecov upload |
| `vercel-preview.yml` | Vercel preview deploy + URL comment |

---

## 6. Common Tasks & Workflows

### Adding a New Smart Contract Crate

1. Create `contracts/<crate_name>/` with a `Cargo.toml` and `src/lib.rs`.
2. Add `"<crate_name>"` to the `[workspace].members` list in `contracts/Cargo.toml`.
3. Add `soroban-sdk = { workspace = true }` to the crate's `Cargo.toml`.
4. Run `cargo build` from `contracts/` to verify it compiles.

### Adding a New Frontend Route

1. Create a file in `app/` following Next.js App Router conventions.
2. If the route needs data, write a server action in `app/actions/`.
3. Add any new components in `components/`.
4. Run `npx tsc --noEmit` to check types.

### Conventional Commits

All commits must follow the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <description>

<body> (optional)

<footer> (optional)
```

Valid types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`, `contract`, `stellar`, `security`.

Valid scopes include: `lending`, `escrow`, `governance`, `frontend`, `ci`, `db`, `auth`, `kyc`, etc.

> The Husky commit-msg hook enforces this. Invalid commits will be rejected.

### Creating a Pull Request

1. Create a branch from `main` with a descriptive name:
   ```bash
   git checkout -b feat/lending-add-feature
   ```

2. Make your changes and commit:
   ```bash
   git add -A
   git commit -m "feat(lending): add new feature"
   ```

3. Push and open a PR:
   ```bash
   git push -u origin feat/lending-add-feature
   ```
   Then open a PR at `https://github.com/thisisouvik/trustlend-stellar/pulls`

4. Ensure CI passes. Respond to reviewer feedback.

---

## 7. Troubleshooting

### `stellar: command not found`

The Soroban CLI binary is installed at `~/.cargo/bin/stellar`. Make sure `~/.cargo/bin` is in your `PATH`:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

Add this line to your `~/.bashrc` or `~/.zshrc`.

### `cargo test` fails with WASM-related errors

Make sure the `wasm32-unknown-unknown` target is installed:

```bash
rustup target add wasm32-unknown-unknown
```

### `npm install` fails

- Delete `node_modules` and `package-lock.json`, then retry:
  ```bash
  rm -rf node_modules package-lock.json
  npm install
  ```
- Ensure your Node.js version is >= 20.

### Supabase queries return empty / auth doesn't work

- Verify your `.env.local` has the correct `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Ensure all SQL migration files have been run in your Supabase project.
- Check that Row-Level Security (RLS) policies are applied.

### Tests are slow

- For Rust tests, `Swatinem/rust-cache` in CI caches dependencies. Locally, `cargo test` reuses the build cache automatically.
- For vitest, run `npx vitest --changed` to only test changed files.

### Husky commit-msg hook is not running

Ensure husky is installed:

```bash
npx husky init
```

This recreates the `.husky/_/` directory and ensures hooks are activated. The `npm install` command runs `husky` automatically via the `prepare` script.

---

## Next Steps

- Read the [Contributing Guidelines](CONTRIBUTING.md) for the PR workflow.
- Check the [Roadmap](ROADMAP.md) for upcoming features.
- Browse project documentation: [Flash Loans](contracts/FLASH_LOANS.md), [MultiSig Admin](contracts/MULTISIG_ADMIN.md), [Oracle Integration](contracts/ORACLE_INTEGRATION.md), [Governance](contracts/GOVERNANCE.md).
- Join the community discussions on GitHub Issues.
