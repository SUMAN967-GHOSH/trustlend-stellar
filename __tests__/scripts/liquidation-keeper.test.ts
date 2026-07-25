import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the server-side Soroban invoker ────────────────────────────────────────
const mockInvokeReadOnly = vi.fn();
const mockInvokeSigned = vi.fn();
const mockGetAdminKeypair = vi.fn();

vi.mock("@/lib/stellar/server-contract", () => ({
  addr: (g: string) => ({ addr: g }),
  u32: (n: number) => ({ u32: n }),
  getAdminKeypair: () => mockGetAdminKeypair(),
  invokeReadOnly: (...args: unknown[]) => mockInvokeReadOnly(...args),
  invokeSigned: (...args: unknown[]) => mockInvokeSigned(...args),
}));

// ── Mock Supabase (used only in --source=db) ────────────────────────────────────
const mockFrom = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: mockFrom }),
}));

import {
  computeLtvBps,
  shouldLiquidate,
  resolveAssetPrice,
  sendAlert,
  loadConfig,
  runLiquidationKeeper,
  type KeeperConfig,
} from "@/scripts/liquidation-keeper";

const BASE_CFG: KeeperConfig = {
  source: "chain",
  dryRun: false,
  intervalSecs: null,
  lendingContractId: "CLENDING",
  reputationContractId: "CREPUTATION",
  adminAddress: "GADMIN",
  xlmPriceUsd: 0.1,
  priceTable: {
    GCOLLATERAL: { symbol: "USDC", priceUsd: 1, decimals: 7 },
  },
  defaultAssetVolatilityBps: 2000,
};

// ── computeLtvBps (pure) ─────────────────────────────────────────────────────────

describe("computeLtvBps", () => {
  it("computes a healthy LTV correctly", () => {
    // debt = 100 XLM * $0.1 = $10; collateral = 100 USDC * $1 = $100 → LTV = 10%
    const bps = computeLtvBps({
      remainingDueStroops: 100n * 10_000_000n,
      xlmPriceUsd: 0.1,
      collateralAmount: 100n * 10_000_000n,
      collateralDecimals: 7,
      collateralPriceUsd: 1,
    });
    expect(bps).toBe(1000); // 10.00%
  });

  it("returns MAX_SAFE_INTEGER when collateral value is zero", () => {
    const bps = computeLtvBps({
      remainingDueStroops: 100n * 10_000_000n,
      xlmPriceUsd: 0.1,
      collateralAmount: 0n,
      collateralDecimals: 7,
      collateralPriceUsd: 1,
    });
    expect(bps).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("flags a severely under-collateralized loan with a very high LTV", () => {
    const bps = computeLtvBps({
      remainingDueStroops: 1_000n * 10_000_000n,
      xlmPriceUsd: 0.1,
      collateralAmount: 10n * 10_000_000n,
      collateralDecimals: 7,
      collateralPriceUsd: 1,
    });
    // debt = $100, collateral = $10 → LTV = 1000%
    expect(bps).toBe(100_000);
  });
});

// ── shouldLiquidate (pure) ────────────────────────────────────────────────────────

describe("shouldLiquidate", () => {
  it("liquidates when LTV exceeds threshold", () => {
    expect(shouldLiquidate(8500, 8000)).toBe(true);
  });
  it("liquidates exactly at the threshold boundary", () => {
    expect(shouldLiquidate(8000, 8000)).toBe(true);
  });
  it("does not liquidate a healthy loan", () => {
    expect(shouldLiquidate(5000, 8000)).toBe(false);
  });
});

// ── resolveAssetPrice (pure) ───────────────────────────────────────────────────────

describe("resolveAssetPrice", () => {
  it("shortcuts XLM/native to the configured XLM price", () => {
    expect(resolveAssetPrice(BASE_CFG, "XLM")).toEqual({ symbol: "XLM", priceUsd: 0.1, decimals: 7 });
    expect(resolveAssetPrice(BASE_CFG, "native")).toEqual({ symbol: "XLM", priceUsd: 0.1, decimals: 7 });
  });

  it("looks up a configured collateral asset by address", () => {
    expect(resolveAssetPrice(BASE_CFG, "GCOLLATERAL")).toEqual({
      symbol: "USDC",
      priceUsd: 1,
      decimals: 7,
    });
  });

  it("returns null for an unconfigured asset instead of guessing", () => {
    expect(resolveAssetPrice(BASE_CFG, "GUNKNOWN")).toBeNull();
  });
});

// ── sendAlert ──────────────────────────────────────────────────────────────────────

describe("sendAlert", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does nothing when no webhooks are configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await sendAlert({}, "info", "hello");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to both Slack and Discord when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await sendAlert(
      { slackWebhookUrl: "https://slack.example/hook", discordWebhookUrl: "https://discord.example/hook" },
      "info",
      "Liquidated loan #1"
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [slackUrl, slackOpts] = fetchMock.mock.calls[0];
    expect(slackUrl).toBe("https://slack.example/hook");
    expect(JSON.parse(slackOpts.body).text).toContain("Liquidated loan #1");

    const [discordUrl, discordOpts] = fetchMock.mock.calls[1];
    expect(discordUrl).toBe("https://discord.example/hook");
    expect(JSON.parse(discordOpts.body).content).toContain("Liquidated loan #1");
  });

  it("swallows webhook delivery failures without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(
      sendAlert({ slackWebhookUrl: "https://slack.example/hook" }, "error", "boom")
    ).resolves.toBeUndefined();
  });
});

