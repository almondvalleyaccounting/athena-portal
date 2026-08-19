/*
  Client Dashboard v2 — shared helpers.

  Everything here is PURE (no auth, no supabase): formatters, parsers over the
  cached QBO report jsonb, ratio definitions and shared styles. The tab
  components consume parsed data through props, so a future client-safe portal
  view can reuse the same parsers/components with a restricted data feed.
*/

/* ─── Formatting ───────────────────────────────────────────────── */
export function money(v, currency = 'GBP') {
  if (v === null || v === undefined || isNaN(v)) return '—';
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency', currency: currency || 'GBP', maximumFractionDigits: 0,
    }).format(v);
  } catch {
    return `£${Math.round(v).toLocaleString('en-GB')}`;
  }
}

// Compact money for chart labels / portfolio cards: £1.2m, £45k, £850.
export function moneyCompact(v, currency = 'GBP') {
  if (v === null || v === undefined || isNaN(v)) return '—';
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '£';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${sign}${sym}${(a / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (a >= 10_000) return `${sign}${sym}${Math.round(a / 1000)}k`;
  if (a >= 1000) return `${sign}${sym}${(a / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${sign}${sym}${Math.round(a)}`;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  return `${Math.floor(secs / 86400)} d ago`;
}

export function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// LOCAL yyyy-mm-dd (no UTC shift — the QBO reports are date-only and we never
// want a timezone to roll the day back a day).
export function iso(d) {
  if (!(d instanceof Date) || isNaN(d)) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// "Aug 2025" / "Aug '25" style month-column labels → "Aug 25".
export function shortMonth(label) {
  if (!label) return '';
  const m = String(label).match(/^([A-Za-z]{3})[a-z]*[ ,'’]*(\d{2,4})?/);
  if (!m) return String(label).slice(0, 6);
  const yr = m[2] ? ` ${m[2].slice(-2)}` : '';
  return `${m[1]}${yr}`;
}

/* ─── Cache-row helpers ────────────────────────────────────────── */
// rows = qbo_dashboard_cache rows for one realm, sorted pulled_at DESC.
export function latestByMetric(rows) {
  const out = {};
  for (const r of rows || []) if (!out[r.metric_key]) out[r.metric_key] = r;
  return out;
}

// Most recent snapshot of `key` from a calendar month BEFORE the latest
// snapshot's month — the "vs last month" comparator.
export function priorMonthSnapshot(rows, key) {
  const list = (rows || []).filter((r) => r.metric_key === key);
  if (list.length < 2) return null;
  const stamp = (r) => String(r.period_end || r.pulled_at || '').slice(0, 7);
  const latestMonth = stamp(list[0]);
  return list.find((r) => stamp(r) && stamp(r) < latestMonth) || null;
}

/* ─── QBO report jsonb → row tree ──────────────────────────────── */
// Generic parser for cached QBO reports (monthly P&L, balance sheet).
// Produces { columns: [...value-column titles...], rows: tree } where each
// node is:
//   { id, kind: 'section'|'row'|'summary', label, group, values|totals, children }
// values/totals align with `columns` (account-name column stripped).
export function parseReportTree(report) {
  const allCols = (report?.Columns?.Column || []).map((c) => c.ColTitle ?? '');
  const columns = allCols.slice(1);
  let uid = 0;
  const parseVals = (colData) => (colData || []).slice(1).map((c) => {
    const v = parseFloat(c?.value ?? '');
    return isNaN(v) ? null : v;
  });
  const walkRows = (rs) => {
    const out = [];
    for (const r of rs || []) {
      if (r.Rows?.Row || (r.Header && r.type === 'Section')) {
        out.push({
          id: `s${uid++}`,
          kind: 'section',
          label: r.Header?.ColData?.[0]?.value || r.group || '',
          group: r.group || null,
          children: walkRows(r.Rows?.Row),
          totals: r.Summary ? parseVals(r.Summary.ColData) : null,
          totalLabel: r.Summary?.ColData?.[0]?.value || null,
        });
      } else if (r.ColData) {
        out.push({
          id: `r${uid++}`,
          kind: 'row',
          label: r.ColData[0]?.value ?? '',
          group: r.group || null,
          values: parseVals(r.ColData),
        });
      } else if (r.Summary) {
        // Standalone summary rows: Gross Profit, Net Income, …
        out.push({
          id: `t${uid++}`,
          kind: 'summary',
          label: r.Summary.ColData?.[0]?.value || r.group || '',
          group: r.group || null,
          values: parseVals(r.Summary.ColData),
        });
      }
    }
    return out;
  };
  return { columns, rows: walkRows(report?.Rows?.Row) };
}

/* ─── Ratios ───────────────────────────────────────────────────── */
// Defined as a config array so new ratios are one entry each. compute(ctx)
// returns a number or null (→ rendered as "—"). ctx keys (all follow the
// selected period):
//   plRange   — P&L totals over the selected period (margins)
//   pnlChart  — rolling 12 months ending at the period end (annualised base
//               for debtor/creditor days)
//   bs        — balance-sheet lines as at the period end (debtors, creditors,
//               current assets/liabilities)
const sum = (arr) => (Array.isArray(arr) ? arr.reduce((s, v) => s + (v || 0), 0) : null);
const annualIncome = (ctx) => sum(ctx.pnlChart?.series?.income);
const annualCosts = (ctx) => {
  const m = ctx.pnlChart?.series;
  if (!m) return null;
  const c = sum(m.cogs) || 0;
  const e = sum(m.expenses) || 0;
  return c + e || null;
};

export const RATIOS = [
  {
    key: 'gross_margin', label: 'Gross margin', format: 'pct',
    hint: 'Gross profit ÷ income, over the selected period',
    compute: (ctx) => {
      const p = ctx.plRange;
      if (!p || !p.income) return null;
      const gp = p.gross_profit ?? (p.income - (p.cogs || 0));
      return (gp / p.income) * 100;
    },
  },
  {
    key: 'net_margin', label: 'Net margin', format: 'pct',
    hint: 'Net income ÷ income, over the selected period',
    compute: (ctx) => {
      const p = ctx.plRange;
      if (!p || !p.income || p.net_income == null) return null;
      return (p.net_income / p.income) * 100;
    },
  },
  {
    key: 'debtor_days', label: 'Debtor days', format: 'days',
    hint: 'Debtors (at period end) ÷ rolling-12-month income × 365',
    compute: (ctx) => {
      const debtors = ctx.bs?.debtors;
      const income = annualIncome(ctx);
      if (debtors == null || !income) return null;
      return (debtors / income) * 365;
    },
  },
  {
    key: 'creditor_days', label: 'Creditor days', format: 'days',
    hint: 'Creditors (at period end) ÷ rolling-12-month costs (COGS + expenses) × 365',
    compute: (ctx) => {
      const creditors = ctx.bs?.accounts_payable ?? ctx.bs?.creditors_within_1yr;
      const costs = annualCosts(ctx);
      if (creditors == null || !costs) return null;
      return (creditors / costs) * 365;
    },
  },
  {
    key: 'current_ratio', label: 'Current ratio', format: 'ratio',
    hint: 'Current assets ÷ current liabilities, at the period end',
    compute: (ctx) => {
      const bs = ctx.bs;
      if (!bs || bs.current_assets == null || !bs.current_liabilities) return null;
      return bs.current_assets / bs.current_liabilities;
    },
  },
];

export function formatRatio(value, format) {
  if (value === null || value === undefined || isNaN(value)) return '—';
  if (format === 'pct') return `${value.toFixed(1)}%`;
  if (format === 'days') return `${Math.round(value)} days`;
  return value.toFixed(2);
}

/* ─── Date filters ─────────────────────────────────────────────── */
// The Client Dashboard has two independent filters:
//   • a PERIOD selector driving Overview + P&L (a date range), and
//   • an AS-AT selector driving Balance Sheet + Debtors & Creditors (a single
//     point in time).
// All maths is done here (pure) so the page just holds the selected keys and
// hands the computed windows to dashboard-qbo-pull.

export const PERIOD_PRESETS = [
  { key: 'last12full', label: 'Last 12 months' },
  { key: 'last365', label: 'Last 365 days' },
  { key: 'mtd', label: 'This month to date' },
  { key: 'lastMonth', label: 'Last month' },
  { key: 'lastFiscalYear', label: 'Last fiscal year' },
  { key: 'lastCalendarYear', label: 'Last calendar year' },
  { key: 'custom', label: 'Custom…' },
];

export const ASAT_PRESETS = [
  { key: 'lastMonthEnd', label: 'Last month end' },
  { key: 'today', label: 'Today' },
  { key: 'lastFiscalYearEnd', label: 'Last fiscal year end' },
  { key: 'lastCalendarYearEnd', label: 'Last calendar year end' },
  { key: 'custom', label: 'Custom…' },
];

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthLabel = (d) => `${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;

// 0-based month the fiscal year starts on, from a QBO value that may be a name
// ("October") or a number ("10"). Defaults to October (AVA's year end is 30 Sep).
export function fyStartMonthIndex(v) {
  if (v == null || v === '') return 9;
  const n = parseInt(v, 10);
  if (!isNaN(n) && n >= 1 && n <= 12) return n - 1;
  const i = MONTH_NAMES.indexOf(String(v).trim().toLowerCase());
  return i >= 0 ? i : 9;
}

// The most recently COMPLETED fiscal year, given today and the FY start month.
function lastFiscalYearRange(today, fyIdx) {
  const y = today.getFullYear();
  const m = today.getMonth();
  const startYear = m >= fyIdx ? y : y - 1;       // year the CURRENT FY began
  const currentStart = new Date(startYear, fyIdx, 1);
  const lastStart = new Date(startYear - 1, fyIdx, 1);
  const lastEnd = new Date(currentStart.getFullYear(), currentStart.getMonth(), 0); // day before current FY start
  return { start: lastStart, end: lastEnd };
}

// PERIOD → { plStart, plEnd, priorStart, priorEnd, chartStart, chartEnd, label, deltaLabel }.
// The chart window is ALWAYS the 12 months ending in the period-end month.
export function computePeriod(key, today = new Date(), fyIdx = 9, custom = null) {
  const y = today.getFullYear();
  const m = today.getMonth();
  let plStart, plEnd, priorStart, priorEnd, label, deltaLabel;

  // prior = the `span` whole months immediately before plStart (month-aligned).
  const setMonthPrior = (span) => {
    priorEnd = new Date(plStart.getFullYear(), plStart.getMonth(), 0);
    priorStart = new Date(plStart.getFullYear(), plStart.getMonth() - span, 1);
  };

  switch (key) {
    case 'last365':
      plEnd = new Date(y, m, today.getDate());
      plStart = new Date(y, m, today.getDate() - 364);
      priorEnd = new Date(plStart); priorEnd.setDate(priorEnd.getDate() - 1);
      priorStart = new Date(priorEnd); priorStart.setDate(priorStart.getDate() - 364);
      label = 'last 365 days'; deltaLabel = 'vs prior 365 days';
      break;
    case 'mtd':
      plStart = new Date(y, m, 1);
      plEnd = new Date(y, m, today.getDate());
      priorStart = new Date(y, m - 1, 1);
      priorEnd = new Date(y, m - 1, today.getDate());
      label = `${monthLabel(plStart)} to date`; deltaLabel = 'vs same period last month';
      break;
    case 'lastMonth':
      plStart = new Date(y, m - 1, 1);
      plEnd = new Date(y, m, 0);
      setMonthPrior(1);
      label = monthLabel(plStart); deltaLabel = 'vs previous month';
      break;
    case 'lastFiscalYear': {
      const r = lastFiscalYearRange(today, fyIdx);
      plStart = r.start; plEnd = r.end; setMonthPrior(12);
      label = `FY ${plStart.getFullYear()}/${String(plEnd.getFullYear()).slice(-2)}`;
      deltaLabel = 'vs prior fiscal year';
      break;
    }
    case 'lastCalendarYear':
      plStart = new Date(y - 1, 0, 1);
      plEnd = new Date(y - 1, 11, 31);
      setMonthPrior(12);
      label = `${y - 1}`; deltaLabel = 'vs prior year';
      break;
    case 'custom':
      plStart = custom?.start ? new Date(`${custom.start}T00:00:00`) : new Date(y, m - 11, 1);
      plEnd = custom?.end ? new Date(`${custom.end}T00:00:00`) : new Date(y, m, 0);
      {
        const lenDays = Math.round((plEnd - plStart) / 86400000) + 1;
        priorEnd = new Date(plStart); priorEnd.setDate(priorEnd.getDate() - 1);
        priorStart = new Date(priorEnd); priorStart.setDate(priorStart.getDate() - (lenDays - 1));
      }
      label = `${shortDate(iso(plStart))} – ${shortDate(iso(plEnd))}`; deltaLabel = 'vs prior period';
      break;
    case 'last12full':
    default:
      plEnd = new Date(y, m, 0);                                   // last full month
      plStart = new Date(plEnd.getFullYear(), plEnd.getMonth() - 11, 1);
      setMonthPrior(12);
      label = 'last 12 months'; deltaLabel = 'vs prior 12 months';
      break;
  }

  const chartEnd = new Date(plEnd.getFullYear(), plEnd.getMonth() + 1, 0);      // end of period-end month
  const chartStart = new Date(chartEnd.getFullYear(), chartEnd.getMonth() - 11, 1);

  return {
    plStart: iso(plStart), plEnd: iso(plEnd),
    priorStart: iso(priorStart), priorEnd: iso(priorEnd),
    chartStart: iso(chartStart), chartEnd: iso(chartEnd),
    label, deltaLabel,
  };
}

// AS-AT → { date, label }.
export function computeAsAt(key, today = new Date(), fyIdx = 9, custom = null) {
  const y = today.getFullYear();
  const m = today.getMonth();
  let date, label;
  switch (key) {
    case 'today':
      date = new Date(y, m, today.getDate()); label = 'today'; break;
    case 'lastFiscalYearEnd':
      date = lastFiscalYearRange(today, fyIdx).end; label = 'last fiscal year end'; break;
    case 'lastCalendarYearEnd':
      date = new Date(y - 1, 11, 31); label = 'last calendar year end'; break;
    case 'custom':
      date = custom?.date ? new Date(`${custom.date}T00:00:00`) : new Date(y, m, 0);
      label = 'custom date'; break;
    case 'lastMonthEnd':
    default:
      date = new Date(y, m, 0); label = 'last month end'; break;
  }
  return { date: iso(date), label };
}

/* ─── Shared styles ────────────────────────────────────────────── */
export const OUTFIT = "'Outfit', sans-serif";
export const PLAYFAIR = "'Playfair Display', serif";

export const cardStyle = {
  backgroundColor: '#ffffff',
  borderRadius: '12px',
  border: '1px solid #e5e7eb',
  padding: '20px 24px',
};

export const inputStyle = {
  border: '1px solid #e5e7eb',
  borderRadius: '10px',
  padding: '10px 14px',
  fontSize: '14px',
  fontFamily: OUTFIT,
  outline: 'none',
  boxSizing: 'border-box',
};
