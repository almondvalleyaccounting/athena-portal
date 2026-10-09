-- 362 — Google Drive: client folder map + year-end documents
--
-- Athena reads the practice's own Drive tree (AV.Shared shared drive:
-- Ltd_Cos / Individuals / Partnerships / <Client> / …) and writes into it.
-- That needs the full `drive` scope on the existing gdrive_connections row
-- (drive-auth-init now asks for it), because `drive.file` only ever showed
-- Athena the folders it had created itself.
--
--   drive_folder_index   every client folder found by the last scan, so the
--                        mapping screen can offer them without calling Google
--   client_drive_folders one folder per client: suggested by the scan
--                        (name / company number), confirmed by a person, or
--                        set by hand. Folder ids survive renames and moves.
--   drive_documents      files Athena owns inside a client folder — today the
--                        year-end notes Google Doc per client + period end.
--                        The Doc is the single copy of the notes: Athena
--                        appends to it and reads it back, so edits made in
--                        Drive show in Athena and nothing has to merge.
--
-- Every write is the `drive` edge function (service_role). Staff read the
-- three tables directly; client-portal users hold `authenticated` too, so the
-- read policy is is_active_staff(), and the API roles hold no write grant.

begin;

create table if not exists public.drive_folder_index (
  folder_id   text primary key,
  name        text not null,
  category    text not null check (category in ('Ltd_Cos', 'Individuals', 'Partnerships')),
  web_link    text,
  modified_at timestamptz,
  scanned_at  timestamptz not null default now()
);
comment on table public.drive_folder_index is
  'Client folders found in AV.Shared by the last drive scan (one level under Ltd_Cos / Individuals / Partnerships). Written by the drive edge function only.';

create table if not exists public.client_drive_folders (
  entity_id          uuid primary key references public.entities(id) on delete cascade,
  folder_id          text not null,
  folder_name        text,
  category           text,
  status             text not null default 'suggested' check (status in ('suggested', 'confirmed')),
  match_method       text not null check (match_method in ('name', 'company_number', 'manual')),
  -- Where this client's year-end folders live, when it is not the usual
  -- 04_Accounts/04_StatutoryAccounts. Pinned by hand per client.
  accounts_folder_id text,
  set_by             uuid references public.staff_profiles(id),
  confirmed_by       uuid references public.staff_profiles(id),
  confirmed_at       timestamptz,
  updated_at         timestamptz not null default now()
);
create index if not exists client_drive_folders_folder_idx on public.client_drive_folders (folder_id);
comment on table public.client_drive_folders is
  'One Google Drive folder per client. A scan suggests; a person confirms or sets it. Only confirmed rows are used for writes. Written by the drive edge function only.';

create table if not exists public.drive_documents (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references public.entities(id) on delete cascade,
  kind             text not null check (kind in ('year_end_notes')),
  period_end       date not null,
  job_plan_id      uuid references public.job_plans(id) on delete set null,
  file_id          text not null,
  folder_id        text not null,
  web_link         text,
  title            text,
  created_by       uuid references public.staff_profiles(id),
  created_at       timestamptz not null default now(),
  last_appended_at timestamptz,
  unique (entity_id, kind, period_end)
);
comment on table public.drive_documents is
  'Files Athena keeps in a client''s Drive folder. year_end_notes = the Google Doc that holds a year end''s notes; workflow comments are appended to it. Written by the drive edge function only.';

alter table public.drive_folder_index   enable row level security;
alter table public.client_drive_folders enable row level security;
alter table public.drive_documents      enable row level security;

drop policy if exists drive_folder_index_staff_read on public.drive_folder_index;
create policy drive_folder_index_staff_read on public.drive_folder_index
  for select to authenticated using (public.is_active_staff());
drop policy if exists client_drive_folders_staff_read on public.client_drive_folders;
create policy client_drive_folders_staff_read on public.client_drive_folders
  for select to authenticated using (public.is_active_staff());
drop policy if exists drive_documents_staff_read on public.drive_documents;
create policy drive_documents_staff_read on public.drive_documents
  for select to authenticated using (public.is_active_staff());

revoke all on public.drive_folder_index, public.client_drive_folders, public.drive_documents from anon, public;
revoke all on public.drive_folder_index, public.client_drive_folders, public.drive_documents from authenticated;
grant select on public.drive_folder_index, public.client_drive_folders, public.drive_documents to authenticated;
grant all on public.drive_folder_index, public.client_drive_folders, public.drive_documents to service_role;

commit;
