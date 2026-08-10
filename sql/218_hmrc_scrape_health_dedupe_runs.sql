-- 218 — Scrape health: collapse duplicate runs before judging staleness.
--
-- Supersedes the view in sql/217. This is the version running.
--
-- THE SAME SCRAPE CAN BE RECORDED TWICE. PAYE runs 4 and 8 share started_at to
-- the microsecond, both report 141 seen / 140 ok / 1 failed, and every child
-- table holds an identical count under each run id — position 140, charge 10,617,
-- payment 528, charge_line 17,881, overdue_item 316. Roughly 29,000 duplicated
-- rows. Only finished_at differs.
--
-- No money is double counted, because every view scopes to ONE run per client:
-- the per-client rule from sql/214 absorbing yet another shape of this problem.
-- But it made sql/217 report all 141 PAYE clients as stale — `position` resolves
-- by scraped_at, which ties across the duplicate pair and arbitrarily picked run
-- 4, while the newest run id was 8. Same data under two ids, read as a year of
-- neglect.
--
-- Runs sharing (service, started_at) now collapse into one generation, and
-- staleness counts generations rather than run ids. After the fix: 3 clients
-- stale rather than 141 — Cairnpoint Limited and E & S Electrical on VAT,
-- Sj Adjusting Ltd on PAYE. That last one is the PAYE failure found by hand
-- earlier, now surfaced systematically.
--
-- The duplication itself is the scraper's to fix.

create or replace view public.v_hmrc_scrape_health as
with gen as (
  -- One row per real scrape: duplicates collapse onto the same started_at.
  select
    service,
    started_at,
    max(id)                                as run_id,
    max(coalesce(finished_at, started_at)) as run_at,
    row_number() over (partition by service order by started_at desc) as generations_back
  from hmrc.run
  group by service, started_at
),
run_gen as (
  -- Map every run id back to its generation.
  select r.id as run_id, g.service, g.started_at, g.run_at, g.generations_back
  from hmrc.run r
  join gen g on g.service = r.service and g.started_at = r.started_at
),
scoped as (
  select c.entity_id, 'paye'::text as tax, c.paye_ref as reference, c.name as hmrc_name, p.run_id
  from (
    select distinct on (client_id) client_id, run_id
    from hmrc."position" order by client_id, scraped_at desc, run_id desc
  ) p
  join hmrc.client c on c.id = p.client_id

  union all
  select lk.entity_id, 'corporation-tax', lk.utr, lk.hmrc_name, s.run_id
  from public.v_hmrc_ct_scope s
  join public.v_hmrc_ct_link lk on lk.ct_client_id = s.client_id

  union all
  select vc.entity_id, 'vat', vc.vrn, coalesce(vc.hmrc_name, vc.name), s.run_id
  from public.v_hmrc_vat_scope s
  join hmrc.vat_client vc on vc.id = s.client_id

  union all
  select sc.entity_id, 'self-assessment', sc.utr, sc.name, s.run_id
  from public.v_hmrc_sa_scope s
  join hmrc.sa_client sc on sc.id = s.client_id
)
select
  sc.entity_id,
  e.name                        as entity_name,
  sc.tax,
  sc.reference,
  sc.hmrc_name,
  sc.run_id                     as data_from_run,
  mine.run_at                   as data_from,
  newest.run_id                 as latest_run_id,
  newest.run_at                 as latest_run_at,
  -- Generations behind, not run ids: a scrape recorded twice counts once.
  greatest(mine.generations_back - 1, 0)::int as runs_behind,
  (mine.generations_back > 1)                 as stale
from scoped sc
join public.entities e on e.id = sc.entity_id and e.entity_status::text = 'active'
join run_gen mine      on mine.run_id = sc.run_id
join gen newest        on newest.service = sc.tax and newest.generations_back = 1
where public.hmrc_can_read();

comment on view public.v_hmrc_scrape_health is
  'Per active client per tax head: which scrape their figures come from and how many scrapes have happened '
  'since. Because every view scopes per client, a failed scrape leaves the client on their last good data '
  'rather than blanking them — correct, but invisible without this. Runs sharing (service, started_at) are '
  'collapsed into one generation, because the same scrape can be written twice: PAYE runs 4 and 8 are one '
  'scrape under two ids with ~29,000 duplicated child rows. runs_behind > 0 means the most recent scrape of '
  'that tax produced no data for them — it failed, or they genuinely have nothing. hmrc.run records only a '
  'failure COUNT with no per-client error, so the two cannot be distinguished from the data.';

revoke all on public.v_hmrc_scrape_health from public, anon;
grant select on public.v_hmrc_scrape_health to authenticated, service_role;
