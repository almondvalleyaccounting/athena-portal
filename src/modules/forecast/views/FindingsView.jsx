// Findings + Checks & Balances.
//
// Two sections:
//   1. Engine findings — error / warn / info from module.validate() runs.
//   2. Checks & balances — independent cross-checks that re-derive a
//      summary number from one source and compare it against another.
//      Each check shows the two numbers, the difference, and a ✓ / ✗.
//
// Tolerance for "ties" is £1 (= 100p) since we round at emit time across
// many places. Anything larger is flagged.

import React, { useMemo } from 'react';
import { colors, fontStack, H2, fmtP } from '../components/ui';

const TOL = 100;   // 100 pence = £1

export default function FindingsView({ findings = [], outputs = [], forecast, periods = [], entities = [] }) {
  const errs = findings.filter(f => f.severity === 'error');
  const warns = findings.filter(f => f.severity === 'warn');
  const infos = findings.filter(f => f.severity === 'info');

  const checks = useMemo(() => buildChecks(outputs, forecast, periods, entities), [outputs, forecast, periods, entities]);
  const passed = checks.filter(c => c.status === 'pass').length;
  const failed = checks.filter(c => c.status === 'fail').length;
  const noData = checks.filter(c => c.status === 'no_data').length;

  return (
    <div>
      <H2>Findings ({findings.length})</H2>
      {findings.length === 0 ? (
        <div style={{
          padding: 16, background: '#ecfdf5', color: '#065f46',
          borderRadius: 8, fontSize: 13, border: '1px solid #a7f3d0', marginBottom: 24,
        }}>
          ✓ No findings — module-level integrity OK.
        </div>
      ) : (
        <>
          <Group title="Errors" rows={errs} color={colors.red} />
          <Group title="Warnings" rows={warns} color={colors.amber} />
          <Group title="Info" rows={infos} color={colors.muted} />
        </>
      )}

      {/* ── Checks & balances ───────────────────────────────────── */}
      <div style={{ marginTop: 24 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
          <H2>Checks &amp; balances ({passed}/{checks.length} tying)</H2>
          <span style={{ fontSize: 11, color: colors.muted }}>
            {passed} pass · {failed} fail{noData > 0 ? ` · ${noData} no data` : ''}
          </span>
        </div>
        <p style={{ fontSize: 12, color: colors.muted, margin: '0 0 12px' }}>
          Each check re-derives a summary number from one source and ties it back against another.
          Tolerance: £1. Failures usually point to a stale recompute or a sign convention bug.
        </p>
        <CheckTable checks={checks} />
      </div>
    </div>
  );
}

function Group({ title, rows, color }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ marginBottom: 18 }}>
      <h3 style={{ fontFamily: fontStack, fontSize: 13, fontWeight: 600, color, margin: '0 0 6px' }}>
        {title} ({rows.length})
      </h3>
      <ul style={{ paddingLeft: 18, margin: 0, fontSize: 13, color: colors.inkSoft }}>
        {rows.slice(0, 50).map((f, i) => (
          <li key={i}>
            <code style={{ fontSize: 11, color: colors.muted }}>{f.code}</code>{' '}
            {f.period != null && <span style={{ color: colors.muted }}>t={f.period}</span>}{' '}
            {f.message}
          </li>
        ))}
        {rows.length > 50 && <li style={{ color: colors.muted }}>… {rows.length - 50} more</li>}
      </ul>
    </div>
  );
}

