import React, { useMemo } from 'react';
import { portalTheme as t } from './portalTheme';
import TabErrorBoundary from './TabErrorBoundary';
import {
  buildBuckets, bucketsBetween, addMonths, aggregate, seriesFor,
  windowLabel, monthKeyOfDate,
} from './overviewGrain';
import {
  money, moneyCompact, shortDate,
  parseReportTree, reportMonthKeys, bucketReportTree,
  mergeReportTrees, totalReportTree, comparativeColumns, COMPARATIVE_KINDS,
  rangeLabel, COMPARATIVES,
} from './dashboardData';
import { BucketChart, LineChart } from './DashboardCharts';
import {
  forecastByMonth, actualsByMonth, buildStatement, buildCashflow,
  totalRow, netRow, PL_ORDER, BS_ORDER,
} from './projectionEngine';
import { ReportTable, AgedSection } from './StatementTables';
import { buildKpiModel, formatKpi } from './kpiEngine';
import ReportView from './ReportView';
import { PORTAL_PERIOD_PRESETS, PORTAL_ASAT_PRESETS, ASAT_TABS } from './usePortalDashboard';

/*
  The client's own financial dashboard — PURE presentation.

  This is what a client sees. It is rendered in two places and must look and
  read identically in both:

    • client-portal/src/DashboardSection.jsx — the real thing, for the client.
    • src/modules/client-dashboard/ClientViewPreview.jsx — the "Preview as
      client" panel, so whoever is about to give someone access can look at
      exactly what they will get before pressing the button.

  A preview built from a separate mock would drift from the real page within
  weeks and would then be actively misleading — you would be signing off a view
  nobody is actually shown. So there is one component, it takes a payload and
  the control bundle from usePortalDashboard, and it does no data fetching.

  PARITY WITH THE STAFF PAGE. The client used to get a curated five-line P&L, a
  summary balance sheet of eight rows, and a fixed twelve-month window. They now
  get the statements themselves: their own date range, the same Compare control,
  and rows that expand to account level, because those are the questions clients
  actually ring up with and answering them by email is worse for everyone. The
  components doing the rendering are the components the staff tabs render
  (StatementTables, ReportView) and the arithmetic is the modules the staff tabs
  run (overviewGrain, kpiEngine, projectionEngine). A client and their
  accountant looking at the same month see the same number by construction.

  What stays different is TONE, on purpose. Staff read "Net profit"; an owner
  reading their own figures gets a sentence telling them what it means, because
  a number with no interpretation is how a dashboard becomes something people
  stop opening. So the Overview narrates and the statements do not.
*/

export const PORTAL_GRAINS = [
  { key: 'month', label: 'Monthly' },
  { key: 'quarter', label: 'Quarterly' },
  { key: 'year', label: 'Yearly' },
];
const SPAN_BACK = { month: 12, quarter: 24, year: 36 };
const SPAN_FWD = { month: 18, quarter: 36, year: 60 };

// The statement tables in the client's palette rather than the staff greys.
const TABLE_PALETTE = {
  text: t.text,
  strong: t.navy,
  faint: t.faint,
  negative: '#b91c1c',
  border: t.border,
  rowBorder: '#f6f8f9',
  summaryBg: '#f8fafc',
  surface: t.card,
  size: 12.5,
  headSize: 11,
};

const cardChrome = {
  background: t.card, border: `1px solid ${t.border}`, borderRadius: 16,
  padding: '16px 18px', marginBottom: 12,
};

