-- Onboarding document portal v1 (applied as migration onboarding_documents_v1).
-- Clients upload documents (ID, letters) from the client portal; files land
-- in the private client-documents storage bucket, are registered in
-- onboarding_documents, flip the step to 'received', and can then be saved
-- to Google Drive in one click from Athena (drive-save-documents edge fn).
-- Drive OAuth: drive-auth-init / drive-auth-callback edge functions,
-- tokens in gdrive_connections (drive.file scope — app-created files only).

-- New step status: client sent something, staff must verify then complete
alter table onboarding_steps drop constraint if exists onboarding_steps_status_check;
alter table onboarding_steps add constraint onboarding_steps_status_check
  check (status in ('pending','waiting_client','waiting_external','blocked','received','complete','na'));

create table if not exists onboarding_documents (
  id             uuid primary key default gen_random_uuid(),
  onboarding_id  uuid not null references onboardings(id) on delete cascade,
  step_id        uuid references onboarding_steps(id) on delete set null,
  entity_id      uuid not null references entities(id),
  uploaded_by_kind text not null default 'client' check (uploaded_by_kind in ('client','staff')),
  uploaded_by    uuid,
  storage_path   text not null,
  original_name  text not null,
  mime_type      text,
  size_bytes     bigint,
  status         text not null default 'received' check (status in ('received','saved_to_drive')),
  drive_file_id  text,
  drive_web_link text,
  created_at     timestamptz not null default now()
);
comment on table onboarding_documents is 'Documents uploaded against an onboarding (usually by the client via the portal). storage_path points into the client-documents bucket; drive_* filled when pushed to Google Drive.';
create index if not exists idx_onboarding_documents_ob on onboarding_documents(onboarding_id);

alter table onboarding_documents enable row level security;
drop policy if exists onboarding_documents_staff on onboarding_documents;
create policy onboarding_documents_staff on onboarding_documents for all using (is_active_staff()) with check (is_active_staff());

-- Google Drive connection (mirrors gmail_connections; single active row)
create table if not exists gdrive_connections (
  id                uuid primary key default gen_random_uuid(),
  account_email     text not null,
  access_token      text not null,
  refresh_token     text not null,
  token_expires_at  timestamptz not null,
  scope             text,
  connected_by      uuid,
  connected_at      timestamptz not null default now(),
  last_refreshed_at timestamptz,
  status            text not null default 'active' check (status in ('active','revoked','error')),
  error_message     text,
  updated_at        timestamptz not null default now()
);
create unique index if not exists gdrive_connections_one_active_idx on gdrive_connections (status) where status = 'active';
alter table gdrive_connections enable row level security;
drop policy if exists gdrive_connections_staff_read on gdrive_connections;
create policy gdrive_connections_staff_read on gdrive_connections for select using (is_active_staff());

-- ── Storage bucket ───────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('client-documents', 'client-documents', false, 20971520,
        array['image/jpeg','image/png','image/heic','image/heif','image/webp','application/pdf',
              'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do nothing;

-- Clients may upload into their own entity's folder only ({entity_id}/...)
drop policy if exists client_documents_client_insert on storage.objects;
create policy client_documents_client_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'client-documents'
  and (storage.foldername(name))[1] in (
    select entity_id::text from entity_memberships where user_id = auth.uid()
  )
);
-- Staff can do everything in the bucket (list, download, delete)
drop policy if exists client_documents_staff_all on storage.objects;
create policy client_documents_staff_all on storage.objects for all to authenticated
using (bucket_id = 'client-documents' and is_active_staff())
with check (bucket_id = 'client-documents' and is_active_staff());

-- ── Portal RPC: register an upload ───────────────────────────
create or replace function portal_register_document(
  p_step_id uuid, p_path text, p_name text, p_mime text, p_size bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select o.id as onboarding_id, o.entity_id, s.status as step_status,
         coalesce(s.client_label, s.name) as label
    into v
    from onboarding_steps s
    join onboardings o on o.id = s.onboarding_id
   where s.id = p_step_id;
  if v is null
     or v.entity_id not in (select entity_id from entity_memberships where user_id = auth.uid())
     or split_part(p_path, '/', 1) <> v.entity_id::text then
    raise exception 'not authorised';
  end if;

  insert into onboarding_documents
    (onboarding_id, step_id, entity_id, uploaded_by_kind, storage_path, original_name, mime_type, size_bytes)
  values (v.onboarding_id, p_step_id, v.entity_id, 'client', p_path, left(coalesce(p_name,'document'), 200), p_mime, p_size);

  if v.step_status in ('pending', 'waiting_client', 'blocked') then
    update onboarding_steps set status = 'received', updated_at = now() where id = p_step_id;
  end if;

  insert into onboarding_activity (onboarding_id, step_id, kind, body)
  values (v.onboarding_id, p_step_id, 'client_reply',
          'Document uploaded — ' || v.label || ': ' || left(coalesce(p_name,'document'), 200));
  return true;
end;
$$;

revoke all on function portal_register_document(uuid, text, text, text, bigint) from public, anon;
grant execute on function portal_register_document(uuid, text, text, text, bigint) to authenticated;
