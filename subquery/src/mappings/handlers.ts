// TrustLend — SubQuery Soroban Event Mapping Handlers
//
// Maps on-chain Soroban contract events to the GraphQL entities defined in
// schema.graphql. Handles events from three contracts:
//   - Lending Contract  (loans, payments, defaults)
//   - Reputation Contract (scores, oracle updates, freezes)
//   - Escrow Contract  (deposits, withdrawals, transfers)
//
// Event topic formats follow the conventions in SOROBAN_INDEXER_MIGRATION.md.
//
// Amounts emitted by Soroban contracts are in stroops (1 XLM = 10_000_000 stroops).
// The read-model layer (lib/indexer/read-model.ts) converts them to XLM for display.

import type {
  SorobanEvent,
  Store,
} from "@subql/types-stellar";
import { BigNumber } from "ethers";

// ─── Type helpers ────────────────────────────────────────────────────────────

/** Decode a Soroban ScVal address to a G... string. */
function addressToString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "contractId" in (raw as Record<string, unknown>)) {
    return (raw as Record<string, unknown>).contractId as string;
  }
  return String(raw ?? "");
}

/** Decode an i128 ScVal to a BigNumber. */
function toBigNumber(raw: unknown): BigNumber {
  if (typeof raw === "bigint") return BigNumber.from(raw.toString());
  if (typeof raw === "number") return BigNumber.from(raw);
  if (typeof raw === "string") return BigNumber.from(raw);
  return BigNumber.from(0);
}

/** Decode a u32 ScVal to a number. */
function toNumber(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "string") return parseInt(raw, 10);
  return Number(raw ?? 0);
}

/** Decode a symbol ScVal to a string. */
function symbolToString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "symbol" in (raw as Record<string, unknown>)) {
    return (raw as Record<string, unknown>).symbol as string;
  }
  return String(raw ?? "");
}

// ─── Dispatch Handlers (exported — match project.yaml handler names) ───────

/**
 * Dispatch handler for all Lending contract events.
 * Registered in project.yaml as `handleLendingEvent` with filter contractId
 * = NEXT_PUBLIC_LENDING_CONTRACT_ID and topic prefix "loan".
 * Routes to sub-handlers based on the second topic element.
 */
export async function handleLendingEvent(event: SorobanEvent): Promise<void> {
  const { topic, data, ledger } = event;
  const eventType = symbolToString(topic[1] ?? "");
  const params = extractParams(data);

  switch (eventType) {
    case "request":
      await handleLoanRequested(ledger, params);
      break;
    case "approved":
      await handleLoanApproved(params);
      break;
    case "revoked":
      await handleLoanRevoked(params);
      break;
    case "active":
      await handleLoanActivated(params);
      break;
    case "payment":
      await handleLoanPayment(params);
      break;
    case "default":
      await handleLoanDefaulted(ledger, params);
      break;
    default:
      logger.warn(`[lending] Unknown event type: ${eventType}`);
  }
}

/**
 * Dispatch handler for all Reputation contract events.
 * Registered in project.yaml as `handleReputationEvent` with filter
 * contractId = NEXT_PUBLIC_REPUTATION_CONTRACT_ID.
 */
export async function handleReputationEvent(event: SorobanEvent): Promise<void> {
  const { topic, data } = event;
  const eventType = symbolToString(topic[0] ?? "");
  const subType = symbolToString(topic[1] ?? "");
  const params = extractParams(data);

  const compoundType = `${eventType}.${subType}`;

  switch (compoundType) {
    case "oracle.set":
      await handleOracleSet(params);
      break;
    case "oracle.score":
      await handleOracleScore(params);
      break;
    case "rep.event":
      await handleRepEvent(params);
      break;
    case "rep.totals":
      await handleRepTotals(params);
      break;
    case "rep.freeze":
      await handleRepFreeze(params);
      break;
    default:
      logger.warn(`[reputation] Unknown event type: ${compoundType}`);
  }
}

/**
 * Dispatch handler for all Escrow contract events.
 * Registered in project.yaml as `handleEscrowEvent` with filter
 * contractId = NEXT_PUBLIC_ESCROW_CONTRACT_ID.
 */
export async function handleEscrowEvent(event: SorobanEvent): Promise<void> {
  const { topic, data, ledger } = event;
  const eventType = symbolToString(topic[1] ?? "");
  const params = extractParams(data);

  switch (eventType) {
    case "deposit":
      await handleEscrowDeposit(ledger, params);
      break;
    case "withdraw":
      await handleEscrowWithdraw(params);
      break;
    case "transfer":
      await handleEscrowTransfer(params);
      break;
    default:
      logger.warn(`[escrow] Unknown event type: ${eventType}`);
  }
}

// ─── Sub-handlers: Lending ────────────────────────────────────────────────────

/**
 * Handle `(loan, request)` — (loan_id, borrower, amount, duration_days,
 * interest_rate_bps, total_due, due_at)
 */
async function handleLoanRequested(
  ledger: { sequence: number; timestamp?: number },
  params: unknown[],
): Promise<void> {
  const loanId = toNumber(params[0]);
  const borrower = addressToString(params[1]);
  const amount = toBigNumber(params[2]);
  const durationDays = toNumber(params[3]);
  const interestRateBps = toNumber(params[4]);
  const totalDue = toBigNumber(params[5]);

  await store.set(
    "Borrow",
    `${ledger.sequence}-${loanId}`,
    {
      id: `${ledger.sequence}-${loanId}`,
      loanId: loanId.toString(),
      borrowerAddress: borrower,
      amount,
      durationDays,
      interestRateBps,
      totalDue,
      ledgerHeight: ledger.sequence,
      timestamp: new Date(ledger.timestamp ?? Date.now()),
    },
  );

  logger.info(`[loan] Requested #${loanId} by ${borrower.slice(0, 6)}…`);
}

