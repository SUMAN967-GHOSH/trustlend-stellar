/**
 * lib/scheduler/default-management.ts
 *
 * Automated Default-Management run (issue #23).
 *
 * Iterates over active loans, checks the *ledger* time, and for loans past the
 * grace period:
 *   1. lending.mark_defaulted(admin, loanId)         — flips the on-chain loan to Defaulted
 *   2. default.record_default(admin, loanId, …)      — records the default phase
 * and, once a loan reaches the insurance threshold (Reported phase):
 *   3. multisig.propose(admin, TriggerInsurancePayout(default, loanId, lender, amount))
 *
 * Step 3 does NOT move funds directly — `trigger_insurance_payout` is
 * multisig-gated (issue #73), since paying out the insurance fund is exactly
 * the kind of rare, high-impact operation that needs N-of-M human approval.
 * The automation's own key must be a REGISTERED SIGNER on the MultiSigAdmin
 * contract so it can propose; a human still has to approve + execute before
 * any funds actually move. See `contracts/MULTISIG_ADMIN.md`.
 *
 * Every step is idempotent (guarded by Supabase state) and individually
 * error-handled so one bad loan never aborts the whole run.
 */

import { getServiceRoleClient } from "@/lib/supabase/server";
import {
  addr,
  getAdminKeypair,
  getLedgerTimeSecs,
  i128,
  invokeSigned,
  tupleEnumToScVal,
  u32,
  u64,
  xlmToStroops,
} from "@/lib/stellar/server-contract";
import type { Keypair } from "@stellar/stellar-sdk";

const SECONDS_PER_DAY = 86_400;

/** Days overdue before a loan is marked defaulted (Friendly window = days 1-7). */
const GRACE_PERIOD_DAYS = Number(process.env.DEFAULT_GRACE_PERIOD_DAYS ?? 7);
/** Days overdue before the insurance fund reimburses the lender (Reported phase). */
const INSURANCE_PAYOUT_DAYS = Number(process.env.DEFAULT_INSURANCE_PAYOUT_DAYS ?? 60);

const LENDING_ID = process.env.NEXT_PUBLIC_LENDING_CONTRACT_ID;
const DEFAULT_ID = process.env.NEXT_PUBLIC_DEFAULT_CONTRACT_ID;
const ADMIN_ADDRESS = process.env.NEXT_PUBLIC_ADMIN_ADDRESS;
const MULTISIG_ADMIN_ID = process.env.NEXT_PUBLIC_MULTISIG_ADMIN_CONTRACT_ID;

// ─── Types ────────────────────────────────────────────────────────────────────

interface LoanRow {
  id: string;
  borrower_id: string;
  status: string;
  principal_amount: number;
  repaid_amount: number;
  due_at: string | null;
  defaulted_at: string | null;
  metadata: Record<string, unknown> | null;
}

export interface LoanOutcome {
  loanId: string;
  onchainLoanId: number | null;
  daysOverdue: number;
  actions: string[];
  skipped?: string;
  error?: string;
}

