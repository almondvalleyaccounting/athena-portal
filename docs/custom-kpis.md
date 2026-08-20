# Custom KPIs and custom reports

Design settled 2026-08-20. Schema and engine are built (`sql/245_custom_kpis.sql`,
`src/modules/client-dashboard/kpiEngine.js`); the screens are not.

## What this is for

The Client Dashboard reports what QuickBooks knows. A nursery is not run on
turnover — it is run on occupancy, and occupancy is children ÷ places, neither of
which is in the ledger. Some of those numbers get typed in, some will arrive from
another system (BrightPay headcount), and some are calculated from the others.

## Where it lives

Three concerns, three homes. The mistake would be one "KPIs" screen trying to be
all three.

**Definition** — rare, one person, changes seldom. A config card at the bottom of
the KPI tab, in the same shape as the Underlying Performance tab's owner-cost
configuration. Sector packs are edited in a practice-wide screen, because they
belong to the sector rather than to any one client.

**Entry** — recurring, possibly delegated, has to be fast. A grid: rows are KPIs ×
dimension values, columns are months, tab straight through. Entering twelve months
across four rooms one field at a time is how data entry dies.

Plus a practice-wide **outstanding list** — every client-month with a figure
missing. Decided against making each month a Work task for now: the list is the
lighter thing and does not couple the KPI build to the Work module. If the list
turns out to be ignored, that is the moment to promote it to a real task with an
owner and a due date. `kpi_outstanding(from, to)` already returns exactly what
that screen needs.

**Presentation** — KPI tiles on the Overview, mixed in with revenue and profit,
because occupancy next to revenue is the whole point. Trends and the by-room
breakdown on the KPI tab. And KPI rows selectable inside a custom report.

## Sectors, not per-client copies

Definitions belong to a sector. Childcare carries children, places and occupancy
once; a client allocated to that sector gets them all. Effective list:

    the client's sector's definitions
  + any bespoke definitions of its own
  − anything hidden by a per-client override

Overrides are sparse, so a pack fix reaches everyone who has not deliberately
diverged. `kpi_definitions_for_entity()` is the single resolver — the entry grid,
the tiles and the formula engine all read it, so they cannot disagree about what a
client's KPIs are.

The dimension is a property of the pack ("childcare KPIs break down by Room"); the
values are the client's own (Puddleduck's rooms are not another nursery's).

## The three rules that decide whether the numbers are right

Each of these looks fine on a monthly view and goes wrong the moment somebody
switches to quarters.

1. **Aggregation is per-KPI.** Headcount averages. Registered places takes the
   closing position. Most things sum.
2. **Calculated KPIs are recomputed after their inputs aggregate, never
   aggregated themselves.** On the seeded example a quarter's occupancy is 78.9%;
   averaging the three monthly percentages says 86.6%. Recomputing is also correct
   for additive formulas, so it is the uniform rule.
3. **The same holds across dimensions.** The nursery's occupancy is total children
   ÷ total places, not the mean of the room figures.

And: **missing is not zero.** An unentered month reads "—". A room with zero
registered places has undefined occupancy, not 0%.

## Formulas

Parsed by the forecast engine's `expr.js` — not a second expression language. Its
own documented example is `children_attending[babies] / 3`, which is already this
shape: a key, a dimension subscript, arithmetic. Period offsets (`x[t-1]`) come
free.

The namespace is KPI keys **plus the dashboard's own financial figures**, so
`income / children` gives revenue per child and `staff_costs / income` the staff
ratio. That crossover is what makes this custom reporting rather than a notes
field.

Cycles are detected and reported without blanking the rest of the tab.
`checkFormula()` catches unknown keys in the editor, because a typo otherwise
surfaces as a silent "—" long after anyone remembers editing it.

## Sources

`kpi_value.source` is `manual | brightpay | import | api`. BrightPay will later
write rows through an ingest path and the KPI module never learns what BrightPay
is. `is_override` marks a figure a human typed over an automated one, so an
importer can leave corrections alone instead of quietly undoing them. See the
BrightPay scoping task.

## Built

| Piece | Where |
| --- | --- |
| KPI tab — figures, entry grid, setup | Client Dashboard → KPIs |
| Overview tiles | anything flagged `show_on_overview` |
| Pack editor | `/admin/kpi-packs`, behind `can_manage_kpi_packs` |
| Outstanding list | `/kpis/outstanding` |
| Sector allocation | KPI tab → Setup |
| Custom reports | Client Dashboard → Reports (`sql/246`) |

Entry is always **monthly**, whatever grain the Figures tab is showing — you do
not enter a quarter's headcount, you enter three months and the reader
aggregates them the way the KPI says.

## Still to do

**Portal exposure** — deliberately deferred. Staff get the numbers right and
trusted first; then a `show_kpis` flag alongside the other grant flags in
`client_dashboard_access`, and the KPI rows added to `PortalDashboardView`.

**BrightPay headcount** — the `staff_headcount` KPI in the Childcare pack is
typed in for now. When the scraper lands it writes `kpi_value` rows with
`source = 'brightpay'`; nothing in the KPI module needs to change. See the
BrightPay scoping task.

**Reordering report rows by drag** — the editor has up/down buttons. Fine for
five rows, tedious for twenty.

## A modelling note, not a bug

`revenue_per_child` is `income / children`. At a yearly grain that is the year's
whole turnover divided by the average number of children — about £7,900 on
Puddleduck's seeded figures — not a monthly rate. Arithmetically right, and it
is what the formula says, but it surprises people. The hint field on each KPI
exists for exactly this; use it, or define the KPI as a monthly rate instead.

## Seeded already

Childcare sector, with children (average), places (last), occupancy
(`children / places * 100`), staff headcount, revenue per child
(`income / children`) and children per staff member. Puddleduck allocated to it
with Babies / Toddlers / Pre-school.

Note: `sql/245_custom_kpis.sql` and `kpiEngine.js` were swept into commit f74fae4
("Onboarding: sub-modules in the menu…") by a concurrent session committing the
whole index. The code is intact; only that commit's message does not describe
them. History was already pushed, so it was left alone.
