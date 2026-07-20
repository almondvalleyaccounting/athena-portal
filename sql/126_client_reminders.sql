-- 126: Client reminders (starting with July personal tax payments on account)
--      + client communication preferences.
--
-- Model:
--   * comm_types — the kinds of communication a client can opt in/out of.
--     Starts with tax_reminders; the list grows over time.
--   * client_comm_preferences — one row per client × type: pending (asked,
--     no answer yet), opted_in, opted_out. Amendable by staff (decided_via
--     'staff') or by the client clicking a tokened button ('email_link') or
--     replying ('email_reply', recorded by staff).
--   * tax_payment_batches / tax_payments_due — a TaxCalc export upload:
--     client, amount, due date. Staff mark paid/excluded; reminders go to
--     opted-in clients with an unpaid row.
--   * reminder_emails — every message sent (promo invitation or reminder),
--     with the opt-in/out token and the Gmail message/thread ids so replies
--     can be matched and archived.

create table if not exists public.comm_types (
  id text primary key,
  label text not null,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.comm_types (id, label, description)
values ('tax_reminders', 'Personal tax payment reminders',
        'Reminders ahead of personal tax payment deadlines (31 January / 31 July), including the amount due.')
on conflict (id) do nothing;

create table if not exists public.client_comm_preferences (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  comm_type text not null references public.comm_types(id),
  status text not null default 'pending' check (status in ('pending', 'opted_in', 'opted_out')),
  decided_at timestamptz,
  decided_via text check (decided_via in ('email_link', 'email_reply', 'staff')),
  decided_by uuid references public.staff_profiles(id),
  note text,
  updated_at timestamptz not null default now(),
  unique (entity_id, comm_type)
);
create index if not exists client_comm_prefs_type_idx on public.client_comm_preferences(comm_type, status);

create table if not exists public.tax_payment_batches (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  due_date date not null,
  source_filename text,
  uploaded_by uuid references public.staff_profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.tax_payments_due (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.tax_payment_batches(id) on delete cascade,
  entity_id uuid references public.entities(id),
  client_name_raw text not null,
  reference_raw text,
  amount numeric(12,2) not null default 0,
  status text not null default 'unpaid' check (status in ('unpaid', 'paid', 'excluded')),
  status_note text,
  last_reminded_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists tax_payments_due_batch_idx on public.tax_payments_due(batch_id);
create index if not exists tax_payments_due_entity_idx on public.tax_payments_due(entity_id);

create table if not exists public.reminder_emails (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('promo', 'reminder')),
  comm_type text not null references public.comm_types(id),
  entity_id uuid not null references public.entities(id) on delete cascade,
  batch_id uuid references public.tax_payment_batches(id),
  payment_id uuid references public.tax_payments_due(id),
  to_email text not null,
  subject text not null,
  token text not null unique default encode(gen_random_bytes(18), 'hex'),
  gmail_message_id text,
  gmail_thread_id text,
  sent_at timestamptz,
  sent_by uuid references public.staff_profiles(id),
  clicked_choice text check (clicked_choice in ('in', 'out')),
  clicked_at timestamptz,
  reply_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists reminder_emails_entity_idx on public.reminder_emails(entity_id);
create index if not exists reminder_emails_thread_idx on public.reminder_emails(gmail_thread_id);

alter table public.comm_types enable row level security;
alter table public.client_comm_preferences enable row level security;
alter table public.tax_payment_batches enable row level security;
alter table public.tax_payments_due enable row level security;
alter table public.reminder_emails enable row level security;

drop policy if exists "Staff read comm types" on public.comm_types;
create policy "Staff read comm types" on public.comm_types
  for select using (is_active_staff());

drop policy if exists "Staff manage comm preferences" on public.client_comm_preferences;
create policy "Staff manage comm preferences" on public.client_comm_preferences
  for all using (is_active_staff()) with check (is_active_staff());

drop policy if exists "Staff manage tax batches" on public.tax_payment_batches;
create policy "Staff manage tax batches" on public.tax_payment_batches
  for all using (is_active_staff()) with check (is_active_staff());

drop policy if exists "Staff manage tax payments" on public.tax_payments_due;
create policy "Staff manage tax payments" on public.tax_payments_due
  for all using (is_active_staff()) with check (is_active_staff());

drop policy if exists "Staff view reminder emails" on public.reminder_emails;
create policy "Staff view reminder emails" on public.reminder_emails
  for select using (is_active_staff());
-- Inserts/updates on reminder_emails happen via edge functions (service role).
