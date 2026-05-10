-- ══════════════════════════════════════════════════════════════
-- 049_seed_all_scotland_las.sql
--
-- Seeds the remaining 28 Scottish local authorities (GLA, NLA, EDB,
-- WDB were seeded in 046). Default NDR poundage 0.498 (2025/26 basic
-- property band). Default top-up policy = false; user enables per-LA
-- where the council permits charging parents above the funded rate.
--
-- Funded rates are intentionally NOT seeded — these vary materially by
-- LA and year and the user populates as they research each council.
-- ══════════════════════════════════════════════════════════════

INSERT INTO public.fc_la_council (code, name) VALUES
  ('ABC', 'Aberdeen City'),
  ('ABS', 'Aberdeenshire'),
  ('ANG', 'Angus'),
  ('AAB', 'Argyll and Bute'),
  ('EDH', 'City of Edinburgh'),
  ('CLA', 'Clackmannanshire'),
  ('DGA', 'Dumfries and Galloway'),
  ('DDC', 'Dundee City'),
  ('EAY', 'East Ayrshire'),
  ('ELO', 'East Lothian'),
  ('ERE', 'East Renfrewshire'),
  ('FAL', 'Falkirk'),
  ('FIF', 'Fife'),
  ('HIG', 'Highland'),
  ('INV', 'Inverclyde'),
  ('MID', 'Midlothian'),
  ('MOR', 'Moray'),
  ('NES', 'Na h-Eileanan Siar'),
  ('NAY', 'North Ayrshire'),
  ('ORK', 'Orkney Islands'),
  ('PKC', 'Perth and Kinross'),
  ('REN', 'Renfrewshire'),
  ('SBO', 'Scottish Borders'),
  ('SHE', 'Shetland Islands'),
  ('SAY', 'South Ayrshire'),
  ('SLA', 'South Lanarkshire'),
  ('STI', 'Stirling'),
  ('WLO', 'West Lothian')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.fc_la_ndr (la_council_id, period_year, poundage, small_business_relief_pct)
SELECT c.id, 2026, 0.498, NULL
FROM public.fc_la_council c
WHERE c.country = 'scotland'
ON CONFLICT (la_council_id, period_year) DO NOTHING;

INSERT INTO public.fc_la_topup (la_council_id, topup_allowed)
SELECT c.id, false
FROM public.fc_la_council c
WHERE c.country = 'scotland'
ON CONFLICT (la_council_id) DO NOTHING;
