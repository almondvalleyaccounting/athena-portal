-- 257 — Stop holding Companies House authentication codes.
--
-- From the exposure review of 2026-08-24. 273 of 667 entities held what read as
-- real CH authentication codes — 267 distinct, none matching the -2223
-- placeholder pattern. This was the most serious item in the database and the
-- only one that could be removed outright rather than defended.
--
-- A CH auth code plus a company number is a filing credential: it lets the
-- holder file as that company on WebFiling — change the registered office,
-- appoint or terminate directors, file accounts. Unlike a QuickBooks token we
-- cannot revoke it; only the company can, by requesting a new code posted to
-- the registered office. So a breach involving these would be very hard to
-- characterise as low risk to the data subjects, and the remediation would not
-- be ours to perform.
--
-- Nothing in Athena ever used the value. Every consumer only asks whether a
-- code exists:
--
--   * v_onboarding_crosscheck_client derives company_no_ch_auth_code as
--     `limited_company AND nullif(btrim(ch_auth_code),'') is null` — presence.
--   * v_onboarding_crosscheck_board propagates that boolean into the loose_end
--     bucket — presence.
--   * onboarding-chase compares it against the BM record to decide whether to
--     chase — presence.
--   * ClientDetailView displayed it — no consumer.
--
-- So the column becomes a marker. Live values are replaced with the literal
-- 'held', which every presence test above reads identically to a real code, and
-- the views need no rewrite. BrightManager remains the single system of record
-- for the actual code.
--
-- Enforcement is a trigger rather than a change to import_bm_clients, for two
-- reasons. It covers *every* write path — the BM importer, a staff edit on the
-- client page, any future importer — instead of the one we happen to know
-- about. And it does not touch the import function, which is mid-change on
-- another workstream. The CHECK constraint behind it is unreachable while the
-- trigger stands, and deliberately so: it is what makes the guarantee survive
-- someone dropping the trigger.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Purge. 273 rows collapse to a marker.
-- ─────────────────────────────────────────────────────────────────────────────

update public.entities
   set ch_auth_code = 'held'
 where nullif(btrim(ch_auth_code), '') is not null
   and ch_auth_code <> 'held';

-- Normalise the empty-string variants to null while we are here, so presence
-- means exactly one thing.
update public.entities
   set ch_auth_code = null
 where ch_auth_code is not null
   and btrim(ch_auth_code) = '';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Coerce every future write.
--
-- Anything that is not null and not already the marker becomes the marker. The
-- caller is not rejected — the BM importer keeps working unchanged and simply
-- finds that Athena recorded presence rather than the code. Rejecting would
-- break the import; coercing degrades it to exactly what we want to keep.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.entities_ch_auth_code_flag_only()
returns trigger
language plpgsql
security invoker
set search_path to 'public'
as $$
begin
  if new.ch_auth_code is not null then
    if btrim(new.ch_auth_code) = '' then
      new.ch_auth_code := null;
    elsif new.ch_auth_code <> 'held' then
      new.ch_auth_code := 'held';
    end if;
  end if;
  return new;
end $$;

comment on function public.entities_ch_auth_code_flag_only() is
  'Athena records only that a Companies House auth code exists, never the code. '
  'BrightManager is the system of record. See sql/257.';

drop trigger if exists trg_entities_ch_auth_code_flag_only on public.entities;
create trigger trg_entities_ch_auth_code_flag_only
  before insert or update of ch_auth_code on public.entities
  for each row execute function public.entities_ch_auth_code_flag_only();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Make it structural, not procedural.
--
-- Unreachable while the trigger stands. That is the point: drop the trigger and
-- the constraint still refuses to store a code.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.entities
  drop constraint if exists entities_ch_auth_code_flag_only;

alter table public.entities
  add constraint entities_ch_auth_code_flag_only
  check (ch_auth_code is null or ch_auth_code = 'held');

comment on column public.entities.ch_auth_code is
  'Presence marker only — null, or the literal ''held''. Never the code itself. '
  'A CH auth code is a filing credential we have no use for and cannot revoke, '
  'so BrightManager holds it and Athena records only that it exists. Enforced by '
  'trg_entities_ch_auth_code_flag_only and a CHECK constraint. See sql/257.';

commit;
