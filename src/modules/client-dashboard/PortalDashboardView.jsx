import React, { useMemo } from 'react';
import { portalTheme as t } from './portalTheme';
import TabErrorBoundary from './TabErrorBoundary';
import {
  buildBuckets, bucketsBetween, addMonths, aggregate, seriesFor,
  windowLabel, monthKeyOfDate,
} from './overviewGrain';
import { money, moneyCompact, shortDate } from './dashboardData';
import { BucketChart, LineChart } from './DashboardCharts';
import {
  forecastByMonth, actualsByMonth, buildStatement, buildCashflow,
  totalRow, netRow, PL_ORDER, BS_ORDER,
} from './projectionEngine';

/*
  The client's own financial dashboard — PURE presentation.

  This is what a client sees. It is rendered in two places and must look and
  read identically in both:

    • client-portal/src/DashboardSection.jsx — the real thing, for the client.
    • src/shell/DashboardAccessPage.jsx — the "Preview as client" panel, so
      whoever is about to give someone access can look at exactly what they
      will get before pressing the button.

  A preview built from a separate mock would drift from the real page within
  weeks and would then be actively misleading — you would be signing off a view
  nobody is actually shown. So there is one component, it takes a payload and a
  handful of control props, and it does no data fetching of its own.

  The arithmetic is not reimplemented either: bucketing, the owner-cost
  adjustment and the projection engine are the same modules the staff dashboard
  runs. A client and their accountant looking at the same month have to see the
  same number.

  Tone differs from the staff app on purpose. Staff read "Net profit"; an owner
  reading their own figures gets a sentence telling them what it means, because
  a number with no interpretation is how a dashboard becomes something people
  stop opening.
*/

export const PORTAL_GRAINS = [
  { key: 'month', label: 'Monthly' },
  { key: 'quarter', label: 'Quarterly' },
  { key: 'year', label: 'Yearly' },
];
const SPAN_BACK = { month: 12, quarter: 24, year: 36 };
const SPAN_FWD = { month: 18, quarter: 36, year: 60 };

