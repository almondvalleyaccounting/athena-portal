-- 120: Admin tasks — urgent flag + attachments.
--
-- urgent: staff-set flag; urgent tasks sort first and stand out in the list.
-- admin_task_documents: files attached to a task. Stored in the existing
-- client-documents bucket under admin-tasks/{task_id}/... — the
-- client_documents_staff_all storage policy already covers staff access to
-- any path in that bucket, so no storage policy changes are needed.

alter table public.admin_tasks
  add column if not exists urgent boolean not null default false;

create table if not exists public.admin_task_documents (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.admin_tasks(id) on delete cascade,
  storage_path text not null,
  original_name text not null,
  mime_type text,
  size_bytes bigint,
  uploaded_by uuid references public.staff_profiles(id),
  created_at timestamptz not null default now()
);

comment on table public.admin_task_documents is
  'Attachments on an admin task. storage_path points into the client-documents bucket (admin-tasks/{task_id}/... paths, staff-only).';

create index if not exists admin_task_documents_task_idx on public.admin_task_documents(task_id);

alter table public.admin_task_documents enable row level security;

drop policy if exists "Staff manage admin task documents" on public.admin_task_documents;
create policy "Staff manage admin task documents"
  on public.admin_task_documents for all
  using (is_active_staff())
  with check (is_active_staff());
