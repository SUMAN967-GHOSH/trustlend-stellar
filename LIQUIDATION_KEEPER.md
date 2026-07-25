# Liquidation Keeper

> Implements issue **#72 — Add automatic re-balancing script for lending pool liquidations**

`scripts/liquidation-keeper.ts` is an automated bot that finds under-collateralized
loans and liquidates them on-chain before they become bad debt.

## Flow

1. **Fetch open loans** — either `--source=db` (Supabase `loans` table, resolving the
   on-chain loan id from the funding ledger entry) or `--source=chain` (iterates the
   LendingContract directly via `get_loan_count`/`get_loan`).
2. **Read authoritative on-chain state** — collateral + remaining debt from
   `lending.get_loan`, the borrower's `reputation.get_reputation_score`, and the
   contract's own dynamic `lending.calculate_liquidation_threshold`.
3. **Price the position** — debt is always XLM; collateral price/decimals come from
   `LIQUIDATION_PRICE_TABLE_JSON` (or an on-chain oracle, if wired in later). Unpriced
   assets are skipped and logged, never guessed.
4. **Liquidate** — if `LTV bps >= threshold bps`, submits `lending.mark_defaulted`
   signed by `ADMIN_SECRET_KEY`.
5. **Alert** — posts to Slack/Discord webhooks on every liquidation and every failure.

## Usage

```bash
npm run liquidation:keeper                     # one-shot (cron)
npm run liquidation:keeper -- --dry-run          # evaluate only
npm run liquidation:keeper -- --source=chain
npm run liquidation:keeper -- --interval=60      # background service
```

Config is documented in `.env.example` (`LIQUIDATION_*` section). Every step is
individually error-handled — one bad loan never aborts the run — matching the
`default-management` scheduler's conventions.

## Tests

`__tests__/scripts/liquidation-keeper.test.ts` — 25 tests covering the pure LTV/
threshold math, alert delivery (incl. webhook failure isolation), CLI/env config
parsing, and full run orchestration (liquidate, dry-run, healthy, skipped, failed,
both `db` and `chain` sources).
