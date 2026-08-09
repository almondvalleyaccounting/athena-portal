-- 192_payroll_recon_accessors.sql
--
-- Read-only accessors so Athena's control check (qbo-journal-recon) can see the
-- BrightPay runner's state, plus ONE narrow write.
--
-- Why functions rather than exposing the schema: PostgREST only serves the
-- schemas it is configured for, and adding `payroll` would publish the whole
-- runner state to the API surface. These SECURITY DEFINER functions in `public`
-- expose exactly the columns the check needs and nothing else.
--
-- Why the write is a function rather than an UPDATE grant: the payroll schema
-- owns its own invariants and its audit table is append-only. A foreign process
-- issuing arbitrary UPDATEs against payroll.task would break the single-writer
-- property that makes the state trustworthy. One narrow, auditable entry point
-- preserves it. See CONTROL-CHECK-HANDOVER.md in the runner repo, §4-5.
--
-- Grants: service_role only. The edge function runs as service_role and does
-- its own staff-permission check before calling these.

-- ── employers ──────────────────────────────────────────────────────
create or replace function public.payroll_recon_employers()
returns table (
  id                  bigint,
  sheet_name          text,
  brightpay_name      text,
  destination_company text,
  destination_realm   text,
  destination         text,
  active              boolean,
  post_journals       boolean
)
language sql
stable
security definer
set search_path = payroll, public
as $$
  select e.id, e.sheet_name, e.brightpay_name, e.destination_company,
         e.destination_realm, e.destination, e.active, e.post_journals
  from payroll.employer e
$$;

-- ── journal tasks in a window ──────────────────────────────────────
create or replace function public.payroll_recon_tasks(
  p_employer_id bigint,
  p_start       date,
  p_end         date
)
returns table (
  id           bigint,
  kind         text,
  state        text,
  period_start date,
  period_end   date,
  amount       numeric,
  ea_amount    numeric,
  ea_status    text,
  evidence     text,
  last_error   text
)
language sql
stable
security definer
set search_path = payroll, public
as $$
  select t.id, t.kind, t.state, t.period_start, t.period_end,
         t.amount, t.ea_amount, t.ea_status, t.evidence, t.last_error
  from payroll.task t
  where t.employer_id = p_employer_id
    and t.kind = 'journal'
    and t.period_start >= p_start
    and t.period_end   <= p_end
  order by t.period_start
$$;

-- ── the one narrow write: posted -> verified ───────────────────────
-- Refuses any other transition. Appends an audit row. Never touches amounts,
-- never moves a task backwards, never deletes.
create or replace function public.payroll_mark_verified(
  p_task_id  bigint,
  p_evidence text
)
returns text
language plpgsql
security definer
set search_path = payroll, public
as $$
declare
  v_state       text;
  v_employer_id bigint;
begin
  select state, employer_id into v_state, v_employer_id
  from payroll.task where id = p_task_id;

  if v_state is null then
    return 'not_found';
  end if;

  if v_state = 'verified' then
    return 'already_verified';
  end if;

  if v_state <> 'posted' then
    -- Only a posted task can be verified. Anything else is a state the runner
    -- owns and this process must not touch.
    return 'refused:' || v_state;
  end if;

  update payroll.task
     set state = 'verified',
         evidence = coalesce(p_evidence, evidence),
         updated_at = now()
   where id = p_task_id;

  insert into payroll.audit (task_id, employer_id, event, detail)
  values (p_task_id, v_employer_id, 'verified',
          coalesce(p_evidence, 'verified against QuickBooks by athena qbo-journal-recon'));

  return 'verified';
end;
$$;

-- ── grants ─────────────────────────────────────────────────────────
revoke all on function public.payroll_recon_employers()                 from public, anon, authenticated;
revoke all on function public.payroll_recon_tasks(bigint, date, date)   from public, anon, authenticated;
revoke all on function public.payroll_mark_verified(bigint, text)       from public, anon, authenticated;

grant execute on function public.payroll_recon_employers()               to service_role;
grant execute on function public.payroll_recon_tasks(bigint, date, date) to service_role;
grant execute on function public.payroll_mark_verified(bigint, text)     to service_role;

comment on function public.payroll_mark_verified(bigint, text) is
  'Promotes a payroll.task from posted to verified after Athena has confirmed the journal in QuickBooks. The ONLY write Athena may make into the payroll schema.';