const monthEndOf = (key) => {
  const [y, m] = key.split('-').map(Number);
  return `${key}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
};

/*
  Which tabs a payload's grant flags allow, in order.

  Overview, the two statements, the two ledgers and the KPIs are the standard
  offer (sql/275). Underlying is not a tab — it is a lens over the Overview, and
  it appears as the "As reported / Underlying" control. Projection needs both the
  flag and a linked scenario, because a Projection tab with no forecast behind it
  is a promise of something that does not exist.

  Custom reports arrive as one tab each. They are already double-gated — the
  grant's `show_reports` and the report's own `is_client_visible` — so anything
  in the list is meant to be here.
*/
export function portalTabsFor(payload) {
  const s = payload?.sections || {};
  const base = [
    { key: 'overview', label: 'Overview', on: s.overview !== false },
    { key: 'pl', label: 'Profit & loss', on: !!s.pl },
    { key: 'bs', label: 'Balance sheet', on: !!s.balance },
    { key: 'debtors', label: 'Who owes you', on: !!s.debtors },
    { key: 'creditors', label: 'Who you owe', on: !!s.creditors },
    { key: 'kpis', label: 'Measures', on: !!s.kpis && !!(payload?.kpis?.definitions || []).length },
    { key: 'projection', label: 'The year ahead', on: !!s.projection && !!payload?.projection },
  ].filter((x) => x.on);

  const reports = (payload?.reports || []).map((r) => ({
    key: `report:${r.id}`, label: r.name || 'Report', on: true, report: r,
  }));

  return [...base, ...reports];
}

export default function PortalDashboardView({
  payload, loading, error, onRetry, ui,
  grants = [], entityId, setEntityId,
  // The preview renders inside an Athena panel that supplies its own heading,
  // so the hero is suppressed there.
  showHero = true,
}) {
  const sections = payload?.sections || {};
  const tabs = portalTabsFor(payload);
  const active = tabs.some((x) => x.key === ui.tab) ? ui.tab : (tabs[0]?.key || 'overview');
  const activeTab = tabs.find((x) => x.key === active) || null;
  const isAsAt = ASAT_TABS.has(active);
  const currency = payload?.metrics?.detail?.currency || payload?.metrics?.bs?.currency || 'GBP';

  // A statement tab shows the Compare control; the grain and basis only mean
  // something under Trend, where they choose the columns. Everywhere else they
  // would be controls that change nothing, which is worse than their absence.
  const isStatement = active === 'pl' || active === 'bs';
  const statementCompare = active === 'pl' ? ui.plCompare : ui.bsCompare;
  const showGrain = active === 'overview' || (isStatement && statementCompare === 'trend');

  return (
    <div>
      {showHero && (
        <div style={{
          borderRadius: 20, overflow: 'hidden',
          background: `linear-gradient(120deg, ${t.navyDark}, ${t.navy} 60%, ${t.teal})`,
          padding: '22px 22px 18px', color: '#fff', marginBottom: 14,
        }}>
          <div style={{ fontSize: 12.5, letterSpacing: 1.2, textTransform: 'uppercase', color: 'rgba(255,255,255,0.65)', fontWeight: 600 }}>
            Your numbers
          </div>
          <div style={{ fontSize: 'clamp(19px, 4.2vw, 24px)', fontWeight: 700, margin: '5px 0 4px' }}>
            {payload?.company_name || 'Your business'}
          </div>
          <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.8)', lineHeight: 1.55 }}>
            Straight from your bookkeeping, kept up to date by us.
            {payload?.pulled_at && ` Last checked ${shortDate(payload.pulled_at)}.`}
          </div>

          {grants.length > 1 && setEntityId && (
            <select
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
              style={{
                marginTop: 12, border: 'none', borderRadius: 9, padding: '8px 12px',
                fontSize: 13, background: 'rgba(255,255,255,0.15)', color: '#fff', cursor: 'pointer',
              }}
            >
              {grants.map((g) => (
                <option key={g.entity_id} value={g.entity_id} style={{ color: '#0f172a' }}>
                  {g.entity_name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {tabs.length > 1 && (
        <div style={{ display: 'flex', gap: 2, borderBottom: `1px solid ${t.border}`, marginBottom: 14, flexWrap: 'wrap' }}>
          {tabs.map((x) => (
            <button
              key={x.key}
              onClick={() => ui.setTab(x.key)}
              style={{
                padding: '9px 14px', border: 'none', background: 'none', cursor: 'pointer',
                fontSize: 13, fontWeight: active === x.key ? 700 : 500,
                color: active === x.key ? t.navy : t.muted,
                borderBottom: `2px solid ${active === x.key ? t.teal : 'transparent'}`,
                marginBottom: -1,
              }}
            >
              {x.label}
            </button>
          ))}
        </div>
      )}

      {/* ── Controls ──────────────────────────────────────────────
          A period is a RANGE and a position is a DATE, so the rail changes
          with the tab rather than showing a range picker above a balance
          sheet, which would invite the reader to think the balance sheet
          covered it. A custom report is not here at all: it carries its own
          window, which is what makes it the same report every month. */}
      {active.startsWith('report:') ? null : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
          {isAsAt ? (
            <DatePicker
              label="As at"
              presets={PORTAL_ASAT_PRESETS}
              value={ui.asAtKey} onChange={ui.setAsAtKey}
              custom={(
                <input
                  type="date" value={ui.customAsAt.date}
                  onChange={(e) => ui.setCustomAsAt({ date: e.target.value })}
                  max={payload?.limits?.latest} min={payload?.limits?.earliest}
                  style={dateInput}
                />
              )}
              hint={ui.asAt.date ? `at ${shortDate(ui.asAt.date)}` : null}
            />
          ) : (
            <DatePicker
              label="Period"
              presets={PORTAL_PERIOD_PRESETS}
              value={ui.periodKey} onChange={ui.setPeriodKey}
              custom={(
                <>
                  <input
                    type="date" value={ui.customPeriod.start}
                    onChange={(e) => ui.setCustomPeriod({ ...ui.customPeriod, start: e.target.value })}
                    max={payload?.limits?.latest} min={payload?.limits?.earliest}
                    style={dateInput}
                  />
                  <span style={{ color: t.faint, fontSize: 12 }}>to</span>
                  <input
                    type="date" value={ui.customPeriod.end}
                    onChange={(e) => ui.setCustomPeriod({ ...ui.customPeriod, end: e.target.value })}
                    max={payload?.limits?.latest} min={payload?.limits?.earliest}
                    style={dateInput}
                  />
                </>
              )}
              hint={rangeLabel(ui.period.plStart, ui.period.plEnd)}
            />
          )}

          {isStatement && (
            <Pills
              options={COMPARATIVES}
              value={statementCompare}
              onChange={active === 'pl' ? ui.setPlCompare : ui.setBsCompare}
            />
          )}

          {showGrain && (
            <>
              <Pills options={PORTAL_GRAINS} value={ui.grain} onChange={ui.setGrain} />
              <Pills
                options={[
                  { key: 'fiscal', label: 'Your year' },
                  { key: 'calendar', label: 'Calendar year' },
                ]}
                value={ui.basis}
                onChange={ui.setBasis}
              />
            </>
          )}

          {sections.underlying && active === 'overview' && (
            <Pills
              options={[
                { key: 'reported', label: 'As reported' },
                { key: 'underlying', label: 'Underlying' },
              ]}
              value={ui.view}
              onChange={ui.setView}
            />
          )}
        </div>
      )}

      {error && (
        <div style={{ fontSize: 13.5, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '10px 14px' }}>
          {error}{' '}
          {onRetry && (
            <button onClick={onRetry} style={{ border: 'none', background: 'none', color: '#b91c1c', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}>
              Try again
            </button>
          )}
        </div>
      )}

      {loading && !payload && <Muted>Fetching your figures…</Muted>}

      {/* A render error here costs the client this section, not the whole
          portal page — their onboarding steps, documents and quotes are on the
          same screen. No `showDetail`: a React error message means nothing to a
          client and reads as a broken product. It still reaches the console.
          `key={active}` remounts on tab switch so one bad section does not
          leave the next showing an error panel. */}
      <TabErrorBoundary key={active} label={activeTab?.label?.toLowerCase()}>
        {payload && active === 'overview' && <Overview payload={payload} ui={ui} />}
        {payload && active === 'pl' && <ProfitAndLoss payload={payload} ui={ui} currency={currency} loading={loading} />}
        {payload && active === 'bs' && <BalanceSheet payload={payload} ui={ui} currency={currency} loading={loading} />}
        {payload && active === 'debtors' && (
          <AgedSection
            title="Who owes you" data={payload.metrics?.ar_asat} currency={currency}
            sameLabel="The same customers" palette={TABLE_PALETTE} cardStyle={cardChrome}
          />
        )}
        {payload && active === 'creditors' && (
          <AgedSection
            title="Who you owe" data={payload.metrics?.ap_asat} currency={currency}
            sameLabel="The same suppliers" palette={TABLE_PALETTE} cardStyle={cardChrome}
          />
        )}
        {payload && active === 'kpis' && <Measures payload={payload} ui={ui} currency={currency} />}
        {payload && active === 'projection' && <Projection payload={payload} ui={ui} />}
        {payload && activeTab?.report && (
          <ReportView
            report={activeTab.report}
            detail={payload.metrics?.detail}
            bs={payload.metrics?.bs}
            config={configFrom(payload)}
            kpi={kpiFrom(payload)}
            fyIdx={(payload.fiscal_year_start_month || 10) - 1}
            currency={currency}
            clientName={payload.company_name || ''}
            palette={{ strong: t.navy, text: t.muted, faint: t.faint, border: t.border, rowBorder: '#f6f8f9', surface: t.card }}
            cardStyle={cardChrome}
          />
        )}
      </TabErrorBoundary>
    </div>
  );
}

/* ─── Shared derivation ────────────────────────────────────────── */
// The owner-cost configuration and the KPI bundle in the shapes the shared
// modules expect. Absent flags mean absent data, which both handle as "no
// adjustment" and "no KPIs" rather than as an error.
const configFrom = (payload) => {
  const accountsById = {};
  for (const a of payload?.accounts || []) accountsById[a.id] = a;
  return {
    ownerAccountIds: new Set(payload?.owner_account_ids || []),
    accountsById,
    oneoffs: payload?.oneoffs || [],
  };
};

const kpiFrom = (payload) => ({
  definitions: payload?.kpis?.definitions || [],
  dimensionValues: payload?.kpis?.dimension_values || [],
  values: payload?.kpis?.values || [],
});

// One place that turns the payload into buckets, so every tab agrees.
function useBuckets(payload, grain, basis) {
  return useMemo(() => {
    const detail = payload?.metrics?.detail;
    if (!detail?.month_keys?.length) return { rows: [], buckets: [], prior: null };
    const fyIdx = (payload.fiscal_year_start_month || 10) - 1;
    const anchor = payload.window?.latest_end || monthKeyOfDate(new Date());
    const { buckets, prior } = buildBuckets({ grain, basis, anchorKey: anchor, fyIdx });

    const rows = aggregate(detail, [prior, ...buckets], configFrom(payload));
    return { rows, buckets, prior, fyIdx };
  }, [payload, grain, basis]);
}

/* ─── Overview ─────────────────────────────────────────────────── */
function Overview({ payload, ui }) {
  const { grain, basis, view } = ui;
  const { rows, buckets } = useBuckets(payload, grain, basis);
  const chartRows = rows.slice(1);
  const latest = chartRows[chartRows.length - 1] || null;
  const previous = rows[rows.length - 2] || null;
  const bs = payload?.metrics?.bs;
  const currency = payload?.metrics?.detail?.currency || 'GBP';

  // KPIs the pack flags for the front page, beside turnover and profit.
  const kpiTiles = useMemo(() => {
    const kpi = kpiFrom(payload);
    if (!kpi.definitions.length || !buckets.length) return [];
    const fin = chartRows;
    const financials = (bi, key) => {
      if (key === 'cash') return bs?.cash ?? null;
      if (key === 'debtors') return bs?.debtors ?? null;
      if (key === 'creditors') return bs?.accounts_payable ?? bs?.creditors_within_1yr ?? null;
      const r = fin[bi];
      if (!r) return null;
      const s = seriesFor(r, view);
      if (key === 'income') return s.income;
      if (key === 'net_income') return s.net_income;
      return r[key] ?? null;
    };
    const m = buildKpiModel({ ...kpi, buckets, financials });
    return m.rows.filter((r) => r.definition.show_on_overview);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, buckets, view]);

  if (!latest) return <Muted>There aren't any figures for this period yet.</Muted>;

  const cur = seriesFor(latest, view);
  const prv = seriesFor(previous, view);
  const isU = view === 'underlying';
  const creditors = bs?.accounts_payable ?? bs?.creditors_within_1yr;

  const profitWord = (cur.net_income ?? 0) >= 0 ? 'made' : 'lost';
  const changeWord = (cur.net_income != null && prv.net_income != null)
    ? ((cur.net_income - prv.net_income) >= 0 ? 'better than' : 'behind')
    : null;

  return (
    <>
      <Card>
        <div style={{ fontSize: 14.5, color: t.text, lineHeight: 1.65 }}>
          In <strong>{latest.label}</strong> you turned over{' '}
          <strong>{money(cur.income, currency)}</strong> and {profitWord}{' '}
          <strong>{money(Math.abs(cur.net_income ?? 0), currency)}</strong>
          {isU && ' once your own costs are taken out'}
          {changeWord && previous
            ? <> — {changeWord} {previous.label} by {money(Math.abs((cur.net_income ?? 0) - (prv.net_income ?? 0)), currency)}.</>
            : '.'}
        </div>
      </Card>

      <Tiles>
        <Tile label="Turnover" value={cur.income} prev={prv.income} currency={currency} sub={latest.label} />
        <Tile label={isU ? 'Underlying profit' : 'Profit'} value={cur.net_income} prev={prv.net_income} currency={currency} sub={latest.label} />
        <Tile label="Money in the bank" value={bs?.cash} prev={bs?.prev?.cash} currency={currency} sub={bs?.period?.end ? `at ${shortDate(bs.period.end)}` : null} />
        <Tile label="Owed to you" value={bs?.debtors} prev={bs?.prev?.debtors} currency={currency} goodWhenDown sub={bs?.period?.end ? `at ${shortDate(bs.period.end)}` : null} />
        <Tile label="You owe" value={creditors} prev={bs?.prev?.accounts_payable ?? bs?.prev?.creditors_within_1yr} currency={currency} goodWhenDown sub={bs?.period?.end ? `at ${shortDate(bs.period.end)}` : null} />
        {kpiTiles.map((k) => (
          <KpiTile key={k.definition.id} row={k} currency={currency} sub={latest.label} />
        ))}
      </Tiles>

      <Card>
        <CardTitle>Turnover and profit</CardTitle>
        <Muted small>{windowLabel(grain, basis, chartRows)}</Muted>
        <div style={{ marginTop: 10 }}>
          <BucketChart
            points={chartRows.map((r) => {
              const s = seriesFor(r, view);
              return { label: r.label, income: s.income, net: s.net_income };
            })}
            currency={currency}
            netLabel={isU ? 'underlying profit' : 'profit'}
          />
        </div>
        <Legend />
      </Card>

      {isU && (
        <Note>
          The underlying view takes out the costs that are really yours rather than the
          business's — your own pay, dividends, anything we've agreed is personal — so what's
          left is what the business itself earns.
        </Note>
      )}
    </>
  );
}

/* ─── Profit & loss ────────────────────────────────────────────── */
/*
  The statement, in the two shapes the Compare control offers, and the same two
  the staff tab offers:

  • TREND — one column per month, quarter or year, chosen by the grain.
  • A COMPARATIVE — the chosen period beside the same LENGTH of time ending
    earlier, with the movement. A P&L is a flow, so the comparative shifts the
    whole range; comparing a year against a day is the mistake this prevents.

  Rows expand to account level either way, and are matched by label within their
  parent rather than by position: QuickBooks omits an account with no activity,
  so line 14 of this year is not line 14 of last.
*/
function ProfitAndLoss({ payload, ui, currency, loading }) {
  const isTrend = ui.plCompare === 'trend';
  const pl = payload.metrics?.pl_range;
  const cmpPl = payload.metrics?.pl_compare;
  const cmpRange = payload.pl_compare_range;
  const { buckets } = useBuckets(payload, ui.grain, ui.basis);

  const parsed = useMemo(
    () => (pl?.report ? parseReportTree(pl.report) : null),
    [pl],
  );
  const monthKeys = useMemo(
    () => (pl?.report ? reportMonthKeys(pl.report) : []),
    [pl],
  );
  const bucketed = useMemo(() => {
    if (!isTrend || !parsed || !buckets?.length || !monthKeys.some(Boolean)) return null;
    return bucketReportTree(parsed.rows, monthKeys, buckets, 'sum');
  }, [isTrend, parsed, monthKeys, buckets]);

  const merged = useMemo(() => {
    if (isTrend || !parsed) return null;
    const cur = totalReportTree(parsed.rows, monthKeys);
    if (!cur) return null;
    const cmp = cmpPl?.report ? parseReportTree(cmpPl.report).rows : [];
    return mergeReportTrees(cur, cmp);
  }, [isTrend, parsed, monthKeys, cmpPl]);

  if (!parsed) {
    return <Muted>{loading ? 'Fetching your profit and loss…' : "There isn't a profit and loss for this period yet."}</Muted>;
  }

  const p = pl.period;
  const columns = merged
    ? comparativeColumns(rangeLabel(p?.start, p?.end), rangeLabel(cmpRange?.start, cmpRange?.end), 'Change')
    : bucketed ? buckets.map((b) => b.label) : parsed.columns;
  const rows = merged || bucketed || parsed.rows;

  return (
    <Card pad={false}>
      <div style={{ padding: '16px 18px 6px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <CardTitle>Profit &amp; loss</CardTitle>
          <span style={{ fontSize: 11.5, color: t.faint, marginLeft: 'auto' }}>
            {shortDate(p?.start)} → {shortDate(p?.end)}
            {merged && cmpRange && ` vs ${shortDate(cmpRange.start)} → ${shortDate(cmpRange.end)}`}
            {' '}· {currency}
          </span>
        </div>
        <Muted small>
          Tap a heading — Income, Cost of sales, Expenses — to open it up and see the accounts inside.
          {merged && ' Both columns cover the same length of time, so they compare line for line.'}
        </Muted>
        {merged && !cmpPl?.report && (
          <div style={{ fontSize: 12, color: t.amberText, marginTop: 8 }}>
            {loading ? 'Fetching the comparative period…' : "We couldn't fetch the earlier period, so the second column is empty."}
          </div>
        )}
      </div>
      <ReportTable
        columns={columns} rows={rows} monthLabels={!merged && !bucketed}
        columnKinds={merged ? COMPARATIVE_KINDS : null}
        dividerAt={merged ? 2 : null}
        palette={TABLE_PALETTE} startExpanded
      />
    </Card>
  );
}

/* ─── Balance sheet ────────────────────────────────────────────── */
/*
  A balance sheet is a POSITION, so its comparative is the same DATE earlier
  rather than the same length of time — and under Trend each column is the
  position at that period end, never three months added together.
*/
function BalanceSheet({ payload, ui, currency, loading }) {
  const isTrend = ui.bsCompare === 'trend';
  const bs = payload.metrics?.bs_asat;
  const cmpSheet = payload.metrics?.bs_compare;
  const cmpDate = payload.bs_compare_date;
  const grid = payload.metrics?.bs_grid;
  const { buckets } = useBuckets(payload, ui.grain, ui.basis);

  const gridParsed = useMemo(
    () => (isTrend && grid?.report ? parseReportTree(grid.report) : null),
    [isTrend, grid],
  );
  const bucketed = useMemo(() => {
    const monthKeys = grid?.month_keys || [];
    if (!gridParsed || !buckets?.length || !monthKeys.some(Boolean)) return null;
    return bucketReportTree(gridParsed.rows, monthKeys, buckets, 'last');
  }, [gridParsed, grid, buckets]);

  const merged = useMemo(() => {
    if (isTrend || !bs?.report) return null;
    const cur = parseReportTree(bs.report).rows;
    const cmp = cmpSheet?.report ? parseReportTree(cmpSheet.report).rows : [];
    return mergeReportTrees(cur, cmp);
  }, [isTrend, bs, cmpSheet]);

  const fallback = useMemo(
    () => (!merged && !bucketed && bs?.report ? parseReportTree(bs.report) : null),
    [merged, bucketed, bs],
  );

  if (!bs) {
    return <Muted>{loading ? 'Fetching your balance sheet…' : "Your balance sheet isn't available just now."}</Muted>;
  }

  const cmp = merged ? cmpSheet : null;
  const columns = merged
    ? comparativeColumns(shortDate(bs.period?.end), shortDate(cmpDate), 'Change')
    : bucketed ? buckets.map((b) => b.label) : (fallback?.columns || []);
  const rows = merged || bucketed || fallback?.rows || [];

  return (
    <>
      <Tiles>
        <Tile label="What the business owns" value={bs.total_assets} prev={cmp?.total_assets} currency={currency}
          sub={bs.period?.end ? `at ${shortDate(bs.period.end)}` : null} />
        <Tile label="What it owes" value={bs.total_liabilities} prev={cmp?.total_liabilities} currency={currency} goodWhenDown
          sub={(bs.creditors_within_1yr != null || bs.creditors_after_1yr != null)
            ? `${money(bs.creditors_within_1yr || 0, currency)} within a year`
            : null} />
        <Tile label="What it comes to" value={bs.net_assets ?? bs.equity} prev={cmp?.net_assets ?? cmp?.equity} currency={currency} />
      </Tiles>

      <Card pad={false}>
        <div style={{ padding: '16px 18px 6px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <CardTitle>Balance sheet</CardTitle>
            <span style={{ fontSize: 11.5, color: t.faint, marginLeft: 'auto' }}>
              as at {shortDate(bs.period?.end)}
              {merged && cmpDate && ` vs ${shortDate(cmpDate)}`}
              {' '}· {currency}
            </span>
          </div>
          <Muted small>
            {merged
              ? 'Both columns are the position on that date.'
              : bucketed
                ? 'Each column is the position at that period end — a closing balance, not a total for the period.'
                : ''}
            {' '}Tap a heading to open it up and see the accounts inside.
          </Muted>
          {merged && !cmpSheet?.report && (
            <div style={{ fontSize: 12, color: t.amberText, marginTop: 8 }}>
              {loading ? 'Fetching the earlier date…' : "We couldn't fetch the earlier date, so the second column is empty."}
            </div>
          )}
        </div>
        <ReportTable
          columns={columns} rows={rows} monthLabels={!merged && !bucketed}
          columnKinds={merged ? COMPARATIVE_KINDS : null}
          dividerAt={merged ? 2 : null}
          palette={TABLE_PALETTE} startExpanded
        />
      </Card>
    </>
  );
}

/* ─── Measures (KPIs) ──────────────────────────────────────────── */
/*
  Read-only. Staff enter and correct these figures on the KPI tab; a client
  typing into their own occupancy would put two sources of truth on one number,
  and the one we file from would not be the one they typed.
*/
function Measures({ payload, ui, currency }) {
  const { buckets } = useBuckets(payload, ui.grain, ui.basis);
  const model = useMemo(() => {
    const kpi = kpiFrom(payload);
    if (!kpi.definitions.length || !buckets.length) return null;
    const bs = payload.metrics?.bs;
    const rows = bucketRowsFor(payload, ui);
    const financials = (bi, key) => {
      if (key === 'cash') return bs?.cash ?? null;
      if (key === 'debtors') return bs?.debtors ?? null;
      if (key === 'creditors') return bs?.accounts_payable ?? bs?.creditors_within_1yr ?? null;
      const r = rows[bi];
      if (!r) return null;
      const s = seriesFor(r, ui.view);
      if (key === 'income') return s.income;
      if (key === 'net_income') return s.net_income;
      return r[key] ?? null;
    };
    return buildKpiModel({ ...kpi, buckets, financials });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, buckets, ui.view]);

  if (!model || !model.rows.length) return <Muted>There aren't any measures set up for you yet.</Muted>;

  return (
    <Card pad={false}>
      <div style={{ padding: '16px 18px 6px' }}>
        <CardTitle>Measures</CardTitle>
        <Muted small>
          {windowLabel(ui.grain, ui.basis, buckets)} · the things we track for you alongside the figures
        </Muted>
      </div>
      <ScrollTable
        columns={buckets.map((b) => b.label)}
        rows={model.rows.map((r) => ({
          label: r.definition.label,
          hint: r.definition.hint,
          values: r.total,
          unit: r.definition.unit,
          decimals: r.definition.decimals,
        }))}
        currency={currency}
      />
    </Card>
  );
}

// The aggregated bucket rows a KPI formula may reference by financial key.
// A plain function, not a hook: Measures calls it from inside a useMemo.
function bucketRowsFor(payload, ui) {
  const detail = payload?.metrics?.detail;
  if (!detail?.month_keys?.length) return [];
  const fyIdx = (payload.fiscal_year_start_month || 10) - 1;
  const anchor = payload.window?.latest_end || monthKeyOfDate(new Date());
  const { buckets, prior } = buildBuckets({ grain: ui.grain, basis: ui.basis, anchorKey: anchor, fyIdx });
  return aggregate(detail, [prior, ...buckets], configFrom(payload)).slice(1);
}

/* ─── Projection ───────────────────────────────────────────────── */
function Projection({ payload, ui }) {
  const { grain, basis } = ui;
  const p = payload.projection;
  const currency = payload?.metrics?.detail?.currency || 'GBP';
  const fyIdx = (payload.fiscal_year_start_month || 10) - 1;

  const model = useMemo(() => {
    if (!p?.opening_period) return null;
    const overrides = { forecast: {}, actual: {} };
    for (const o of p.overrides || []) overrides[o.source][String(o.source_key)] = o.category;

    const accountsById = {};
    for (const a of payload.accounts || []) accountsById[a.id] = a;

    const fc = forecastByMonth(p.rows || [], p.opening_period, overrides);
    const act = actualsByMonth(p.actuals || {}, accountsById, overrides);

    const cutoff = String(p.actuals_through || '').slice(0, 7);
    if (!cutoff) return null;
    const startKey = addMonths(cutoff, -(SPAN_BACK[grain] - 1));
    const openAbs = p.opening_period.slice(0, 7);
    let endKey = addMonths(cutoff, SPAN_FWD[grain]);
    const horizonEnd = addMonths(openAbs, (p.horizon_months || 1) - 1);
    if (endKey > horizonEnd) endKey = horizonEnd;
    if (endKey < cutoff) endKey = cutoff;

    const buckets = bucketsBetween({ grain, basis, startKey, endKey, fyIdx });
    const pl = buildStatement({ buckets, actual: act.categories, forecast: fc.categories, cutoff, order: PL_ORDER });
    const bsSt = buildStatement({ buckets, actual: act.categories, forecast: fc.categories, cutoff, order: BS_ORDER });
    const cf = buildCashflow({ buckets, actualCf: act.cf, forecastCf: fc.cf, cutoff });
    return { buckets, pl, bs: bsSt, cf, cutoff };
  }, [p, payload.accounts, grain, basis, fyIdx]);

  if (!model) return <Muted>Your projection isn't ready yet — we're still building it.</Muted>;

  const { buckets, pl, cf } = model;
  const income = totalRow(pl.rows, 'Total turnover', (r) => r.kind === 'income');
  const net = netRow(pl.rows, 'Profit');
  const forecastFrom = pl.status.findIndex((s) => s !== 'actual');
  const closing = cf.find((r) => r.category === 'closing');

  return (
    <>
      <Note>
        Actual figures up to <strong>{shortDate(monthEndOf(model.cutoff))}</strong>, and our
        projection after that. The projection is a plan, not a promise — it changes as the
        year does, and we'll keep it current with you.
      </Note>

      <Card>
        <CardTitle>Turnover and profit, with the year ahead</CardTitle>
        <div style={{ marginTop: 10 }}>
          <BucketChart
            points={buckets.map((b, i) => ({ label: b.label, income: income?.values[i] ?? null, net: net.values[i] ?? null }))}
            currency={currency}
            forecastFrom={forecastFrom < 0 ? null : forecastFrom}
            netLabel="profit"
          />
        </div>
        <Legend forecast />
      </Card>

      {closing && (
        <Card>
          <CardTitle>Cash, looking forward</CardTitle>
          <div style={{ marginTop: 10 }}>
            <LineChart
              points={buckets.map((b, i) => ({ label: b.label, value: closing.values[i] ?? null }))}
              currency={currency}
              forecastFrom={forecastFrom < 0 ? null : forecastFrom}
            />
          </div>
        </Card>
      )}

      <Card pad={false}>
        <div style={{ padding: '16px 18px 6px' }}>
          <CardTitle>Profit &amp; loss</CardTitle>
          <Muted small>Actual, then projected</Muted>
        </div>
        <ScrollTable
          columns={buckets.map((b) => b.label)}
          status={pl.status}
          rows={[
            ...pl.rows.filter((r) => r.kind === 'income').map((r) => ({ label: r.label, values: r.values })),
            { label: 'Total turnover', values: income?.values || [], bold: true },
            ...pl.rows.filter((r) => r.kind === 'cost').map((r) => ({ label: r.label, values: r.values })),
            { label: 'Profit', values: net.values, bold: true },
          ]}
          currency={currency}
        />
      </Card>
    </>
  );
}

/* ─── Bits ─────────────────────────────────────────────────────── */
/*
  The date picker: a preset select, with the two (or one) date boxes appearing
  only under "Custom". The hint underneath states the dates the preset actually
  resolved to, because "last full financial year" means nothing to a reader who
  does not know their own year end by heart, and a period label that cannot be
  checked is how somebody reads the wrong twelve months without noticing.
*/
function DatePicker({ label, presets, value, onChange, custom, hint }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 11.5, color: t.faint, fontWeight: 600 }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          border: `1px solid ${t.border}`, borderRadius: 9, padding: '7px 11px',
          fontSize: 12.5, background: t.card, color: t.text, cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {presets.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
      </select>
      {value === 'custom' && custom}
      {hint && value !== 'custom' && (
        <span style={{ fontSize: 11.5, color: t.faint }}>{hint}</span>
      )}
    </div>
  );
}

const dateInput = {
  border: `1px solid ${t.border}`, borderRadius: 9, padding: '6px 9px',
  fontSize: 12.5, background: t.card, color: t.text, fontFamily: 'inherit',
};

function Pills({ options, value, onChange }) {
  return (
    <div style={{ display: 'inline-flex', border: `1px solid ${t.border}`, borderRadius: 999, overflow: 'hidden', background: '#fff' }}>
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          style={{
            padding: '7px 14px', border: 'none', cursor: 'pointer',
            background: value === o.key ? t.navy : '#fff',
            color: value === o.key ? '#fff' : t.muted,
            fontSize: 12.5, fontWeight: value === o.key ? 700 : 500,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const Card = ({ children, pad = true }) => (
  <div style={{ ...cardChrome, padding: pad ? '16px 18px' : 0 }}>
    {children}
  </div>
);

const CardTitle = ({ children }) => (
  <div style={{ fontSize: 14.5, fontWeight: 700, color: t.navy }}>{children}</div>
);

const Muted = ({ children, small }) => (
  <div style={{ fontSize: small ? 12 : 13.5, color: t.faint, marginTop: small ? 2 : 0 }}>{children}</div>
);

const Note = ({ children }) => (
  <div style={{
    fontSize: 12.5, color: t.tealText, background: t.tealSoft,
    border: '1px solid #bae6fd', borderRadius: 12, padding: '11px 15px',
    marginBottom: 12, lineHeight: 1.6,
  }}>
    {children}
  </div>
);

const Tiles = ({ children }) => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 12 }}>
    {children}
  </div>
);

function Tile({ label, value, prev, currency, sub, goodWhenDown }) {
  const diff = (value != null && prev != null) ? value - prev : null;
  const good = diff == null ? null : (goodWhenDown ? diff < 0 : diff > 0);
  return (
    <div style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 14, padding: '13px 15px' }}>
      <div style={{ fontSize: 11.5, color: t.faint, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 700, color: (value ?? 0) < 0 ? '#b91c1c' : t.navy }}>
        {money(value, currency)}
      </div>
      <div style={{ minHeight: 15, fontSize: 11, color: t.faint, marginTop: 2 }}>
        {diff != null && Math.abs(diff) > 0.005 && (
          <span style={{ color: good ? t.successText : '#b91c1c', fontWeight: 600 }}>
            {diff > 0 ? '▲' : '▼'} {moneyCompact(Math.abs(diff), currency)}{' '}
          </span>
        )}
        {sub}
      </div>
    </div>
  );
}

// A KPI is not always money, so it gets its own formatter rather than being
// forced through the currency one — an occupancy rate rendered as £86 is the
// kind of wrong that looks like a number either way.
function KpiTile({ row, currency, sub }) {
  const vals = row.total || [];
  const value = vals.length ? vals[vals.length - 1] : null;
  const prev = vals.length > 1 ? vals[vals.length - 2] : null;
  const diff = (value != null && prev != null) ? value - prev : null;
  const unit = row.definition.unit;
  const dp = row.definition.decimals;
  return (
    <div style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 14, padding: '13px 15px' }}>
      <div style={{ fontSize: 11.5, color: t.faint, marginBottom: 3 }}>{row.definition.label}</div>
      <div style={{ fontSize: 19, fontWeight: 700, color: t.navy }}>
        {formatKpi(value, unit, dp, currency)}
      </div>
      <div style={{ minHeight: 15, fontSize: 11, color: t.faint, marginTop: 2 }}>
        {diff != null && Math.abs(diff) > 0.0000001 && (
          <span style={{ color: diff > 0 ? t.successText : '#b91c1c', fontWeight: 600 }}>
            {diff > 0 ? '▲' : '▼'} {formatKpi(Math.abs(diff), unit, dp, currency)}{' '}
          </span>
        )}
        {sub}
      </div>
    </div>
  );
}

const Legend = ({ forecast }) => (
  <div style={{ fontSize: 11, color: t.faint, marginTop: 6, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
    <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#bae6fd', borderRadius: 2, marginRight: 4, verticalAlign: -1 }} />turnover</span>
    <span><span style={{ display: 'inline-block', width: 10, height: 2, background: '#0f172a', margin: '0 4px 0 0', verticalAlign: 3 }} />profit</span>
    {forecast && <span style={{ fontStyle: 'italic' }}>hatched bars and the dashed line are projected</span>}
  </div>
);

const STATUS_BG = { actual: 'transparent', mixed: '#fffdf5', forecast: '#f8fbff' };

/*
  The flat table — the Projection's statement and the Measures grid.

  Separate from ReportTable because neither of those is a tree: a projection row
  has no accounts under it, and a KPI is one line by definition. A row may carry
  a `unit`, in which case it is formatted as that unit rather than as money.
*/
function ScrollTable({ columns, rows, currency, status = [] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 200 + columns.length * 92 }}>
        <thead>
          <tr>
            <th style={{ ...pth, textAlign: 'left', position: 'sticky', left: 0, background: '#fff', minWidth: 170 }} />
            {columns.map((c, i) => (
              <th key={c + i} style={{ ...pth, background: STATUS_BG[status[i]] || 'transparent' }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={r.label + ri}>
              <td style={{
                ...ptd, textAlign: 'left', position: 'sticky', left: 0, background: '#fff',
                fontWeight: r.bold ? 700 : 500, color: r.bold ? t.navy : t.text,
              }}>
                {r.label}
                {r.hint && (
                  <div style={{ fontSize: 10.5, fontWeight: 400, color: t.faint, whiteSpace: 'normal' }}>{r.hint}</div>
                )}
              </td>
              {r.values.map((v, i) => (
                <td key={i} style={{
                  ...ptd, fontWeight: r.bold ? 700 : 500,
                  background: STATUS_BG[status[i]] || 'transparent',
                  color: (v ?? 0) < 0 ? '#b91c1c' : t.text,
                }}>
                  {v == null ? '—'
                    : r.unit ? formatKpi(v, r.unit, r.decimals, currency)
                      : money(v, currency)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const pth = {
  fontSize: 11, color: t.faint, fontWeight: 700, textAlign: 'right',
  padding: '7px 12px', whiteSpace: 'nowrap', borderBottom: `1px solid ${t.border}`,
};
const ptd = {
  fontSize: 12.5, textAlign: 'right', padding: '8px 12px', whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums', borderBottom: '1px solid #f6f8f9',
};