async function handleLoanApproved(params: unknown[]): Promise<void> {
  const loanId = toNumber(params[0]);
  const lender = addressToString(params[1]);
  const escrowId = toNumber(params[2]);
  logger.info(`[loan] Approved #${loanId} by ${lender.slice(0, 6)}… (escrow #${escrowId})`);
}

async function handleLoanRevoked(params: unknown[]): Promise<void> {
  const loanId = toNumber(params[0]);
  logger.info(`[loan] Revoked #${loanId}`);
}

async function handleLoanActivated(params: unknown[]): Promise<void> {
  const loanId = toNumber(params[0]);
  logger.info(`[loan] Activated #${loanId}`);
}

async function handleLoanPayment(params: unknown[]): Promise<void> {
  const loanId = toNumber(params[0]);
  const amount = toBigNumber(params[1]);
  const remainingDue = toBigNumber(params[2]);
  const status = symbolToString(params[3]);
  logger.info(`[loan] Payment #${loanId}: ${amount.toString()} stroops, status=${status}`);
}

async function handleLoanDefaulted(
  ledger: { sequence: number; timestamp?: number },
  params: unknown[],
): Promise<void> {
  const loanId = toNumber(params[0]);

  await store.set(
    "Liquidation",
    `liq-${ledger.sequence}-${loanId}`,
    {
      id: `liq-${ledger.sequence}-${loanId}`,
      loanId: loanId.toString(),
      borrowerAddress: "",
      liquidatorAddress: "",
      repaidAmount: BigNumber.from(0),
      collateralSeized: BigNumber.from(0),
      ledgerHeight: ledger.sequence,
      timestamp: new Date(ledger.timestamp ?? Date.now()),
    },
  );

  logger.info(`[loan] Defaulted #${loanId}`);
}

// ─── Sub-handlers: Reputation ───────────────────────────────────────────────

async function handleOracleSet(params: unknown[]): Promise<void> {
  const oracle = addressToString(params[0]);
  logger.info(`[rep] Oracle set to ${oracle.slice(0, 6)}…`);
}

async function handleOracleScore(params: unknown[]): Promise<void> {
  const borrower = addressToString(params[0]);
  const creditScore = toNumber(params[1]);
  const boostBps = toNumber(params[2]);
  logger.info(`[rep] Oracle score for ${borrower.slice(0, 6)}…: ${creditScore} (boost ${boostBps} bps)`);
}

async function handleRepEvent(params: unknown[]): Promise<void> {
  const borrower = addressToString(params[0]);
  const eventType = symbolToString(params[1]);
  const delta = toBigNumber(params[2]);
  const newScore = toBigNumber(params[3]);
  logger.info(`[rep] Event ${eventType} for ${borrower.slice(0, 6)}…: delta=${delta.toString()} score=${newScore.toString()}`);
}

async function handleRepTotals(params: unknown[]): Promise<void> {
  const borrower = addressToString(params[0]);
  const borrowedDelta = toBigNumber(params[1]);
  const repaidDelta = toBigNumber(params[2]);
  logger.info(`[rep] Totals for ${borrower.slice(0, 6)}…: borrowed=${borrowedDelta.toString()} repaid=${repaidDelta.toString()}`);
}

async function handleRepFreeze(params: unknown[]): Promise<void> {
  const borrower = addressToString(params[0]);
  const isFrozen = Boolean(params[1]);
  logger.info(`[rep] ${isFrozen ? "Froze" : "Unfroze"} ${borrower.slice(0, 6)}…`);
}

// ─── Sub-handlers: Escrow ───────────────────────────────────────────────────

async function handleEscrowDeposit(
  ledger: { sequence: number; timestamp?: number },
  params: unknown[],
): Promise<void> {
  const lender = addressToString(params[0]);
  const loanId = toNumber(params[1]);
  const amount = toBigNumber(params[2]);

  await store.set(
    "Deposit",
    `dep-${ledger.sequence}-${loanId}`,
    {
      id: `dep-${ledger.sequence}-${loanId}`,
      poolId: loanId.toString(),
      lenderAddress: lender,
      amount,
      ledgerHeight: ledger.sequence,
      timestamp: new Date(ledger.timestamp ?? Date.now()),
    },
  );

  logger.info(`[escrow] Deposit loan #${loanId} by ${lender.slice(0, 6)}…: ${amount.toString()} stroops`);
}

async function handleEscrowWithdraw(params: unknown[]): Promise<void> {
  const lender = addressToString(params[0]);
  const loanId = toNumber(params[1]);
  const amount = toBigNumber(params[2]);
  logger.info(`[escrow] Withdraw loan #${loanId} by ${lender.slice(0, 6)}…: ${amount.toString()} stroops`);
}

async function handleEscrowTransfer(params: unknown[]): Promise<void> {
  const escrowId = toNumber(params[0]);
  const loanId = toNumber(params[1]);
  const borrower = addressToString(params[2]);
  const amount = toBigNumber(params[3]);
  logger.info(`[escrow] Transfer escrow #${escrowId} loan #${loanId} to ${borrower.slice(0, 6)}…: ${amount.toString()} stroops`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the decoded ScVal parameters from a Soroban event's data payload.
 * Soroban events emit a Vec<ScVal>; each element in the array is one parameter.
 */
function extractParams(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    // Some indexer SDKs wrap the params in a `values` or `data` field
    if (Array.isArray(record.values)) return record.values;
    if (Array.isArray(record.data)) return record.data;
  }
  return [];
}

// ─── Re-export store and logger from SubQuery runtime ─────────────────────────
// These are injected by the SubQuery node at runtime.
declare const store: Store;
declare const logger: {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};
