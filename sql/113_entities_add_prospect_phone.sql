-- New Client modal now captures a phone number alongside prospect_email.
alter table public.entities add column prospect_phone text;
comment on column public.entities.prospect_phone is 'Contact phone number captured at prospect/quick-add stage, e.g. from the New Client modal. Free-text, includes country code.';
