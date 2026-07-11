-- AI document extraction v1 (applied as migration onboarding_doc_extract_v1).
-- Every document uploaded against an onboarding is automatically read by
-- Claude (edge fn doc-extract, model claude-opus-4-8): classified (passport,
-- UTR letter, P60, ...) and key fields extracted into
-- onboarding_documents.extracted; a summary lands on the activity timeline
-- (with a loud warning if an ID document appears expired).
-- Requires the ANTHROPIC_API_KEY secret on the Supabase project.

alter table onboarding_documents add column if not exists doc_type text;
alter table onboarding_documents add column if not exists extracted jsonb;
alter table onboarding_documents add column if not exists extract_status text not null default 'pending'
  check (extract_status in ('pending','done','unsupported','error'));
alter table onboarding_documents add column if not exists extract_error text;
alter table onboarding_documents add column if not exists extracted_at timestamptz;

create or replace function notify_doc_extract()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  secret text;
begin
  select cron_secret into secret from onboarding_chase_config where id = true;
  if secret is not null then
    perform net.http_post(
      url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/doc-extract',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', secret
      ),
      body := jsonb_build_object('document_id', new.id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_doc_extract on onboarding_documents;
create trigger trg_doc_extract
  after insert on onboarding_documents
  for each row execute function notify_doc_extract();