function CheckTable({ checks }) {
  // Group checks by their `category` so the table reads as logical sections.
  const byCategory = {};
  for (const c of checks) (byCategory[c.category] ||= []).push(c);
  const order = ['Income', 'P&L', 'Cashflow', 'Balance sheet', 'Staff', 'Capacities'];

  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 8, background: '#fff', overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: fontStack, fontSize: 12 }}>
        <colgroup>
          <col style={{ width: '38%' }} />
          <col style={{ width: '20%' }} />
          <col style={{ width: '20%' }} />
          <col style={{ width: '14%' }} />
          <col style={{ width: '8%' }} />
        </colgroup>
        <thead>
          <tr style={{ background: colors.bgSoft }}>
            <th style={th}>Check</th>
            <th style={thR}>Source A</th>
            <th style={thR}>Source B</th>
            <th style={thR}>Difference</th>
            <th style={{ ...thR, textAlign: 'center' }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {order.flatMap(cat => {
            const rows = byCategory[cat];
            if (!rows || rows.length === 0) return [];
            return [
              <tr key={`hdr-${cat}`} style={{ background: '#f1f5f9' }}>
                <td colSpan={5} style={{
                  padding: '5px 10px', fontSize: 10, fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: 0.5, color: colors.muted,
                }}>{cat}</td>
              </tr>,
              ...rows.map((c, i) => <CheckRow key={`${cat}-${i}`} c={c} />),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

function CheckRow({ c }) {
  const colorMap = {
    pass:    { bg: '#ecfdf5', fg: '#065f46', icon: '✓' },
    fail:    { bg: '#fef2f2', fg: '#991b1b', icon: '✗' },
    no_data: { bg: '#f8fafc', fg: colors.muted, icon: '·' },
  };
  const tag = colorMap[c.status] || colorMap.no_data;
  return (
    <tr style={{ borderBottom: `1px dotted ${colors.borderSoft}`, background: c.status === 'fail' ? '#fffbfb' : '#fff' }}>
      <td style={td}>
        <strong>{c.label}</strong>
        {c.detail && <div style={{ fontSize: 10, color: colors.muted, marginTop: 2 }}>{c.detail}</div>}
      </td>
      <td style={tdR}>
        <div>{fmtVal(c.a, c.unit)}</div>
        {c.aSource && <div style={{ fontSize: 10, color: colors.muted }}>{c.aSource}</div>}
      </td>
      <td style={tdR}>
        <div>{fmtVal(c.b, c.unit)}</div>
        {c.bSource && <div style={{ fontSize: 10, color: colors.muted }}>{c.bSource}</div>}
      </td>
      <td style={{ ...tdR, color: c.status === 'fail' ? '#991b1b' : colors.inkSoft }}>
        {c.status === 'no_data' ? '—' : fmtDiff(c.a, c.b, c.unit)}
      </td>
      <td style={{ ...td, textAlign: 'center' }}>
        <span style={{
          display: 'inline-block', padding: '2px 8px', borderRadius: 999,
          background: tag.bg, color: tag.fg, fontSize: 10, fontWeight: 700,
          letterSpacing: 0.4, textTransform: 'uppercase',
        }}>
          {tag.icon} {c.status === 'no_data' ? 'no data' : c.status}
        </span>
      </td>
    </tr>
  );
}

function fmtVal(v, unit) {
  if (v == null) return '—';
  if (unit === 'pct') return `${(Number(v)).toFixed(2)}%`;
  if (unit === 'count') return Math.round(Number(v)).toLocaleString('en-GB');
  if (unit === 'p_signed') {
    return fmtP(v, { compact: false });
  }
  return fmtP(v, { compact: false });
}
function fmtDiff(a, b, unit) {
  if (a == null || b == null) return '—';
  const d = Number(a) - Number(b);
  if (unit === 'pct') return `${d.toFixed(2)}pp`;
  if (unit === 'count') return Math.round(d).toLocaleString('en-GB');
  return fmtP(d, { compact: false });
}

// ── Check builders ────────────────────────────────────────────

function buildChecks(outputs, forecast, periods, entities) {
  if (!outputs || outputs.length === 0) {
    return [{
      category: 'Income', label: 'No outputs loaded',
      status: 'no_data',
      detail: 'Recompute the forecast to populate fc_output.',
    }];
  }

  const horizonYears = Math.max(1, Math.ceil((forecast?.horizon_months || 60) / 12));
  const yearPeriods = (y) => periods.filter(p => p >= (y - 1) * 12 && p < y * 12);
  const allPeriods = periods;
  const lastPeriod = periods[periods.length - 1];

  const sumNT = (nt, ps = allPeriods) => {
    const setP = ps === allPeriods ? null : new Set(ps);
    let s = 0;
    for (const r of outputs) {
      if (r.nominal_type !== nt) continue;
      if (setP && !setP.has(r.period)) continue;
      s += r.amount_p;
    }
    return s;
  };
  const lastNT = (nt) => {
    let bestT = -1, bestV = null;
    for (const r of outputs) {
      if (r.nominal_type !== nt) continue;
      if (r.period > bestT) { bestT = r.period; bestV = r.amount_p; }
    }
    return bestV;
  };
  const sumPredicate = (pred, ps = allPeriods) => {
    const setP = ps === allPeriods ? null : new Set(ps);
    let s = 0;
    for (const r of outputs) {
      if (setP && !setP.has(r.period)) continue;
      if (!pred(r)) continue;
      s += r.amount_p;
    }
    return s;
  };

  const checks = [];

  const addP = ({ category, label, detail, a, b, aSource, bSource, unit = 'p_signed', tol = TOL }) => {
    let status;
    if (a == null || b == null) status = 'no_data';
    else if (Math.abs(Number(a) - Number(b)) <= tol) status = 'pass';
    else status = 'fail';
    checks.push({ category, label, detail, a, b, aSource, bSource, unit, status });
  };

  // ── INCOME ─────────────────────────────────────────────────
  // Year-by-year revenue tie: Income tab back-derives from these same rows,
  // so the engine's revenue_total should equal sum of revenue_private +
  // revenue_la_funded for each year.
  for (let y = 1; y <= horizonYears; y++) {
    const ps = yearPeriods(y);
    if (ps.length === 0) continue;
    const total = sumNT('pnl.revenue_total', ps);
    const split = sumNT('pnl.revenue_private', ps) + sumNT('pnl.revenue_la_funded', ps);
    addP({
      category: 'Income',
      label: `Y${y} revenue total = Private + LA funded`,
      a: total, aSource: 'pnl.revenue_total',
      b: split, bSource: 'pnl.revenue_private + pnl.revenue_la_funded',
    });
  }

  // Income vs upstream: sum of `revenue` upstream rows = pnl.revenue_total
  // (without inflation uplift since pnl.revenue_total already includes it).
  // We use the upstream sum × (1 + income_inflation_factor − 1) — easier
  // to compare upstream sum + inflation_uplift to revenue_total.
  for (let y = 1; y <= horizonYears; y++) {
    const ps = yearPeriods(y);
    if (ps.length === 0) continue;
    const upstreamRev = sumPredicate(r => r.nominal_type === 'revenue', ps);
    const inflationUplift = sumNT('pnl.income_inflation_uplift', ps);
    const reconstructed = upstreamRev + inflationUplift;
    const total = sumNT('pnl.revenue_total', ps);
    addP({
      category: 'Income',
      label: `Y${y} P&L revenue = upstream services + inflation uplift`,
      detail: 'Engine should produce P&L revenue from services_childcare rows × inflation factor',
      a: total, aSource: 'pnl.revenue_total',
      b: reconstructed, bSource: 'Σ revenue + pnl.income_inflation_uplift',
    });
  }

  // ── P&L ────────────────────────────────────────────────────
  // EBITDA = Revenue − Operating costs (P&L cost is signed negative)
  for (let y = 1; y <= horizonYears; y++) {
    const ps = yearPeriods(y);
    if (ps.length === 0) continue;
    const rev = sumNT('pnl.revenue_total', ps);
    const cost = sumNT('pnl.cost_total', ps);   // negative
    const ebitdaCalc = rev + cost;
    const ebitdaEmitted = sumNT('pnl.ebitda', ps);
    addP({
      category: 'P&L',
      label: `Y${y} EBITDA = Revenue − Costs`,
      a: ebitdaEmitted, aSource: 'pnl.ebitda',
      b: ebitdaCalc,    bSource: 'pnl.revenue_total + pnl.cost_total',
    });
  }

  // Cost total = sum of cost categories
  for (let y = 1; y <= horizonYears; y++) {
    const ps = yearPeriods(y);
    if (ps.length === 0) continue;
    const cat = ['pnl.cost_staff_direct', 'pnl.cost_direct_costs', 'pnl.cost_staff_overhead',
                 'pnl.cost_premises', 'pnl.cost_utilities', 'pnl.cost_other_overhead',
                 'pnl.cost_admin', 'pnl.cost_pre_opening']
                .reduce((a, nt) => a + sumNT(nt, ps), 0);
    const total = sumNT('pnl.cost_total', ps);
    addP({
      category: 'P&L',
      label: `Y${y} Cost total = Σ cost categories`,
      detail: 'Direct staff + Direct costs + Overhead staff + Premises + Utilities + Other OH + Admin + Pre-opening',
      a: total, aSource: 'pnl.cost_total',
      b: cat,   bSource: '8 cost rows summed',
    });
  }

  // NPAT = PBT + Tax (tax is signed negative on P&L)
  for (let y = 1; y <= horizonYears; y++) {
    const ps = yearPeriods(y);
    if (ps.length === 0) continue;
    const pbt = sumNT('pnl.pbt', ps);
    const tax = sumNT('pnl.tax_total', ps);
    const npatCalc = pbt + tax;
    const npat = sumNT('pnl.npat', ps);
    addP({
      category: 'P&L',
      label: `Y${y} NPAT = PBT + Tax`,
      a: npat,     aSource: 'pnl.npat',
      b: npatCalc, bSource: 'pnl.pbt + pnl.tax_total',
    });
  }

  // ── CASHFLOW ───────────────────────────────────────────────
  // Total cash out = One-off + Recurring + Financing & tax (subtotals are
  // emitted; check they actually sum to the cf.out_total)
  for (let y = 1; y <= horizonYears; y++) {
    const ps = yearPeriods(y);
    if (ps.length === 0) continue;
    const oneOff = sumNT('cf.out.one_off_total', ps);
    const recurring = sumNT('cf.out.recurring_total', ps);
    const finTax = sumNT('cf.out.fin_tax_total', ps);
    const total = sumNT('cf.out_total', ps);
    const sumOf = oneOff + recurring + finTax;
    addP({
      category: 'Cashflow',
      label: `Y${y} Total cash out = One-off + Recurring + Financing/Tax`,
      a: total, aSource: 'cf.out_total',
      b: sumOf, bSource: 'one_off + recurring + fin_tax subtotals',
    });
  }

  // Net movement = Total in − Total out − WC movement
  for (let y = 1; y <= horizonYears; y++) {
    const ps = yearPeriods(y);
    if (ps.length === 0) continue;
    const inT = sumNT('cf.in_total', ps);
    const outT = sumNT('cf.out_total', ps);   // signed negative
    const wc = sumNT('cf.wc_movement', ps);   // signed
    const netCalc = inT + outT + wc;          // (inT) - magnitude(outT) +/- wc
    const net = sumNT('cf.net_movement', ps);
    addP({
      category: 'Cashflow',
      label: `Y${y} Net cash movement = In + Out + WC`,
      a: net, aSource: 'cf.net_movement',
      b: netCalc, bSource: 'cf.in_total + cf.out_total + cf.wc_movement',
    });
  }

  // Cashflow closing cash = end-of-period BS cash (engine validates per
  // period, but a year-end view is a useful smoke test too).
  if (lastPeriod != null) {
    const cfClose = lastNT('cf.closing_cash');
    const bsCash = lastNT('bs.cash');
    addP({
      category: 'Cashflow',
      label: 'Final closing cash = BS cash (last period)',
      a: cfClose, aSource: 'cf.closing_cash @ last period',
      b: bsCash,  bSource: 'bs.cash @ last period',
    });
  }

  // ── BALANCE SHEET ─────────────────────────────────────────
  // Assets = Liabilities + Equity at last period
  if (lastPeriod != null) {
    const assets = lastNT('bs.total_assets');
    const liabEq = lastNT('bs.total_liab_equity');
    addP({
      category: 'Balance sheet',
      label: 'BS balances: Total assets = Total L + E (last period)',
      a: assets, aSource: 'bs.total_assets',
      b: liabEq, bSource: 'bs.total_liab_equity',
    });

    // Net assets = Equity (last period)
    const netAssets = lastNT('bs.net_assets');
    const equity = lastNT('bs.equity');
    addP({
      category: 'Balance sheet',
      label: 'Net assets = Equity (last period)',
      a: netAssets, aSource: 'bs.net_assets',
      b: equity,    bSource: 'bs.equity',
    });

    // Current assets = cash + debtors private + debtors LA
    const ca = lastNT('bs.current_assets');
    const caCalc = (lastNT('bs.cash') || 0)
      + (lastNT('bs.debtors_private') || 0)
      + (lastNT('bs.debtors_la') || 0);
    addP({
      category: 'Balance sheet',
      label: 'Current assets = Cash + Debtors (last period)',
      a: ca,     aSource: 'bs.current_assets',
      b: caCalc, bSource: 'bs.cash + bs.debtors_private + bs.debtors_la',
    });

    // Fixed assets net = gross − accumulated depreciation
    const faNet = lastNT('bs.fixed_assets_net');
    const faGross = lastNT('bs.fixed_assets_gross') || 0;
    const accDep = lastNT('bs.accumulated_depreciation') || 0;
    addP({
      category: 'Balance sheet',
      label: 'Fixed assets net = Gross + Accumulated depreciation',
      detail: 'bs.accumulated_depreciation is signed negative on BS rows',
      a: faNet, aSource: 'bs.fixed_assets_net',
      b: faGross + accDep, bSource: 'bs.fixed_assets_gross + bs.accumulated_depreciation',
    });
  }

  // ── INFLATION RECONCILIATION ──────────────────────────────
  // The engine emits upstream cost rows (staff_cost / overhead / cost_of_sales)
  // at BASE values, then the P&L cost_total is loaded with the cost-inflation
  // factor (1 + cost_pct)^(year-1). The `pnl.cost_inflation_uplift` row carries
  // the loading separately so we can reconcile:
  //
  //   |pnl.cost_total| = Σ upstream costs (base) + |pnl.cost_inflation_uplift|
  //
  // If this fails, inflation isn't being applied consistently.
  for (let y = 1; y <= horizonYears; y++) {
    const ps = yearPeriods(y);
    if (ps.length === 0) continue;
    const upstreamTotal = sumPredicate(r =>
      r.nominal_type === 'staff_cost' || r.nominal_type === 'overhead' || r.nominal_type === 'cost_of_sales'
    , ps);
    const pnlCostTotal = -sumNT('pnl.cost_total', ps);          // signed -ve on P&L → make +ve
    const inflationUplift = -sumNT('pnl.cost_inflation_uplift', ps);   // signed -ve → +ve
    addP({
      category: 'P&L',
      label: `Y${y} P&L cost = Upstream costs (base) + Inflation uplift`,
      detail: 'Verifies the cost-inflation factor is applied consistently across staff_cost, overhead and cost_of_sales rows.',
      a: pnlCostTotal,                aSource: '|pnl.cost_total|',
      b: upstreamTotal + inflationUplift, bSource: 'Σ upstream costs + |pnl.cost_inflation_uplift|',
    });
  }

  // Equivalent reconciliation for revenue: P&L revenue_total = upstream revenue (base) + income inflation uplift
  for (let y = 1; y <= horizonYears; y++) {
    const ps = yearPeriods(y);
    if (ps.length === 0) continue;
    const upstreamRev = sumPredicate(r => r.nominal_type === 'revenue', ps);
    const pnlRev = sumNT('pnl.revenue_total', ps);
    const incInflation = sumNT('pnl.income_inflation_uplift', ps);
    addP({
      category: 'P&L',
      label: `Y${y} P&L revenue = Upstream revenue (base) + Inflation uplift`,
      detail: 'Verifies the income-inflation factor is applied consistently across all revenue rows.',
      a: pnlRev,                aSource: 'pnl.revenue_total',
      b: upstreamRev + incInflation, bSource: 'Σ upstream revenue + pnl.income_inflation_uplift',
    });
  }

  // ── CAPACITIES ────────────────────────────────────────────
  // Engine's metric.locations_active at last period should equal count of
  // entities whose opening_month_offset ≤ last period.
  if (lastPeriod != null) {
    const expectedActive = entities.filter(e =>
      (e.config?.opening_month_offset ?? 0) <= lastPeriod
    ).length;
    const emitted = lastNT('metric.locations_active') || 0;
    addP({
      category: 'Capacities',
      label: 'Active locations (last period) = entities open by then',
      a: emitted, aSource: 'metric.locations_active',
      b: expectedActive, bSource: `count(entities with opening_month_offset ≤ ${lastPeriod})`,
      unit: 'count',
      tol: 0,
    });

    // Total square feet (last period) = sum of entity.config.sq_ft for active locations
    const expectedSqft = entities
      .filter(e => (e.config?.opening_month_offset ?? 0) <= lastPeriod)
      .reduce((a, e) => a + (Number(e.config?.sq_ft) || 0), 0);
    const emittedSqft = lastNT('metric.sqft_total') || 0;
    addP({
      category: 'Capacities',
      label: 'Total sq ft (last period) = Σ entity.sq_ft for active locations',
      a: emittedSqft, aSource: 'metric.sqft_total',
      b: expectedSqft, bSource: 'Σ entity.config.sq_ft',
      unit: 'count',
      tol: 0,
    });
  }

  return checks;
}

const th  = { padding: '8px 10px', textAlign: 'left', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: colors.muted, borderBottom: `1px solid ${colors.border}` };
const thR = { ...th, textAlign: 'right' };
const td  = { padding: '8px 10px', verticalAlign: 'top', color: colors.ink };
const tdR = { ...td, textAlign: 'right', fontFamily: 'ui-monospace, monospace' };