const monthEndOf = (key) => {
  const [y, m] = key.split('-').map(Number);
  return `${key}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
};

// Which tabs a payload's grant flags allow, in order.
export function portalTabsFor(payload) {
  const s = payload?.sections || {};
  return [
    { key: 'overview', label: 'Overview', on: s.overview !== false },
    { key: 'pl', label: 'Profit & loss', on: !!s.pl },
    { key: 'bs', label: 'Balance sheet', on: !!s.balance },
    { key: 'projection', label: 'Projection', on: !!s.projection && !!payload?.projection },
  ].filter((x) => x.on);
}

export default function PortalDashboardView({
  payload, loading, error, onRetry,
  grain, setGrain, basis, setBasis, view, setView,
  tab, setTab,
  grants = [], entityId, setEntityId,
  // The preview renders inside an Athena panel that supplies its own heading,
  // so the hero is suppressed there.
  showHero = true,
}) {
  const sections = payload?.sections || {};
  const tabs = portalTabsFor(payload);
  const active = tabs.some((x) => x.key === tab) ? tab : (tabs[0]?.key || 'overview');

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

      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <Pills options={PORTAL_GRAINS} value={grain} onChange={setGrain} />
        <Pills
          options={[
            { key: 'fiscal', label: 'Your year' },
            { key: 'calendar', label: 'Calendar year' },
          ]}
          value={basis}
          onChange={setBasis}
        />
        {sections.underlying && (
          <Pills
            options={[
              { key: 'reported', label: 'As reported' },
              { key: 'underlying', label: 'Underlying' },
            ]}
            value={view}
            onChange={setView}
          />
        )}
      </div>

      {tabs.length > 1 && (
        <div style={{ display: 'flex', gap: 2, borderBottom: `1px solid ${t.border}`, marginBottom: 16, flexWrap: 'wrap' }}>
          {tabs.map((x) => (
            <button
              key={x.key}
              onClick={() => setTab(x.key)}
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
      <TabErrorBoundary key={active} label={tabs.find((x) => x.key === active)?.label?.toLowerCase()}>
        {payload && active === 'overview' && <Overview payload={payload} grain={grain} basis={basis} view={view} />}
        {payload && active === 'pl' && <ProfitAndLoss payload={payload} grain={grain} basis={basis} view={view} />}
        {payload && active === 'bs' && <BalanceSummary payload={payload} />}
        {payload && active === 'projection' && <Projection payload={payload} grain={grain} basis={basis} />}
      </TabErrorBoundary>
    </div>
  );
}

/* ─── Shared derivation ────────────────────────────────────────── */
// One place that turns the payload into buckets, so every tab agrees.
function useBuckets(payload, grain, basis) {
  return useMemo(() => {
    const detail = payload?.metrics?.detail;
    if (!detail?.month_keys?.length) return { rows: [], buckets: [], prior: null };
    const fyIdx = (payload.fiscal_year_start_month || 10) - 1;
    const anchor = payload.window?.latest_end || monthKeyOfDate(new Date());
    const { buckets, prior } = buildBuckets({ grain, basis, anchorKey: anchor, fyIdx });

    const accountsById = {};
    for (const a of payload.accounts || []) accountsById[a.id] = a;

    const rows = aggregate(detail, [prior, ...buckets], {
      ownerAccountIds: new Set(payload.owner_account_ids || []),
      accountsById,
      oneoffs: payload.oneoffs || [],
    });
    return { rows, buckets, prior, accountsById, fyIdx };
  }, [payload, grain, basis]);
}

/* ─── Overview ─────────────────────────────────────────────────── */
function Overview({ payload, grain, basis, view }) {
  const { rows } = useBuckets(payload, grain, basis);
  const chartRows = rows.slice(1);
  const latest = chartRows[chartRows.length - 1] || null;
  const previous = rows[rows.length - 2] || null;
  const bs = payload?.metrics?.bs;
  const currency = payload?.metrics?.detail?.currency || 'GBP';

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
function ProfitAndLoss({ payload, grain, basis, view }) {
  const { rows } = useBuckets(payload, grain, basis);
  const chartRows = rows.slice(1);
  const currency = payload?.metrics?.detail?.currency || 'GBP';
  if (!chartRows.length) return <Muted>There aren't any figures for this period yet.</Muted>;

  const isU = view === 'underlying';
  const line = (label, pick, bold) => ({ label, bold, values: chartRows.map(pick) });
  const lines = [
    line('Turnover', (r) => (isU ? r.u_income : r.income)),
    line('Cost of sales', (r) => r.cogs),
    line('Gross profit', (r) => r.gross_profit, true),
    line('Running costs', (r) => r.expenses),
    line(isU ? 'Underlying profit' : 'Profit', (r) => (isU ? r.u_net_income : r.net_income), true),
  ];

  return (
    <Card pad={false}>
      <div style={{ padding: '16px 18px 6px' }}>
        <CardTitle>Profit &amp; loss</CardTitle>
        <Muted small>{windowLabel(grain, basis, chartRows)}</Muted>
      </div>
      <ScrollTable columns={chartRows.map((r) => r.label)} rows={lines} currency={currency} />
    </Card>
  );
}

/* ─── Balance sheet ────────────────────────────────────────────── */
function BalanceSummary({ payload }) {
  const bs = payload?.metrics?.bs;
  const currency = bs?.currency || 'GBP';
  if (!bs) return <Muted>Your balance sheet isn't available just now.</Muted>;

  const rows = [
    ['What the business owns', null, true],
    ['Equipment and other fixed assets', bs.fixed_assets],
    ['Money in the bank', bs.cash],
    ['Owed to you', bs.debtors],
    ['What the business owes', null, true],
    ['Owed to suppliers', bs.accounts_payable ?? bs.creditors_within_1yr],
    ['Longer-term borrowing', bs.creditors_after_1yr],
    ['What it comes to', bs.net_assets ?? bs.equity, true],
  ];

  return (
    <Card>
      <CardTitle>Balance sheet</CardTitle>
      <Muted small>{bs.period?.end ? `As at ${shortDate(bs.period.end)}` : ''}</Muted>
      <div style={{ marginTop: 12 }}>
        {rows.map(([label, value, strong], i) => (
          <div
            key={i}
            style={{
              display: 'flex', justifyContent: 'space-between', gap: 12,
              padding: '9px 0', borderBottom: i === rows.length - 1 ? 'none' : `1px solid ${t.border}`,
              fontSize: value == null ? 11.5 : 13.5,
              fontWeight: strong ? 700 : 500,
              color: value == null ? t.faint : t.text,
              textTransform: value == null ? 'uppercase' : 'none',
              letterSpacing: value == null ? '0.04em' : 0,
              paddingTop: value == null && i > 0 ? 18 : 9,
            }}
          >
            <span>{label}</span>
            {value != null && <span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(value, currency)}</span>}
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ─── Projection ───────────────────────────────────────────────── */
function Projection({ payload, grain, basis }) {
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
  <div style={{
    background: t.card, border: `1px solid ${t.border}`, borderRadius: 16,
    padding: pad ? '16px 18px' : 0, marginBottom: 12,
  }}>
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

const Legend = ({ forecast }) => (
  <div style={{ fontSize: 11, color: t.faint, marginTop: 6, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
    <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#bae6fd', borderRadius: 2, marginRight: 4, verticalAlign: -1 }} />turnover</span>
    <span><span style={{ display: 'inline-block', width: 10, height: 2, background: '#0f172a', margin: '0 4px 0 0', verticalAlign: 3 }} />profit</span>
    {forecast && <span style={{ fontStyle: 'italic' }}>hatched bars and the dashed line are projected</span>}
  </div>
);

const STATUS_BG = { actual: 'transparent', mixed: '#fffdf5', forecast: '#f8fbff' };

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
              </td>
              {r.values.map((v, i) => (
                <td key={i} style={{
                  ...ptd, fontWeight: r.bold ? 700 : 500,
                  background: STATUS_BG[status[i]] || 'transparent',
                  color: (v ?? 0) < 0 ? '#b91c1c' : t.text,
                }}>
                  {v == null ? '—' : money(v, currency)}
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
