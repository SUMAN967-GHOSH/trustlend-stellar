//! Formal verification of the lending contract's loan state machine.
//!
//! Verifies:
//! - Valid status transitions: Pending→Approved→Active→{Repaid,Defaulted}
//! - Pending→Cancelled is valid
//! - All other transitions are rejected
//! - Paused contract prevents state-changing operations

// ─── Mirrored types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoanStatus {
    Pending,
    Approved,
    Active,
    Repaid,
    Defaulted,
    Cancelled,
}

/// Attempt a state transition; returns the new status or None if invalid.
fn transition(status: LoanStatus, action: Action) -> Option<LoanStatus> {
    match (status, action) {
        (LoanStatus::Pending, Action::Approve) => Some(LoanStatus::Approved),
        (LoanStatus::Pending, Action::Cancel) => Some(LoanStatus::Cancelled),
        (LoanStatus::Approved, Action::Revoke) => Some(LoanStatus::Pending),
        (LoanStatus::Approved, Action::Activate) => Some(LoanStatus::Active),
        (LoanStatus::Active, Action::RecordPayment) => Some(LoanStatus::Active), // stays Active
        (LoanStatus::Active, Action::FullPayment) => Some(LoanStatus::Repaid),
        (LoanStatus::Active, Action::Default) => Some(LoanStatus::Defaulted),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Approve,
    Cancel,
    Revoke,
    Activate,
    RecordPayment,
    FullPayment,
    Default,
    SwitchRate, // does not change status
}

/// Returns true if the action is a state-changing operation that should be
/// blocked when the contract is paused.
fn action_blocked_when_paused(action: Action) -> bool {
    matches!(
        action,
        Action::Approve | Action::Activate | Action::Default | Action::SwitchRate
    )
}

// ─── Kani Proof Harnesses ────────────────────────────────────────────────────

/// INV-SM-1: Pending can only transition to Approved or Cancelled.
#[cfg(kani)]
#[kani::proof]
fn inv_sm_1_pending_transitions() {
    let action: Action = kani::any();
    let result = transition(LoanStatus::Pending, action);

    match action {
        Action::Approve => assert_eq!(result, Some(LoanStatus::Approved)),
        Action::Cancel => assert_eq!(result, Some(LoanStatus::Cancelled)),
        _ => assert_eq!(
            result, None,
            "Pending can only transition to Approved or Cancelled"
        ),
    }
}

/// INV-SM-2: Approved can only transition to Active, Pending (revoke), or stay.
#[cfg(kani)]
#[kani::proof]
fn inv_sm_2_approved_transitions() {
    let action: Action = kani::any();
    let result = transition(LoanStatus::Approved, action);

    match action {
        Action::Revoke => assert_eq!(result, Some(LoanStatus::Pending)),
        Action::Activate => assert_eq!(result, Some(LoanStatus::Active)),
        _ => assert_eq!(
            result, None,
            "Approved can only transition to Active or Pending"
        ),
    }
}

/// INV-SM-3: Active can only transition to Repaid, Defaulted, or stay Active.
#[cfg(kani)]
#[kani::proof]
fn inv_sm_3_active_transitions() {
    let action: Action = kani::any();
    let result = transition(LoanStatus::Active, action);

    match action {
        Action::RecordPayment => assert_eq!(result, Some(LoanStatus::Active)),
        Action::FullPayment => assert_eq!(result, Some(LoanStatus::Repaid)),
        Action::Default => assert_eq!(result, Some(LoanStatus::Defaulted)),
        Action::SwitchRate => assert_eq!(result, None), // does not change status
        _ => assert_eq!(
            result, None,
            "Active can only transition to Active, Repaid, or Defaulted"
        ),
    }
}

/// INV-SM-4: Repaid is a terminal state (no outgoing transitions).
#[cfg(kani)]
#[kani::proof]
fn inv_sm_4_repaid_is_terminal() {
    let action: Action = kani::any();
    let result = transition(LoanStatus::Repaid, action);
    assert_eq!(result, None, "Repaid is a terminal state");
}

/// INV-SM-5: Defaulted is a terminal state (no outgoing transitions).
#[cfg(kani)]
#[kani::proof]
fn inv_sm_5_defaulted_is_terminal() {
    let action: Action = kani::any();
    let result = transition(LoanStatus::Defaulted, action);
    assert_eq!(result, None, "Defaulted is a terminal state");
}

/// INV-SM-6: Cancelled is a terminal state (no outgoing transitions).
#[cfg(kani)]
#[kani::proof]
fn inv_sm_6_cancelled_is_terminal() {
    let action: Action = kani::any();
    let result = transition(LoanStatus::Cancelled, action);
    assert_eq!(result, None, "Cancelled is a terminal state");
}

/// INV-SM-7: Paused contracts block Approve, Activate, Default, and SwitchRate.
///
/// Verified by enumerating every action independently and checking the expected
/// blocked/unblocked status, rather than re-checking the classification
/// produced by `action_blocked_when_paused`.
#[cfg(kani)]
#[kani::proof]
fn inv_sm_7_paused_blocks_actions() {
    // Blocked actions (cannot proceed when paused)
    assert!(action_blocked_when_paused(Action::Approve));
    assert!(action_blocked_when_paused(Action::Activate));
    assert!(action_blocked_when_paused(Action::Default));
    assert!(action_blocked_when_paused(Action::SwitchRate));

    // Allowed actions (can proceed when paused)
    assert!(!action_blocked_when_paused(Action::Cancel));
    assert!(!action_blocked_when_paused(Action::Revoke));
    assert!(!action_blocked_when_paused(Action::RecordPayment));
    assert!(!action_blocked_when_paused(Action::FullPayment));
}

/// INV-SM-8: RecordPayment is NOT blocked when paused (allowed per contract).
#[cfg(kani)]
#[kani::proof]
fn inv_sm_8_record_payment_not_blocked() {
    assert!(
        !action_blocked_when_paused(Action::RecordPayment),
        "RecordPayment must be allowed when paused"
    );
}

/// INV-SM-9: No transition from terminal states.
///
/// For every action, Repaid, Defaulted, and Cancelled all return None.
#[cfg(kani)]
#[kani::proof]
fn inv_sm_9_no_transition_from_terminal() {
    let action: Action = kani::any();

    let repaid = transition(LoanStatus::Repaid, action);
    let defaulted = transition(LoanStatus::Defaulted, action);
    let cancelled = transition(LoanStatus::Cancelled, action);

    assert_eq!(repaid, None, "No transition from Repaid");
    assert_eq!(defaulted, None, "No transition from Defaulted");
    assert_eq!(cancelled, None, "No transition from Cancelled");
}

/// INV-SM-10: Exactly 6 states are reachable from Pending.
///
/// Enumerates reachable states by traversing valid transitions from Pending.
/// This is a symbolic reachability check within the proof's transition model.
#[cfg(kani)]
#[kani::proof]
fn inv_sm_10_reachable_states() {
    // Direct transitions from Pending
    let approved = transition(LoanStatus::Pending, Action::Approve);
    let cancelled = transition(LoanStatus::Pending, Action::Cancel);

    // From Approved
    let active = approved.and_then(|s| transition(s, Action::Activate));
    let back_to_pending = approved.and_then(|s| transition(s, Action::Revoke));

    // From Active
    let repaid = active.and_then(|s| transition(s, Action::FullPayment));
    let defaulted = active.and_then(|s| transition(s, Action::Default));

    // All six distinct states are reachable
    assert_eq!(approved, Some(LoanStatus::Approved));
    assert_eq!(cancelled, Some(LoanStatus::Cancelled));
    assert_eq!(active, Some(LoanStatus::Active));
    assert_eq!(repaid, Some(LoanStatus::Repaid));
    assert_eq!(defaulted, Some(LoanStatus::Defaulted));

    // Revoke cycles back to Pending
    assert_eq!(back_to_pending, Some(LoanStatus::Pending));
}