export interface DefaultRunResult {
  ledgerTime: string;
  scanned: number;
  defaulted: number;
  payoutsProposed: number;
  failed: number;
  outcomes: LoanOutcome[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Whole days a loan is overdue at `ledgerTimeSecs` (0 if not overdue). */
export function computeDaysOverdue(dueAtIso: string, ledgerTimeSecs: number): number {
  const dueSecs = Math.floor(new Date(dueAtIso).getTime() / 1000);
  if (ledgerTimeSecs <= dueSecs) return 0;
  return Math.floor((ledgerTimeSecs - dueSecs) / SECONDS_PER_DAY);
}

function outstandingXlm(loan: LoanRow): number {
  const remaining = Number(loan.principal_amount) - Number(loan.repaid_amount ?? 0);
  return remaining > 0 ? remaining : Number(loan.principal_amount);
}

/** Resolve the borrower's Stellar wallet from the profiles table. */
async function getWallet(
  supabase: ReturnType<typeof getServiceRoleClient>,
  profileId: string
): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase
    .from("profiles")
    .select("wallet_address")
    .eq("id", profileId)
    .maybeSingle();
  const w = data?.wallet_address;
  return typeof w === "string" && w.startsWith("G") ? w : null;
}

/** Lender wallet + on-chain loan id are recorded at funding time in the ledger. */
async function getFundingInfo(
  supabase: ReturnType<typeof getServiceRoleClient>,
  loanId: string,
  loanMeta: Record<string, unknown> | null
): Promise<{ lenderAddress: string | null; onchainLoanId: number | null }> {
  // Prefer the on-chain id if the loan row carries it.
  let onchainLoanId =
    toOnchainId(loanMeta?.onchain_loan_id) ?? toOnchainId(loanMeta?.onchainLoanId);
  let lenderAddress: string | null = null;

  if (!supabase) return { lenderAddress, onchainLoanId };

  const { data } = await supabase
    .from("ledger_transactions")
    .select("metadata")
    .eq("ref_type", "loan_fund")
    .eq("ref_id", loanId)
    .maybeSingle();

  const raw = data?.metadata;
  const meta: Record<string, unknown> | null =
    typeof raw === "string" ? safeJson(raw) : (raw as Record<string, unknown> | null);

  if (meta) {
    const l = meta.lenderAddress;
    if (typeof l === "string" && l.startsWith("G")) lenderAddress = l;
    onchainLoanId =
      onchainLoanId ?? toOnchainId(meta.onchainLoanId) ?? toOnchainId(meta.onchain_loan_id);
  }
  return { lenderAddress, onchainLoanId };
}

function toOnchainId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function setLoanMetadataFlag(
  supabase: ReturnType<typeof getServiceRoleClient>,
  loanId: string,
  patch: Record<string, unknown>,
  extraCols: Record<string, unknown> = {}
): Promise<void> {
  if (!supabase) return;
  const { data } = await supabase.from("loans").select("metadata").eq("id", loanId).maybeSingle();
  const current = (data?.metadata as Record<string, unknown>) ?? {};
  await supabase
    .from("loans")
    .update({ metadata: { ...current, ...patch }, ...extraCols })
    .eq("id", loanId);
}

// ─── Core run ─────────────────────────────────────────────────────────────────

/**
 * Query loans that are live (active/funded) and already past their due date.
 */
async function queryOverdueLoans(
  supabase: NonNullable<ReturnType<typeof getServiceRoleClient>>,
  nowIso: string
): Promise<LoanRow[]> {
  const { data, error } = await supabase
    .from("loans")
    .select(
      "id, borrower_id, status, principal_amount, repaid_amount, due_at, defaulted_at, metadata"
    )
    .in("status", ["active", "funded"])
    .not("due_at", "is", null)
    .lt("due_at", nowIso);

  if (error) throw new Error(`Failed to query overdue loans: ${error.message}`);
  return (data ?? []) as LoanRow[];
}

export async function runDefaultManagement(): Promise<DefaultRunResult> {
  const supabase = getServiceRoleClient();
  if (!supabase) throw new Error("Service role client unavailable (check SUPABASE_SERVICE_ROLE_KEY)");

  const ledgerTimeSecs = await getLedgerTimeSecs();
  const ledgerIso = new Date(ledgerTimeSecs * 1000).toISOString();

  const signer = getAdminKeypair();
  const onchainReady = Boolean(signer && LENDING_ID && DEFAULT_ID && ADMIN_ADDRESS);
  if (!onchainReady) {
    console.warn(
      "[default-mgmt] On-chain signing not configured " +
        "(ADMIN_SECRET_KEY / contract IDs missing) — DB state will update, contract calls skipped."
    );
  }

  const loans = await queryOverdueLoans(supabase, ledgerIso);

  const result: DefaultRunResult = {
    ledgerTime: ledgerIso,
    scanned: loans.length,
    defaulted: 0,
    payoutsProposed: 0,
    failed: 0,
    outcomes: [],
  };

  for (const loan of loans) {
    const outcome: LoanOutcome = {
      loanId: loan.id,
      onchainLoanId: null,
      daysOverdue: 0,
      actions: [],
    };

    try {
      const daysOverdue = loan.due_at
        ? computeDaysOverdue(loan.due_at, ledgerTimeSecs)
        : 0;
      outcome.daysOverdue = daysOverdue;

      if (daysOverdue <= GRACE_PERIOD_DAYS) {
        outcome.skipped = `within grace period (${daysOverdue}/${GRACE_PERIOD_DAYS} days)`;
        result.outcomes.push(outcome);
        continue;
      }

      const meta = loan.metadata ?? {};
      const alreadyDefaulted = Boolean(loan.defaulted_at) || Boolean(meta.defaulted_onchain_at);
      const alreadyProposedPayout = Boolean(meta.insurance_payout_proposed_at);

      const { lenderAddress, onchainLoanId } = await getFundingInfo(supabase, loan.id, meta);
      outcome.onchainLoanId = onchainLoanId;
      const borrowerWallet = await getWallet(supabase, loan.borrower_id);
      const amountStroops = xlmToStroops(outstandingXlm(loan));

      // ── 1 + 2: mark defaulted & record the phase ─────────────────────────────
      if (!alreadyDefaulted) {
        if (onchainReady && onchainLoanId && borrowerWallet) {
          await markDefaultedOnChain(
            signer!,
            onchainLoanId,
            borrowerWallet,
            amountStroops,
            daysOverdue
          );
          outcome.actions.push("mark_defaulted", "record_default");
        } else if (onchainReady) {
          outcome.actions.push("skipped on-chain default (missing onchain id / wallet)");
        }
        await setLoanMetadataFlag(
          supabase,
          loan.id,
          { defaulted_onchain_at: ledgerIso, days_overdue: daysOverdue },
          { status: "defaulted", defaulted_at: ledgerIso }
        );
        outcome.actions.push("db:status=defaulted");
        result.defaulted++;
      }

      // ── 3: propose an insurance payout once past the insurance threshold ─────
      // Multisig-gated (issue #73) — this only PROPOSES the payout; a human
      // must still approve + execute on the MultiSigAdmin contract before any
      // funds move. See the module doc comment above.
      if (daysOverdue >= INSURANCE_PAYOUT_DAYS && !alreadyProposedPayout) {
        if (onchainReady && MULTISIG_ADMIN_ID && onchainLoanId && lenderAddress) {
          const proposalId = await proposeInsurancePayout(
            signer!,
            onchainLoanId,
            lenderAddress,
            amountStroops
          );
          outcome.actions.push("propose:trigger_insurance_payout");
          await setLoanMetadataFlag(supabase, loan.id, {
            insurance_payout_proposed_at: ledgerIso,
            insurance_payout_proposal_id: proposalId,
            insurance_amount_stroops: amountStroops.toString(),
            insurance_lender: lenderAddress,
          });
          outcome.actions.push("db:insurance_payout_proposed");
          result.payoutsProposed++;
        } else {
          outcome.actions.push(
            `payout proposal deferred (${
              onchainReady
                ? MULTISIG_ADMIN_ID
                  ? "missing lender/onchain id"
                  : "NEXT_PUBLIC_MULTISIG_ADMIN_CONTRACT_ID not configured"
                : "on-chain not configured"
            })`
          );
        }
      }

      result.outcomes.push(outcome);
      console.log(`[default-mgmt] loan ${loan.id} (${daysOverdue}d): ${outcome.actions.join(", ")}`);
    } catch (err) {
      result.failed++;
      outcome.error = err instanceof Error ? err.message : String(err);
      result.outcomes.push(outcome);
      console.error(`[default-mgmt] loan ${loan.id} failed:`, outcome.error);
    }
  }

  return result;
}

// ─── On-chain actions ───────────────────────────────────────────────────────────

async function markDefaultedOnChain(
  signer: Keypair,
  onchainLoanId: number,
  borrowerWallet: string,
  amountStroops: bigint,
  daysOverdue: number
): Promise<void> {
  // 1. Flip the loan to Defaulted on the lending contract.
  await invokeSigned({
    contractId: LENDING_ID!,
    method: "mark_defaulted",
    args: [addr(ADMIN_ADDRESS!), u32(onchainLoanId)],
    signer,
  });
  // 2. Record the default phase on the default-management contract.
  await invokeSigned({
    contractId: DEFAULT_ID!,
    method: "record_default",
    args: [
      addr(ADMIN_ADDRESS!),
      u32(onchainLoanId),
      addr(borrowerWallet),
      i128(amountStroops),
      u64(daysOverdue),
    ],
    signer,
  });
}

/**
 * Propose (NOT execute) an insurance payout on the MultiSigAdmin contract.
 * `trigger_insurance_payout` only accepts calls from the registered multisig
 * — this automation's key must itself be one of that multisig's signers, so
 * proposing here counts as its own first approval. A human still has to
 * gather the remaining approvals and call `execute` before funds move.
 */
async function proposeInsurancePayout(
  signer: Keypair,
  onchainLoanId: number,
  lenderWallet: string,
  amountStroops: bigint
): Promise<number> {
  const action = tupleEnumToScVal("TriggerInsurancePayout", [
    addr(DEFAULT_ID!),
    u32(onchainLoanId),
    addr(lenderWallet),
    i128(amountStroops),
  ]);
  const result = await invokeSigned({
    contractId: MULTISIG_ADMIN_ID!,
    method: "propose",
    args: [addr(ADMIN_ADDRESS!), action],
    signer,
  });
  return Number(result.returnValue);
}