// ── loadConfig ─────────────────────────────────────────────────────────────────────

describe("loadConfig", () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to db source, one-shot, no dry-run", () => {
    const cfg = loadConfig([]);
    expect(cfg.source).toBe("db");
    expect(cfg.dryRun).toBe(false);
    expect(cfg.intervalSecs).toBeNull();
  });

  it("CLI flags override env / defaults", () => {
    const cfg = loadConfig(["--source=chain", "--dry-run", "--interval=30"]);
    expect(cfg.source).toBe("chain");
    expect(cfg.dryRun).toBe(true);
    expect(cfg.intervalSecs).toBe(30);
  });

  it("rejects an invalid --source value", () => {
    expect(() => loadConfig(["--source=bogus"])).toThrow(/Invalid --source/);
  });

  it("parses a valid LIQUIDATION_PRICE_TABLE_JSON", () => {
    process.env.LIQUIDATION_PRICE_TABLE_JSON = JSON.stringify({
      GXYZ: { symbol: "XYZ", priceUsd: 2, decimals: 7 },
    });
    const cfg = loadConfig([]);
    expect(cfg.priceTable.GXYZ).toEqual({ symbol: "XYZ", priceUsd: 2, decimals: 7 });
  });

  it("falls back to an empty price table on malformed JSON instead of crashing", () => {
    process.env.LIQUIDATION_PRICE_TABLE_JSON = "{not json";
    const cfg = loadConfig([]);
    expect(cfg.priceTable).toEqual({});
  });
});

// ── runLiquidationKeeper (orchestration) ────────────────────────────────────────────

function scValLoan(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    borrower: "GBORROWER",
    status: { Active: {} },
    remaining_due: (100n * 10_000_000n).toString(),
    collateral_asset: "GCOLLATERAL",
    collateral_amount: (10n * 10_000_000n).toString(), // deliberately thin — triggers liquidation
    ...overrides,
  };
}

