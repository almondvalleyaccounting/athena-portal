-- 193_journal_recon_findings.sql
--
-- Where the BrightPay journal control check records what it found.
--
-- Findings are RAISED here and adjudicated by a human. Nothing in this schema
-- is ever acted on automatically: no journal is reversed, amended or reposted
-- by any process reading these rows. See CONTROL-CHECK-HANDOVER.md §2 in the
-- runner repo for the division of duties.

create table if not exists public.journal_recon_runs (
  id             bigserial primary key,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  window_start   date not null,
  window_end     date not null,
  realms_checked int not null default 0,
  realms_error   int not null default 0,
  findings_count int not null default 0,
  trigger        text
);

create table if not exists public.journal_recon_findings (
  id           bigserial primary key,
  run_id       bigint references public.journal_recon_runs(id) on delete cascade,
  realm_id     text not null,
  company_name text,
  employer     text,
  task_id      bigint,
  kind         text not null,
  severity     text not null default 'medium',
  period       text,
  detail       text not null,
  data         jsonb,
  status       text not null default 'open',
  adjudicated_by uuid references auth.users(id),
  adjudicated_at timestamptz,
  note         text,
  created_at   timestamptz not null default now(),
  check (severity in ('high','medium','low')),
  check (status in ('open','accepted','dismissed','resolved'))
);

-- kinds in use:
--   duplicate             two+ identical BrightPay journals (same date, same total)
--   missing               task says posted, no journal in the period
--   amount_mismatch       journals found but the total disagrees with the task
--   unbalanced            debits <> credits on a single journal
--   unverifiable_amount   journal exists but the task recorded no amount
--   orphan                BrightPay journal outside every recorded task period
--   uncategorised_account journal posts to an Uncategorised nominal
--   ea_not_posted         Employment Allowance known unposted (no mapping)
--   unmatched_employer    realm maps to no payroll employer
--   ambiguous_employer    realm maps to more than one
--   check_failed          the check itself could not run for that client

create index if not exists jrf_run_idx   on public.journal_recon_findings (run_id);
create index if not exists jrf_realm_idx on public.journal_recon_findings (realm_id);
create index if not exists jrf_open_idx  on public.journal_recon_findings (status) where status = 'open';

alter table public.journal_recon_runs     enable row level security;
alter table public.journal_recon_findings enable row level security;

-- Staff who can view reports may read findings and adjudicate them.
-- Service role (the sweep) bypasses RLS and does the writing.
drop policy if exists jrr_staff_read on public.journal_recon_runs;
create policy jrr_staff_read on public.journal_recon_runs for select
  to authenticated
  using (exists (select 1 from public.staff_profiles sp where sp.id = auth.uid() and sp.can_view_reports));

drop policy if exists jrf_staff_read on public.journal_recon_findings;
create policy jrf_staff_read on public.journal_recon_findings for select
  to authenticated
  using (exists (select 1 from public.staff_profiles sp where sp.id = auth.uid() and sp.can_view_reports));

drop policy if exists jrf_staff_adjudicate on public.journal_recon_findings;
create policy jrf_staff_adjudicate on public.journal_recon_findings for update
  to authenticated
  using (exists (select 1 from public.staff_profiles sp where sp.id = auth.uid() and sp.can_view_reports))
  with check (exists (select 1 from public.staff_profiles sp where sp.id = auth.uid() and sp.can_view_reports));

comment on table public.journal_recon_findings is
  'Discrepancies between what the BrightPay runner recorded and what actually landed in a client QuickBooks. Raised by qbo-journal-recon; adjudicated and corrected by a human. Nothing here is acted on automatically.';
