//! Kani formal verification harnesses for the TrustLend lending contract.
//!
//! # Why Formal Verification?
//!
//! Unit tests alone are insufficient for a lending protocol handling financial
//! assets. Tests can only demonstrate the *absence* of bugs for specific inputs,
//! whereas formal verification proves properties hold for *all* inputs within
//! a defined range.
//!
//! # Framework Selection
//!
//! **Kani** (Rust model checker) was selected over alternatives because:
//!
//! - **Certora**: Solidity-only; incompatible with Rust/Soroban.
//! - **K Framework**: Requires writing K definitions from scratch; steep learning curve.
//! - **Prusti**: Limited support for Soroban macro-heavy code.
//! - **Kani**: Native Rust, `#![no_std]` compatible, works directly with the
//!   existing codebase, integrates via `cargo kani`, and produces concrete
//!   counterexamples on failure.
//!
//! Property-based testing via `proptest` is used as a complementary layer for
//! fuzz-testing arithmetic edge cases that benefit from randomised exploration.
//!
//! # Architecture
//!
//! Each proof module operates on **pure Rust types** that mirror the contract's
//! data structures. This allows Kani to verify the core logic without requiring
//! the Soroban host environment, which Kani cannot fully model-check.
//!
//! # Known Limitations
//!
//! - **Soroban host functions** (`env.storage()`, `env.events()`, token transfers)
//!   cannot be model-checked. Proofs focus on computation and state transitions.
//! - **Cross-contract calls** (e.g., to EscrowContract, GovernanceContract) are
//!   outside the proof scope.
//! - **Bounded inputs**: All proofs operate over bounded input ranges. Unbounded
//!   verification would require infinite execution paths.
//! - **Integer division truncation**: Interest formulas use integer division which
//!     loses precision. Proofs verify the *exact* integer arithmetic, not ideal
//!     mathematical equality.

mod accounting;
mod fees;
mod flash_loan;
mod math;
mod state_machine;
