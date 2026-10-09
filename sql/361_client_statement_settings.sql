-- 361 — Customer statement settings
--
-- The client dashboard's Overdue invoices tab lets a client download PDF
-- statements for their own customers. A statement goes out under THEIR name,
-- so it needs their logo, their letterhead and how to pay them. QuickBooks
-- supplies a name and address (CompanyInfo); everything else lives here, one
-- row per client.
--
-- NO BROWSER ACCESS AT ALL. Both readers are people the database cannot tell
-- apart by role — a portal client and a member of staff both hold
-- `authenticated` — and the question "may this person set this client's
-- letterhead?" is a grant check (client_dashboard_access) or a staff check,
-- which the statement-settings edge function asks. So RLS is on with no
-- policies and the API roles hold nothing: service_role only, the same shape
-- as qbo_report_tokens.
--
-- The logo is a data URL rather than a Storage object. It is small (the
-- browser scales it to at most 800×300 and re-encodes it as PNG before it is
-- sent), it is only ever read alongside the rest of the row, and a public
-- bucket is one of the eleven things the posture audit exists to catch. The
-- CHECKs below hold the shape whatever writes the row.

begin;

create table if not exists public.client_statement_settings (
  entity_id        uuid primary key references public.entities(id) on delete cascade,
  logo_data_url    text,
  business_name    text,
  address          text,
  email            text,
  phone            text,
  website          text,
  company_number   text,
  vat_number       text,
  payment_details  text,
  footer_note      text,
  updated_at       timestamptz not null default now(),
  updated_by_email text,
  constraint client_statement_settings_logo_shape check (
    logo_data_url is null
    or (logo_data_url ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/=]+$'
        and length(logo_data_url) <= 400000)
  ),
  constraint client_statement_settings_text_lengths check (
    coalesce(length(business_name), 0) <= 200
    and coalesce(length(address), 0) <= 600
    and coalesce(length(email), 0) <= 200
    and coalesce(length(phone), 0) <= 60
    and coalesce(length(website), 0) <= 200
    and coalesce(length(company_number), 0) <= 40
    and coalesce(length(vat_number), 0) <= 40
    and coalesce(length(payment_details), 0) <= 800
    and coalesce(length(footer_note), 0) <= 800
  )
);

comment on table public.client_statement_settings is
  'Letterhead for the customer statements a client downloads from their dashboard (logo, contact details, how to pay). service_role only: read and written through the statement-settings edge function, which checks the client grant or the staff member.';

alter table public.client_statement_settings enable row level security;

revoke all on table public.client_statement_settings from public, anon, authenticated;
grant all on table public.client_statement_settings to service_role;

commit;
