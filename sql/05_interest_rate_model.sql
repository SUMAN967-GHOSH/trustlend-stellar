-- =========================
-- Interest Rate Model Support (Issue #114)
-- =========================
-- Adds support for fixed vs floating interest rate models per loan.
-- Backward-compatible: all existing loans default to 'fixed'.

-- 1. Add rate_model column (fixed or floating)
alter table public.loans
  add column if not exists rate_model text not null default 'fixed'
  check (rate_model in ('fixed', 'floating'));

-- 2. Track rate model switch history
alter table public.loans
  add column if not exists rate_switch_count integer not null default 0;

alter table public.loans
  add column if not exists last_rate_switch_at timestamptz;

-- 3. Index for querying loans by rate model
create index if not exists idx_loans_rate_model on public.loans(rate_model);

-- 4. Comment for documentation
comment on column public.loans.rate_model is
  'Interest rate model: fixed (locked at creation) or floating (dynamic based on pool utilization)';
comment on column public.loans.rate_switch_count is
  'Number of times the borrower has switched between fixed and floating rates';
comment on column public.loans.last_rate_switch_at is
  'Timestamp of the most recent rate model switch (enforces 24h cooldown)';
