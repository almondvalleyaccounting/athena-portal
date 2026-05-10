// KPIs trend — line charts of key ratios over the forecast horizon.
// Pure SVG; no chart library dependency.

import React, { useMemo, useState } from 'react';
import { colors, fmtP, fontStack, serifStack, H2 } from '../components/ui';
import LocationFilter, { resolveFilterToEntityIds, filterLabel } from '../components/LocationFilter';

export default function KpisTrendView({
  outputs, forecast, periods,
  entities = [], groups = [], assignments = [],
  filter, onFilterChange,
}) {
  const [granularity, setGranularity] = useState('quarterly');

  const entityIds = useMemo(() => resolveFilterToEntityIds(filter, entities, assignments),
    [filter, entities, assignments]);

  const grouped = groupPeriods(periods, granularity);

  const series = useMemo(() => buildSeries(outputs, grouped, entityIds), [outputs, grouped, entityIds]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
        <H2>
          KPI trends <span style={{ fontSize: 13, fontWeight: 400, color: colors.muted, marginLeft: 8 }}>· {filterLabel(filter, entities, groups)}</span>
        </H2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {onFilterChange && (
            <LocationFilter entities={entities} groups={groups} assignments={assignments} value={filter} onChange={onFilterChange} />
          )}
          <div style={{ display: 'flex', gap: 4, fontSize: 11 }}>
            {['monthly', 'quarterly', 'annual'].map(g => (
              <button key={g} onClick={() => setGranularity(g)}
                style={{
                  padding: '5px 9px', borderRadius: 6,
                  background: granularity === g ? colors.ink : '#fff',
                  color: granularity === g ? '#fff' : colors.inkSoft,
                  border: `1px solid ${colors.border}`,
                  cursor: 'pointer', fontFamily: fontStack, textTransform: 'capitalize',
                }}>{g}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
        <ChartCard title="Revenue & EBITDA" subtitle="absolute, £ per period" lines={[
          { label: 'Revenue', values: series.revenue, color: '#0e7fe0', fmt: 'gbp' },
          { label: 'EBITDA', values: series.ebitda, color: '#16a34a', fmt: 'gbp' },
        ]} grouped={grouped} />

        <ChartCard title="Margins" subtitle="% of revenue" lines={[
          { label: 'EBITDA %', values: series.ebitdaPct, color: '#16a34a', fmt: 'pct' },
          { label: 'PBT %', values: series.pbtPct, color: '#0e7fe0', fmt: 'pct' },
          { label: 'NPAT %', values: series.npatPct, color: '#7c3aed', fmt: 'pct' },
        ]} grouped={grouped} unitFmt="pct" />

        <ChartCard title="Cost ratios" subtitle="% of revenue" lines={[
          { label: 'Staff / turnover', values: series.staffPct, color: '#dc2626', fmt: 'pct' },
          { label: 'Premises / turnover', values: series.premisesPct, color: '#b45309', fmt: 'pct' },
          { label: 'Overheads / turnover', values: series.overheadsPct, color: '#475569', fmt: 'pct' },
        ]} grouped={grouped} unitFmt="pct" />

        <ChartCard title="Headcount & active locations" subtitle="end of period" lines={[
          { label: 'Headcount', values: series.headcount, color: '#0e7fe0', fmt: 'count' },
          { label: 'Locations', values: series.locations, color: '#16a34a', fmt: 'count', dual: true },
        ]} grouped={grouped} unitFmt="count" />

        <ChartCard title="Cash position" subtitle="closing cash, £ per period" lines={[
          { label: 'Closing cash', values: series.cash, color: '#0e7fe0', fmt: 'gbp' },
        ]} grouped={grouped} />

        <ChartCard title="Debt structure" subtitle="end of period balance, £" lines={[
          { label: 'Long-term loans', values: series.longTermDebt, color: '#0e7fe0', fmt: 'gbp' },
          { label: 'Directors\' loans', values: series.directorsDebt, color: '#7c3aed', fmt: 'gbp' },
          { label: 'Current portion', values: series.currentDebt, color: '#dc2626', fmt: 'gbp' },
        ]} grouped={grouped} />

        <ChartCard title="DSCR (rolling 12m)" subtitle="× cover · target ≥ 1.25×" lines={[
          { label: 'DSCR', values: series.dscr, color: '#16a34a', fmt: 'x' },
        ]} grouped={grouped} unitFmt="x" referenceLine={1.25} referenceLabel="1.25× covenant" />

        <ChartCard title="Ratio compliance" subtitle="practitioners provided ÷ required · target ≥ 1.00×" lines={[
          { label: 'Compliance', values: series.ratioCompliance, color: '#dc2626', fmt: 'x' },
        ]} grouped={grouped} unitFmt="x" referenceLine={1.0} referenceLabel="1.00× statutory" />

        <ChartCard title="EBITDA per sq ft" subtitle="annualised, £ / sq ft" lines={[
          { label: 'EBITDA / sq ft (ann.)', values: series.ebitdaPerSqftAnn, color: '#16a34a', fmt: 'gbp_psf' },
        ]} grouped={grouped} unitFmt="gbp_psf" />
      </div>
    </div>
  );
}

// ── Chart primitive ──────────────────────────────────────────────

function ChartCard({ title, subtitle, lines, grouped, unitFmt = 'gbp', referenceLine, referenceLabel }) {
  const allValues = lines.flatMap(l => l.values).filter(v => v != null && isFinite(v));
  if (allValues.length === 0) {
    return (
      <div style={cardStyle}>
        <div style={cardHeader}>{title}</div>
        <div style={cardSubtitle}>{subtitle}</div>
        <div style={{ padding: 24, color: colors.muted, fontSize: 12, textAlign: 'center' }}>No data — recompute the forecast.</div>
      </div>
    );
  }
  let min = Math.min(...allValues, referenceLine != null ? referenceLine : Infinity);
  let max = Math.max(...allValues, referenceLine != null ? referenceLine : -Infinity);
  if (min === max) { min -= 1; max += 1; }
  if (min > 0) min = Math.min(0, min);   // anchor to zero where positive

  const W = 420, H = 160, pad = { top: 14, right: 12, bottom: 22, left: 50 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const x = (i) => pad.left + (grouped.length === 1 ? innerW / 2 : (i / (grouped.length - 1)) * innerW);
  const y = (v) => pad.top + innerH - ((v - min) / (max - min)) * innerH;

  const tickValues = niceTicks(min, max, 4);
  const fmtAxis = (v) => formatValue(v, unitFmt, true);

  return (
    <div style={cardStyle}>
      <div style={cardHeader}>{title}</div>
      <div style={cardSubtitle}>{subtitle}</div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        {/* Grid + Y-axis ticks */}
        {tickValues.map((tv, i) => (
          <g key={i}>
            <line x1={pad.left} x2={W - pad.right} y1={y(tv)} y2={y(tv)} stroke={colors.borderSoft} strokeWidth="1" />
            <text x={pad.left - 6} y={y(tv) + 3} textAnchor="end" fontSize="9" fill={colors.muted}>{fmtAxis(tv)}</text>
          </g>
        ))}
        {/* Reference line */}
        {referenceLine != null && (
          <g>
            <line x1={pad.left} x2={W - pad.right} y1={y(referenceLine)} y2={y(referenceLine)} stroke="#dc2626" strokeWidth="1" strokeDasharray="3 3" />
            {referenceLabel && (
              <text x={W - pad.right - 4} y={y(referenceLine) - 3} textAnchor="end" fontSize="9" fill="#dc2626">{referenceLabel}</text>
            )}
          </g>
        )}
        {/* Lines */}
        {lines.map((line, li) => {
          const points = line.values.map((v, i) => v == null ? null : `${x(i)},${y(v)}`).filter(Boolean).join(' ');
          if (!points) return null;
          return (
            <polyline key={li} points={points} fill="none" stroke={line.color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
          );
        })}
        {/* Period labels (sparingly to avoid overlap) */}
        {grouped.map((g, i) => {
          const skip = Math.max(1, Math.ceil(grouped.length / 8));
          if (i % skip !== 0 && i !== grouped.length - 1) return null;
          return (
            <text key={i} x={x(i)} y={H - 6} textAnchor="middle" fontSize="9" fill={colors.muted}>{g.label}</text>
          );
        })}
      </svg>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: '4px 10px 10px', fontSize: 11 }}>
        {lines.map((l, i) => {
          const last = [...l.values].reverse().find(v => v != null);
          return (
            <span key={i} style={{ color: colors.inkSoft, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ display: 'inline-block', width: 10, height: 2, background: l.color }} />
              {l.label}: <strong>{last != null ? formatValue(last, l.fmt) : '—'}</strong>
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── Series builder ───────────────────────────────────────────────

function buildSeries(outputs, grouped, entityIds) {
  const inScope = (r) => !entityIds || r.entity_id == null || entityIds.has(r.entity_id);
  const sumOf = (predicate, periods) => {
    let s = 0;
    const setP = new Set(periods);
    for (const r of outputs) {
      if (!setP.has(r.period)) continue;
      if (!inScope(r)) continue;
      if (!predicate(r)) continue;
      s += r.amount_p;
    }
    return s;
  };
  const lastOf = (predicate, periods) => {
    let bestT = -1, bestVal = null;
    for (const r of outputs) {
      if (!periods.includes(r.period)) continue;
      if (!inScope(r)) continue;
      if (!predicate(r)) continue;
      if (r.period > bestT) { bestT = r.period; bestVal = r.amount_p; }
    }
    return bestVal;
  };

  const revenue = grouped.map(g => sumOf(r => r.nominal_type === 'pnl.revenue_total', g.periods) || null);
  const ebitda  = grouped.map(g => sumOf(r => r.nominal_type === 'pnl.ebitda',        g.periods) || null);
  const pbt     = grouped.map(g => sumOf(r => r.nominal_type === 'pnl.pbt',           g.periods));
  const npat    = grouped.map(g => sumOf(r => r.nominal_type === 'pnl.npat',          g.periods));
  const staff   = grouped.map(g => -(sumOf(r => r.nominal_type === 'pnl.cost_staff_direct', g.periods) + sumOf(r => r.nominal_type === 'pnl.cost_management', g.periods)));
  const premises= grouped.map(g => -sumOf(r => r.nominal_type === 'pnl.cost_premises', g.periods));
  const oh      = grouped.map(g => -(sumOf(r => r.nominal_type === 'pnl.cost_utilities', g.periods) + sumOf(r => r.nominal_type === 'pnl.cost_other_overhead', g.periods) + sumOf(r => r.nominal_type === 'pnl.cost_admin', g.periods)));

  const pct = (num, denom) => denom > 0 ? (num / denom) * 100 : null;
  const ebitdaPct = grouped.map((g, i) => pct(ebitda[i], revenue[i]));
  const pbtPct    = grouped.map((g, i) => pct(pbt[i], revenue[i]));
  const npatPct   = grouped.map((g, i) => pct(npat[i], revenue[i]));
  const staffPct  = grouped.map((g, i) => pct(staff[i], revenue[i]));
  const premisesPct = grouped.map((g, i) => pct(premises[i], revenue[i]));
  const overheadsPct = grouped.map((g, i) => pct(oh[i], revenue[i]));

  const headcount = grouped.map(g => lastOf(r => r.nominal_type === 'metric.headcount_total', g.periods));
  const locations = grouped.map(g => lastOf(r => r.nominal_type === 'metric.locations_active', g.periods));
  const cash      = grouped.map(g => lastOf(r => r.nominal_type === 'bs.cash', g.periods));
  const longTermDebt  = grouped.map(g => lastOf(r => r.nominal_type === 'bs.long_term_loans', g.periods));
  const directorsDebt = grouped.map(g => lastOf(r => r.nominal_type === 'bs.directors_loans', g.periods));
  const currentDebt   = grouped.map(g => lastOf(r => r.nominal_type === 'bs.debt_current_portion', g.periods));

  const dscrRaw = grouped.map(g => lastOf(r => r.nominal_type === 'metric.dscr', g.periods));
  const dscr = dscrRaw.map(v => v != null ? v / 10000 : null);
  const ratioCompRaw = grouped.map(g => lastOf(r => r.nominal_type === 'metric.ratio_compliance', g.periods));
  const ratioCompliance = ratioCompRaw.map(v => v != null ? v / 10000 : null);

  const sqft = grouped.map(g => lastOf(r => r.nominal_type === 'metric.sqft_total', g.periods));
  const ebitdaPerSqftAnn = grouped.map((g, i) => {
    const sf = sqft[i];
    const months = g.periods.length;
    if (!sf || sf <= 0 || !ebitda[i] || months === 0) return null;
    return (ebitda[i] / sf) * (12 / months);
  });

  return {
    revenue, ebitda, pbt, npat,
    ebitdaPct, pbtPct, npatPct,
    staffPct, premisesPct, overheadsPct,
    headcount, locations, cash,
    longTermDebt, directorsDebt, currentDebt,
    dscr, ebitdaPerSqftAnn,
    ratioCompliance,
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function groupPeriods(periods, granularity) {
  const groups = [];
  if (granularity === 'monthly') {
    for (const p of periods) groups.push({ label: 'M' + p, periods: [p] });
  } else if (granularity === 'quarterly') {
    for (let i = 0; i < periods.length; i += 3) {
      groups.push({ label: `Q${Math.floor(i / 3) + 1}`, periods: periods.slice(i, i + 3) });
    }
  } else {
    for (let i = 0; i < periods.length; i += 12) {
      groups.push({ label: `Y${Math.floor(i / 12) + 1}`, periods: periods.slice(i, i + 12) });
    }
  }
  return groups;
}

function niceTicks(min, max, count) {
  const range = max - min;
  if (range === 0) return [min];
  const step = niceStep(range / count);
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + 0.0001; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}
function niceStep(rough) {
  const exp = Math.floor(Math.log10(rough));
  const base = rough / Math.pow(10, exp);
  let nice;
  if (base <= 1) nice = 1;
  else if (base <= 2) nice = 2;
  else if (base <= 5) nice = 5;
  else nice = 10;
  return nice * Math.pow(10, exp);
}

function formatValue(v, fmt, axis = false) {
  if (v == null) return '—';
  if (fmt === 'pct') return `${v.toFixed(axis ? 0 : 1)}%`;
  if (fmt === 'count') return Math.round(v).toLocaleString('en-GB');
  if (fmt === 'x') return `${v.toFixed(2)}×`;
  if (fmt === 'gbp_psf') return '£' + (v / 100).toLocaleString('en-GB', { maximumFractionDigits: 1 });
  // gbp (in pence)
  return fmtP(v, { compact: true });
}

const cardStyle = { background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 12, overflow: 'hidden' };
const cardHeader = { padding: '10px 12px 2px', fontFamily: serifStack, fontSize: 16, fontWeight: 500, color: colors.ink };
const cardSubtitle = { padding: '0 12px 8px', fontSize: 11, color: colors.muted };
