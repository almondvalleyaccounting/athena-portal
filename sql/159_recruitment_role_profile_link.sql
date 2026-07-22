-- 159: link vacancies to the central CPD role profiles.
--
-- Vacancy adverts are drafted from the firm's central role profiles
-- (pd_role_profiles — the same ones that drive the CPD tracker): the advert
-- description is seeded from the profile narrative and the requirements from
-- its weighted skill categories. The generated text is then fully editable at
-- the advert stage and thereafter, so this column is just a soft reference to
-- what it was drafted from (kept nullable, on delete set null).
alter table public.recruitment_vacancies
  add column if not exists role_profile_id uuid references public.pd_role_profiles(id) on delete set null;
