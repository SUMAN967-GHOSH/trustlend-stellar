import {
  TransactionBuilder,
  BASE_FEE,
  Contract,
  Account,
  xdr,
  Address,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import type { CallContractOptions } from "@/lib/stellar/soroban";

export const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
  "https://soroban-testnet.stellar.org";

export const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ??
  "Test SDF Network ; September 2015";

export const HORIZON_URL =
  process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ??
  "https://horizon-testnet.stellar.org";

// ─── Simulation result type ────────────────────────────────────────────────

export interface SimulationResources {
  instructions: number;
  readBytes: number;
  writeBytes: number;
  ledgerFootprintEntries: number;
}

export interface SimulationResult {
  success: boolean;
  method: string;
  contractId: string;
  feeStroops: number;
  feeXlm: string;
  resources: SimulationResources;
  error?: string;
  returnValue?: unknown;
  latestLedger: number;
}

// ─── Encoding helpers (mirror soroban.ts) ──────────────────────────────────

function addressToScVal(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

function i128ToScVal(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "i128" });
}

function u32ToScVal(value: number): xdr.ScVal {
  return nativeToScVal(value, { type: "u32" });
}

function u64ToScVal(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "u64" });
}

function stringToScVal(value: string): xdr.ScVal {
  return nativeToScVal(value, { type: "string" });
}

function enumToScVal(variant: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant)]);
}

export function encodeArg(arg: unknown): xdr.ScVal {
  if (typeof arg === "string" && arg.startsWith("G") && arg.length === 56) {
    return addressToScVal(arg);
  }
  if (typeof arg === "bigint") {
    return i128ToScVal(arg);
  }
  if (typeof arg === "number" && Number.isInteger(arg)) {
    return u32ToScVal(arg);
  }
  if (typeof arg === "number") {
    return nativeToScVal(arg);
  }
  if (arg instanceof xdr.ScVal) {
    return arg;
  }
  if (typeof arg === "boolean") {
    return nativeToScVal(arg);
  }
  if (typeof arg === "string") {
    return stringToScVal(arg);
  }
  return nativeToScVal(arg);
}

// ─── Raw JSON-RPC call ────────────────────────────────────────────────────

async function sorobanRpc<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(SOROBAN_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`Soroban RPC error (${method}): ${res.statusText}`);
  }
  const json = (await res.json()) as { result?: T; error?: unknown };
  if (json.error) {
    throw new Error(
      `Soroban RPC error (${method}): ${JSON.stringify(json.error)}`,
    );
  }
  return json.result as T;
}

// ─── Horizon sequence fetch ───────────────────────────────────────────────

async function getAccountSequence(address: string): Promise<string> {
  const res = await fetch(`${HORIZON_URL}/accounts/${address}`);
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `Account ${address} not found on Stellar network. Fund it at https://friendbot.stellar.org?addr=${address}.`,
      );
    }
    throw new Error(`Horizon account fetch failed: ${res.statusText}`);
  }
  const data = (await res.json()) as { sequence: string };
  return data.sequence;
}

// ─── Stroops → XLM ────────────────────────────────────────────────────────

const STROOPS_PER_XLM = 10_000_000;

function stroopsToXlm(stroops: number): string {
  return (stroops / STROOPS_PER_XLM).toFixed(7);
}

// ─── Main simulation function ─────────────────────────────────────────────

/**
 * Simulate a Soroban contract call and return parsed resource consumption
 * without requiring a wallet signature.
 *
 * Use this to show users a "Simulation Preview" before they sign.
 */
export async function simulatePreview(
  contractId: string,
  method: string,
  args: unknown[],
  callerAddress: string,
): Promise<SimulationResult> {
  const baseResult: Omit<SimulationResult, "success" | "error" | "resources"> =
    {
      method,
      contractId,
      feeStroops: 0,
      feeXlm: "0",
      latestLedger: 0,
    };

  let sequence: string;
  try {
    sequence = await getAccountSequence(callerAddress);
  } catch (err) {
    return {
      ...baseResult,
      success: false,
      error: (err as Error).message,
      resources: { instructions: 0, readBytes: 0, writeBytes: 0, ledgerFootprintEntries: 0 },
    };
  }

  const account = new Account(callerAddress, sequence);
  const contract = new Contract(contractId);
  const scValArgs = args.map(encodeArg);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...scValArgs))
    .setTimeout(30)
    .build();

  let simData: {
    error?: string;
    transactionData?: string;
    minResourceFee?: string;
    results?: Array<{ auth: string[]; xdr: string }>;
    latestLedger?: number;
  };

  try {
    simData = await sorobanRpc("simulateTransaction", {
      transaction: tx.toXDR(),
    });
  } catch (err) {
    return {
      ...baseResult,
      success: false,
      error: `RPC call failed: ${(err as Error).message}`,
      resources: { instructions: 0, readBytes: 0, writeBytes: 0, ledgerFootprintEntries: 0 },
    };
  }

  if (simData.error) {
    return {
      ...baseResult,
      success: false,
      error: simData.error,
      resources: { instructions: 0, readBytes: 0, writeBytes: 0, ledgerFootprintEntries: 0 },
      latestLedger: simData.latestLedger ?? 0,
    };
  }

  if (!simData.results?.length || !simData.transactionData) {
    return {
      ...baseResult,
      success: false,
      error: "Simulation returned no results — contract may not exist on this network.",
      resources: { instructions: 0, readBytes: 0, writeBytes: 0, ledgerFootprintEntries: 0 },
      latestLedger: simData.latestLedger ?? 0,
    };
  }

  const minResourceFee = Number(simData.minResourceFee ?? 0);
  const baseFee = Number(BASE_FEE);
  const totalFeeStroops = baseFee + minResourceFee;

  let resources: SimulationResources = {
    instructions: 0,
    readBytes: 0,
    writeBytes: 0,
    ledgerFootprintEntries: 0,
  };

  try {
    const txData = xdr.SorobanTransactionData.fromXDR(
      simData.transactionData,
      "base64",
    );
    const sorobanResources = txData.resources();
    resources = {
      instructions: sorobanResources.instructions(),
      readBytes: sorobanResources.readBytes(),
      writeBytes: sorobanResources.writeBytes(),
      ledgerFootprintEntries: sorobanResources.footprint().readWrite().length,
    };
  } catch {
    // If XDR parsing fails, proceed with zeroed resources
  }

  let returnValue: unknown;
  try {
    const { scValToNative } = await import("@stellar/stellar-sdk");
    const retvalXdr = simData.results[0].xdr;
    if (retvalXdr) {
      returnValue = scValToNative(xdr.ScVal.fromXDR(retvalXdr, "base64"));
    }
  } catch {
    // Ignore decoding errors on the return value
  }

  return {
    ...baseResult,
    success: true,
    feeStroops: totalFeeStroops,
    feeXlm: stroopsToXlm(totalFeeStroops),
    resources,
    returnValue,
    latestLedger: simData.latestLedger ?? 0,
  };
}