describe("runLiquidationKeeper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAdminKeypair.mockReturnValue({} as never);
  });

  it("liquidates an under-collateralized loan (chain source)", async () => {
    mockInvokeReadOnly
      .mockResolvedValueOnce(1) // get_loan_count
      .mockResolvedValueOnce(scValLoan()) // get_loan
      .mockResolvedValueOnce(500) // get_reputation_score
      .mockResolvedValueOnce(8000); // calculate_liquidation_threshold
    mockInvokeSigned.mockResolvedValueOnce({ hash: "abc123", returnValue: null });

    const cfg: KeeperConfig = { ...BASE_CFG, source: "chain" };
    const summary = await runLiquidationKeeper(cfg, {} as never);

    expect(summary.scanned).toBe(1);
    expect(summary.liquidated).toBe(1);
    expect(mockInvokeSigned).toHaveBeenCalledOnce();
    const call = mockInvokeSigned.mock.calls[0][0] as { method: string };
    expect(call.method).toBe("mark_defaulted");
  });

  it("does not submit anything in dry-run mode", async () => {
    mockInvokeReadOnly
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(scValLoan())
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(8000);

    const cfg: KeeperConfig = { ...BASE_CFG, source: "chain", dryRun: true };
    const summary = await runLiquidationKeeper(cfg, null);

    expect(summary.liquidated).toBe(1);
    expect(mockInvokeSigned).not.toHaveBeenCalled();
  });

  it("leaves a healthy loan alone", async () => {
    mockInvokeReadOnly
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(
        scValLoan({ collateral_amount: (1_000n * 10_000_000n).toString() }) // well collateralized
      )
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(8000);

    const cfg: KeeperConfig = { ...BASE_CFG, source: "chain" };
    const summary = await runLiquidationKeeper(cfg, {} as never);

    expect(summary.healthy).toBe(1);
    expect(summary.liquidated).toBe(0);
    expect(mockInvokeSigned).not.toHaveBeenCalled();
  });

  it("skips a non-Active loan", async () => {
    mockInvokeReadOnly.mockResolvedValueOnce(1).mockResolvedValueOnce(scValLoan({ status: { Repaid: {} } }));

    const cfg: KeeperConfig = { ...BASE_CFG, source: "chain" };
    const summary = await runLiquidationKeeper(cfg, {} as never);

    expect(summary.skipped).toBe(1);
    expect(mockInvokeSigned).not.toHaveBeenCalled();
  });

  it("skips a loan whose collateral asset has no configured price", async () => {
    mockInvokeReadOnly
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(scValLoan({ collateral_asset: "GUNPRICED" }));

    const cfg: KeeperConfig = { ...BASE_CFG, source: "chain" };
    const summary = await runLiquidationKeeper(cfg, {} as never);

    expect(summary.skipped).toBe(1);
  });

  it("records a failure without aborting the whole run", async () => {
    mockInvokeReadOnly.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error("RPC down"));

    const cfg: KeeperConfig = { ...BASE_CFG, source: "chain" };
    const summary = await runLiquidationKeeper(cfg, {} as never);

    expect(summary.failed).toBe(1);
  });

  it("throws clearly when trying to submit without a signer", async () => {
    mockInvokeReadOnly
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(scValLoan())
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(8000);

    const cfg: KeeperConfig = { ...BASE_CFG, source: "chain", dryRun: false };
    const summary = await runLiquidationKeeper(cfg, null);

    expect(summary.failed).toBe(1);
    expect(mockInvokeSigned).not.toHaveBeenCalled();
  });

  it("resolves candidate loans from Supabase when source=db", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { metadata: { onchainLoanId: 7 } },
      }),
    };
    // The initial `.in(...)` query resolves via awaiting the chain itself.
    Object.defineProperty(chain, "then", {
      get() {
        return (resolve: (v: unknown) => void) => resolve({ data: [{ id: "db-loan-1" }], error: null });
      },
    });
    mockFrom.mockReturnValue(chain);

    mockInvokeReadOnly
      .mockResolvedValueOnce(scValLoan({ id: 7 }))
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(8000);
    mockInvokeSigned.mockResolvedValueOnce({ hash: "xyz", returnValue: null });

    const cfg: KeeperConfig = {
      ...BASE_CFG,
      source: "db",
      supabaseUrl: "https://x.supabase.co",
      supabaseServiceKey: "svc",
    };
    const summary = await runLiquidationKeeper(cfg, {} as never);

    expect(summary.scanned).toBe(1);
    expect(summary.liquidated).toBe(1);
  });
});
