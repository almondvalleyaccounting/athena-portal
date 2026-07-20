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
// returns a number or null (→ rendered as "—"). ctx keys:
//   plFytd, plFytdPrior, plSummary, balances, agedAR, agedAP,
//   pnlMonthly, balanceSheet, fileHealth
const sum = (arr) => (Array.isArray(arr) ? arr.reduce((s, v) => s + (v || 0), 0) : null);
const annualIncome = (ctx) => ctx.plSummary?.income ?? sum(ctx.pnlMonthly?.series?.income);
const annualCosts = (ctx) => {
  const p = ctx.plSummary;
  if (p && (p.cogs != null || p.expenses != null)) return (p.cogs || 0) + (p.expenses || 0);
  const m = ctx.pnlMonthly?.series;
  if (!m) return null;
  const c = sum(m.cogs) || 0;
  const e = sum(m.expenses) || 0;
  return c + e || null;
};

export const RATIOS = [
  {
    key: 'gross_margin', label: 'Gross margin', format: 'pct',
    hint: 'Gross profit ÷ income, fiscal year to date',
    compute: (ctx) => {
      const p = ctx.plFytd || ctx.plSummary;
      if (!p || !p.income) return null;
      const gp = p.gross_profit ?? (p.income - (p.cogs || 0));
      return (gp / p.income) * 100;
    },
  },
  {
    key: 'net_margin', label: 'Net margin', format: 'pct',
    hint: 'Net income ÷ income, fiscal year to date',
    compute: (ctx) => {
      const p = ctx.plFytd || ctx.plSummary;
      if (!p || !p.income || p.net_income == null) return null;
      return (p.net_income / p.income) * 100;
    },
  },
  {
    key: 'debtor_days', label: 'Debtor days', format: 'days',
    hint: 'Debtors ÷ last-12-months income × 365',
    compute: (ctx) => {
      const debtors = ctx.agedAR?.buckets?.total ?? ctx.balances?.debtors;
      const income = annualIncome(ctx);
      if (debtors == null || !income) return null;
      return (debtors / income) * 365;
    },
  },
  {
    key: 'creditor_days', label: 'Creditor days', format: 'days',
    hint: 'Creditors ÷ last-12-months costs (COGS + expenses) × 365',
    compute: (ctx) => {
      const creditors = ctx.agedAP?.buckets?.total ?? ctx.balances?.creditors;
      const costs = annualCosts(ctx);
      if (creditors == null || !costs) return null;
      return (creditors / costs) * 365;
    },
  },
  {
    key: 'current_ratio', label: 'Current ratio', format: 'ratio',
    hint: 'Current assets ÷ current liabilities',
    compute: (ctx) => {
      const bs = ctx.balanceSheet;
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

export const HEALTH_COLORS = {
  green: { dot: '#22c55e', bg: '#f0fdf4', border: '#bbf7d0', text: '#166534', label: 'Clean' },
  amber: { dot: '#f59e0b', bg: '#fffbeb', border: '#fde68a', text: '#92400e', label: 'Needs a look' },
  red:   { dot: '#ef4444', bg: '#fef2f2', border: '#fecaca', text: '#991b1b', label: 'Attention' },
};
