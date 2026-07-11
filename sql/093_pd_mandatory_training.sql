-- Mandatory training register for the CPD Tracker (AML, CTF, ...).
-- A firm-wide catalogue of required trainings, each with an optional renewal
-- period, plus per-staff completion records. Latest completion + renewal_months
-- drives the compliance status (valid / due soon / overdue / not recorded).

create table if not exists pd_mandatory_training (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  description    text,
  renewal_months int,                       -- null = one-off; else renews every N months
  active         boolean not null default true,
  display_order  int not null default 0,
  created_at     timestamptz not null default now()
);

insert into pd_mandatory_training (name, description, renewal_months, display_order) values
  ('AML', 'Anti-Money Laundering', 12, 10),
  ('CTF', 'Counter-Terrorist Financing', 12, 20)
on conflict do nothing;

create table if not exists pd_mandatory_completion (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid not null references staff_profiles(id) on delete cascade,
  training_id   uuid not null references pd_mandatory_training(id) on delete cascade,
  completed_on  date not null default current_date,
  expires_on    date,                       -- set from renewal_months on insert
  evidence_url  text,
  note          text,
  recorded_by   uuid references staff_profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists pd_mand_comp_idx on pd_mandatory_completion (staff_id, training_id, completed_on desc);

-- Stamp expires_on = completed_on + renewal_months (if the training renews).
create or replace function pd_mandatory_set_expiry() returns trigger
language plpgsql as $$
declare v_months int;
begin
  select renewal_months into v_months from pd_mandatory_training where id = new.training_id;
  if v_months is not null then
    new.expires_on := (new.completed_on + make_interval(months => v_months))::date;
  else
    new.expires_on := null;
  end if;
  return new;
end;
$$;

drop trigger if exists pd_mand_comp_expiry on pd_mandatory_completion;
create trigger pd_mand_comp_expiry
  before insert or update of completed_on, training_id on pd_mandatory_completion
  for each row execute function pd_mandatory_set_expiry();

-- RLS — consistent with the other pd_* tables: any active staff can read/write.
-- (Catalogue editing is gated to admins in the UI.)
alter table pd_mandatory_training   enable row level security;
alter table pd_mandatory_completion enable row level security;

drop policy if exists pd_mandatory_training_all on pd_mandatory_training;
create policy pd_mandatory_training_all on pd_mandatory_training
  for all to authenticated using (is_active_staff()) with check (is_active_staff());

drop policy if exists pd_mandatory_completion_all on pd_mandatory_completion;
create policy pd_mandatory_completion_all on pd_mandatory_completion
  for all to authenticated using (is_active_staff()) with check (is_active_staff());

comment on table pd_mandatory_training is 'Firm-wide catalogue of mandatory trainings (AML, CTF, ...) with optional renewal period.';
comment on table pd_mandatory_completion is 'Per-staff mandatory-training completion records; expires_on derived from the training renewal period.';
