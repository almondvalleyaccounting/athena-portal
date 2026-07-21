-- 135: Communications — Google Contacts cache + email signatures.
--
-- comms_contacts: synced from Google Contacts (People API) per connected
-- mailbox by the comms-contacts-sync edge function. Used for composer
-- To/Cc autocomplete and for matching phone numbers to names on the
-- SMS / WhatsApp tabs (phone_suffixes = last-9-digit forms, same
-- convention as telnyx-inbound's client matching).
--
-- comms_signatures: per-staff email signatures, auto-appended in the
-- composer. mailbox_email '*' = the staff member's default for all
-- mailboxes; a specific address overrides it.

create table if not exists public.comms_contacts (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.gmail_connections(id) on delete cascade,
  resource_name text not null,          -- People API id, e.g. people/c123 or otherContacts/c456
  display_name text,
  emails text[] not null default '{}',
  phones text[] not null default '{}',
  phone_suffixes text[] not null default '{}',
  organisation text,
  synced_at timestamptz not null default now(),
  unique (connection_id, resource_name)
);
create index if not exists comms_contacts_suffix_idx on public.comms_contacts using gin (phone_suffixes);
create index if not exists comms_contacts_connection_idx on public.comms_contacts (connection_id);

alter table public.comms_contacts enable row level security;
drop policy if exists "Staff read comms contacts" on public.comms_contacts;
create policy "Staff read comms contacts" on public.comms_contacts
  for select using (is_active_staff());
-- Writes happen only via comms-contacts-sync (service role).

create table if not exists public.comms_signatures (
  staff_id uuid not null references public.staff_profiles(id) on delete cascade,
  mailbox_email text not null default '*',
  body text not null default '',
  updated_at timestamptz not null default now(),
  primary key (staff_id, mailbox_email)
);

alter table public.comms_signatures enable row level security;
drop policy if exists "Staff manage own signatures" on public.comms_signatures;
create policy "Staff manage own signatures" on public.comms_signatures
  for all using (auth.uid() = staff_id and is_active_staff())
  with check (auth.uid() = staff_id and is_active_staff());
