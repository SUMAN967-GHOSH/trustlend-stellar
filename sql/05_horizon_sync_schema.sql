create table if not exists public.horizon_sync_state (
  id text primary key,
  last_synced_ledger integer not null default 0,
  last_synced_cursor text,
  last_synced_at timestamptz,
  consecutive_failures integer not null default 0,
  last_error text,
  updated_at timestamptz not null default now()
);

create index if not exists idx_horizon_sync_state_updated_at on public.horizon_sync_state(updated_at desc);

create table if not exists public.indexer_health (
  id boolean primary key default true,
  last_successful_check timestamptz,
  last_failed_check timestamptz,
  consecutive_failures integer not null default 0,
  is_degraded boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint indexer_health_single_row check (id = true)
);

drop trigger if exists trg_horizon_sync_state_updated_at on public.horizon_sync_state;
create trigger trg_horizon_sync_state_updated_at
before update on public.horizon_sync_state
for each row execute function public.set_updated_at();

drop trigger if exists trg_indexer_health_updated_at on public.indexer_health;
create trigger trg_indexer_health_updated_at
before update on public.indexer_health
for each row execute function public.set_updated_at();

insert into public.indexer_health (id) values (true)
on conflict (id) do nothing;

alter table public.chain_events
  add column if not exists ledger integer;

create index if not exists idx_chain_events_ledger on public.chain_events(ledger);

alter table public.loans
  add column if not exists contract_loan_id text;

create unique index if not exists idx_loans_contract_loan_id on public.loans(contract_loan_id);
