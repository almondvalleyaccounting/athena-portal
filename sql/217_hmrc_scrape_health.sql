-- 217 — Which clients are running on stale data, per tax head.
--
-- The VAT run on 2026-08-10 reported 11 failures (down from 29 earlier the same
-- day). `hmrc.run` records only a COUNT — notes is null, and there is no error or
-- attempt table anywhere in the schema — so which 11 failed, and why, is not
-- recoverable from the data.
--
-- What IS recoverable is the consequence, and it is the thing that matters:
-- because every view scopes per client (sql/214), a client whose scrape failed
-- keeps their last good figures rather than disappearing. Cairnpoint Limited had
-- 8 VAT payments in run 7 and 0 in run 12; E & S Electrical 24 and 0. Both are
-- still visible in Athena, pinned to run 7.
--
-- That graceful degradation is right, but on its own it is dangerous: a client
-- can sit on ever-older data indefinitely and nothing says so. A silent failure
-- looks identical to a client who genuinely has nothing.
--
-- This view names them. Per client per tax: the run their figures come from, the
-- newest run for that service, and how far behind they are. A monthly sweep means
-- anything more than one run behind deserves a look, and `hmrc.refresh_request`
-- is the queue to send them to.

create or replace view public.v_hmrc_scrape_health as
with service_latest as (
  select service, max(id) as latest_run_id
  from hmrc.run
  group by service
),
run_at as (
  select id, service, coalesce(finished_at, started_at) as run_at from hmrc.run
),
-- One row per client per tax, carrying the run their data actually comes from.
scoped as (
  select c.entity_id, 'paye'::text as tax, c.paye_ref as reference, c.name as hmrc_name, p.run_id
  from (
    select distinct on (client_id) client_id, run_id
    from hmrc."position" order by client_id, scraped_at desc
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
  e.name                as entity_name,
  sc.tax,
  sc.reference,
  sc.hmrc_name,
  sc.run_id             as data_from_run,
  ra.run_at             as data_from,
  sl.latest_run_id,
  lra.run_at            as latest_run_at,
  -- How many runs of this service have happened since the one this client's
  -- figures come from. 0 = current.
  (select count(*) from hmrc.run r
    where r.service = sc.tax and r.id > sc.run_id)::int as runs_behind,
  (sc.run_id <> sl.latest_run_id)                       as stale
from scoped sc
join public.entities e     on e.id = sc.entity_id and e.entity_status::text = 'active'
join service_latest sl     on sl.service = sc.tax
left join run_at ra        on ra.id = sc.run_id
left join run_at lra       on lra.id = sl.latest_run_id
where public.hmrc_can_read();

comment on view public.v_hmrc_scrape_health is
  'Per active client per tax head: which run their figures come from, the newest run for that service, '
  'and how many runs behind they are. Because every view scopes per client, a failed scrape leaves the '
  'client on their last good data rather than blanking them — which is correct, but invisible without '
  'this. runs_behind > 0 means the most recent scrape of that tax did not produce data for them: either '
  'it failed, or they genuinely have nothing. hmrc.run records only a failure COUNT, with no per-client '
  'error anywhere, so the two cannot be told apart from the data.';

revoke all on public.v_hmrc_scrape_health from public, anon;
grant select on public.v_hmrc_scrape_health to authenticated, service_role;
