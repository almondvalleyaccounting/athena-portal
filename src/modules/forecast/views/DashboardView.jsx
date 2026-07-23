// Dashboard — headline KPIs and capacity / income / cost cuts.
// Reads from fc_output (revenue tagged with revenue_kind + age_band, staff_cost
// tagged with role + age_band) plus entity configs for capacity / sq ft.

import React, { useMemo, useState } from 'react';
import { colors, fmtP, fontStack, KPI, serifStack, H2, Pill } from '../components/ui';
import LocationFilter, { resolveFilterToEntityIds, filterLabel } from '../components/LocationFilter';
import { buildOccupancyIndex, occKey } from '../lib/occupancy.js';

const AGE_BANDS = [
  { key: 'babies',         label: '0-2' },
  { key: 'twos',           label: '2-3' },
  { key: 'three_to_five',  label: '3-5' },
  { key: 'after_school',   label: 'After-school' },
];

export default function DashboardView({
  outputs, forecast, periods, entities = [], groups = [], assignments = [],
  filter, onFilterChange,
}) {
  const [selectedYear, setSelectedYear] = useState(null);

  const entityIds = useMemo(() => resolveFilterToEntityIds(filter, entities, assignments),
    [filter, entities, assignments]);

  // Effective entity set for capacity / sq ft sums
  const scopedEntities = useMemo(() => {
    if (!entityIds) return entities;
    return entities.filter(e => entityIds.has(e.id));
  }, [entities, entityIds]);

  // Subtle members list — show which locations are in scope when filter is non-trivial
  const scopeMembersText = useMemo(() => {
    if (!filter || filter.kind === 'all') return null;
    if (scopedEntities.length === 0) return 'no locations in scope';
    const names = scopedEntities.map(e => e.label).join(', ');
    return `includes ${scopedEntities.length} location${scopedEntities.length !== 1 ? 's' : ''}: ${names}`;
  }, [filter, scopedEntities]);

  const totalYears = Math.ceil((forecast?.horizon_months || 60) / 12);
  const yearOptions = Array.from({ length: totalYears }, (_, i) => i + 1);
  const activeYear = selectedYear ?? Math.min(3, totalYears);    // default to Y3 (steady-ish)
  const yearStart = (activeYear - 1) * 12;
  const yearEnd = Math.min(yearStart + 11, periods.length - 1);
  const yearPeriods = periods.slice(yearStart, yearEnd + 1);
  const lastPeriodOfYear = yearEnd;

  // ── Aggregate capacity / square footage per band across scoped entities ──
  const capByBand = useMemo(() => {
    const acc = { babies: 0, twos: 0, three_to_five: 0, after_school: 0 };
    for (const e of scopedEntities) {
      const cap = e.config?.capacity_by_age_band || {};
      for (const k of Object.keys(acc)) acc[k] += (cap[k] || 0);
    }
    return acc;
  }, [scopedEntities]);

  const totalCapacity = capByBand.babies + capByBand.twos + capByBand.three_to_five + capByBand.after_school;
  const totalSqFt = scopedEntities.reduce((s, e) => s + (e.config?.sq_ft || 0), 0);

  // Engine-emitted occupancy (metric.occupancy_pct) — same numbers the
  // P&L was computed from, including August cohort dips.
  const occIdx = useMemo(() => buildOccupancyIndex(outputs), [outputs]);

  // ── Blended occupancy per band, averaged over selected year, weighted by capacity ──
  const blendedOcc = useMemo(() => {
    // For each entity + band, compute average occupancy over yearPeriods, weighted by capacity.
    const totals = {};
    const weights = {};
    for (const band of Object.keys(capByBand)) {
      totals[band] = 0;
      weights[band] = 0;
    }
    for (const e of scopedEntities) {
      const cap = e.config?.capacity_by_age_band || {};
      for (const band of Object.keys(cap)) {
        const c = cap[band] || 0;
        if (c === 0) continue;
        let yearOccPct = 0;
        for (const t of yearPeriods) yearOccPct += occIdx.get(occKey(e.id, band, t)) ?? 0;
        const avg = yearPeriods.length > 0 ? yearOccPct / yearPeriods.length : 0;
        totals[band] += avg * c;
        weights[band] += c;
      }
    }
    const out = {};
    let allTot = 0, allWt = 0;
    for (const band of Object.keys(capByBand)) {
      out[band] = weights[band] > 0 ? totals[band] / weights[band] : 0;
      allTot += totals[band]; allWt += weights[band];
    }
    out.total = allWt > 0 ? allTot / allWt : 0;
    return out;
  }, [scopedEntities, yearPeriods, occIdx]);

  // ── Income split (funded vs private) for the year ──
  const incomeSplit = useMemo(() => {
    let priv = 0, funded = 0;
    for (const r of outputs) {
      if (r.module_key !== 'services_childcare') continue;
      if (!yearPeriods.includes(r.period)) continue;
      if (entityIds && !entityIds.has(r.entity_id)) continue;
      if (r.tags?.revenue_kind === 'funded') funded += r.amount_p;
      else priv += r.amount_p;
    }
    return { private: priv, funded, total: priv + funded };
  }, [outputs, yearPeriods, entityIds]);

  // ── Income by age band (year totals) ──
  const incomeByBand = useMemo(() => {
    const acc = { babies: 0, twos: 0, three_to_five: 0, after_school: 0 };
    for (const r of outputs) {
      if (r.module_key !== 'services_childcare') continue;
      if (!yearPeriods.includes(r.period)) continue;
      if (entityIds && !entityIds.has(r.entity_id)) continue;
      const band = r.tags?.age_band;
      if (band && acc[band] != null) acc[band] += r.amount_p;
    }
    return acc;
  }, [outputs, yearPeriods, entityIds]);

  // ── Cost by band (direct staff) + central split into 4 categories ──
  const costByBand = useMemo(() => {
    const acc = { babies: 0, twos: 0, three_to_five: 0, after_school: 0 };
    const central = { management: 0, admin: 0, premises: 0, overheads: 0 };
    for (const r of outputs) {
      if (!yearPeriods.includes(r.period)) continue;
      if (entityIds && r.entity_id && !entityIds.has(r.entity_id)) continue;

      // Staff cost tagged with age_band → direct band cost
      if (r.nominal_type === 'staff_cost' && r.tags?.age_band) {
        const band = r.tags.age_band;
        if (acc[band] != null) acc[band] += r.amount_p;
        continue;
      }

      // Staff not tied to an age band (setting/assistant managers, cook,
      // exec/senior mgr/admin) + pre-opening staffing → the central
      // management & support bucket. Previously only the legacy
      // 'manager' role matched, so these fell out of every bucket.
      if (r.nominal_type === 'staff_cost') {
        central.management += r.amount_p;
        continue;
      }

      if (r.nominal_type === 'overhead') {
        const lbl = r.line_label || '';
        if (lbl === 'Central admin') central.admin += r.amount_p;
        else if (['Rent', 'Service charge', 'NDR', 'Maintenance'].includes(lbl)) central.premises += r.amount_p;
        else central.overheads += r.amount_p;   // utilities, insurance, software, consumables, marketing, professional fees, pre-opening
        continue;
      }

      if (r.nominal_type === 'cost_of_sales') {
        central.overheads += r.amount_p;
      }
    }
    const directTotal = acc.babies + acc.twos + acc.three_to_five + acc.after_school;
    const centralTotal = central.management + central.admin + central.premises + central.overheads;
    return { ...acc, central, directTotal, centralTotal, total: directTotal + centralTotal };
  }, [outputs, yearPeriods, entityIds]);

  // ── Headline financials ──
  const headlines = useMemo(() => {
    const sum = (nt) => outputs.filter(r => r.nominal_type === nt && yearPeriods.includes(r.period))
      .reduce((s, r) => s + r.amount_p, 0);
    const last = (nt) => {
      const row = outputs.filter(r => r.nominal_type === nt && r.period === lastPeriodOfYear).pop();
      return row?.amount_p ?? 0;
    };
    const rev = sum('pnl.revenue_total');
    const ebitda = sum('pnl.ebitda');
    const npat = sum('pnl.npat');
    const cash = last('bs.cash');
    const ebitdaMargin = rev > 0 ? (ebitda / rev) * 100 : 0;
    return { rev, ebitda, npat, cash, ebitdaMargin };
  }, [outputs, yearPeriods, lastPeriodOfYear]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ fontFamily: serifStack, fontSize: 22, fontWeight: 500, color: colors.ink, margin: 0 }}>
            Dashboard <span style={{ fontSize: 13, fontWeight: 400, color: colors.muted, marginLeft: 8 }}>· {filterLabel(filter, entities, groups)} · Y{activeYear}</span>
          </h2>
          {scopeMembersText && (
            <p style={{ fontSize: 11, color: colors.muted, margin: '4px 0 0', fontStyle: 'italic' }}>
              {scopeMembersText}
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {onFilterChange && (
            <LocationFilter entities={entities} groups={groups} assignments={assignments}
              value={filter} onChange={onFilterChange} />
          )}
          <select value={activeYear} onChange={(e) => setSelectedYear(Number(e.target.value))}
            style={{ padding: '7px 10px', borderRadius: 8, border: `1px solid ${colors.border}`, fontSize: 12, fontFamily: fontStack, background: '#fff' }}>
            {yearOptions.map(y => <option key={y} value={y}>Year {y}</option>)}
          </select>
        </div>
      </div>

      {/* Operational KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 14 }}>
        <KPI label="Square footage" value={totalSqFt.toLocaleString('en-GB') + ' sq ft'} hint={`${scopedEntities.length} location${scopedEntities.length !== 1 ? 's' : ''}`} />
        <KPI label="Total capacity" value={totalCapacity + ' children'} hint={`${capByBand.babies} 0-2 · ${capByBand.twos} 2-3 · ${capByBand.three_to_five} 3-5 · ${capByBand.after_school} AS`} />
        <KPI label={`Blended occupancy · Y${activeYear}`} value={fmtPct(blendedOcc.total)} hint="weighted by capacity, averaged over year" />
        <KPI label="Effective children (avg)" value={Math.round(totalCapacity * blendedOcc.total / 100).toLocaleString('en-GB')} hint="capacity × blended occupancy" />
      </div>

      {/* Headline financials */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 14 }}>
        <KPI label={`Revenue · Y${activeYear}`} value={fmtP(headlines.rev, { compact: true })} />
        <KPI label="EBITDA" value={fmtP(headlines.ebitda, { compact: true })} hint={fmtPct(headlines.ebitdaMargin) + ' margin'} color={headlines.ebitda >= 0 ? colors.green : colors.red} />
        <KPI label="NPAT" value={fmtP(headlines.npat, { compact: true })} color={headlines.npat >= 0 ? colors.green : colors.red} />
        <KPI label={`Cash · end Y${activeYear}`} value={fmtP(headlines.cash, { compact: true })} />
      </div>

      {/* Ratio compliance — show as a KPI tile */}
      {(() => {
        // Pull last period's ratio compliance from outputs
        const last = [...outputs].filter(o => o.nominal_type === 'metric.ratio_compliance' && yearPeriods.includes(o.period))
          .sort((a, b) => a.period - b.period).pop();
        const compliance = last ? last.amount_p / 10000 : null;
        const required = [...outputs].filter(o => o.nominal_type === 'metric.ratio_required' && yearPeriods.includes(o.period))
          .sort((a, b) => a.period - b.period).pop();
        const provided = [...outputs].filter(o => o.nominal_type === 'metric.ratio_provided' && yearPeriods.includes(o.period))
          .sort((a, b) => a.period - b.period).pop();
        if (compliance == null) return null;
        const tone = compliance >= 1 ? colors.green : (compliance >= 0.9 ? colors.amber : colors.red);
        return (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 14 }}>
            <KPI
              label={`Ratio compliance · end Y${activeYear}`}
              value={`${compliance.toFixed(2)}×`}
              hint={`provided ${provided?.amount_p ?? 0} / required ${required?.amount_p ?? 0}`}
              color={tone}
            />
          </div>
        );
      })()}

      {/* Cost-to-turnover ratios */}
      {(() => {
        const directStaff = AGE_BANDS.reduce((s, b) => s + costByBand[b.key], 0);
        const totalStaff = directStaff + costByBand.central.management;
        const r = (n) => incomeSplit.total > 0 ? (n / incomeSplit.total) * 100 : null;
        const ratios = [
          { label: 'Staff costs / turnover', value: r(totalStaff), good: 55 },
          { label: 'Premises / turnover', value: r(costByBand.central.premises), good: 12 },
          { label: 'Utilities / turnover', value: r(costByBand.central.overheads), good: 8 },   // overheads bucket includes utilities + others
          { label: 'Admin / turnover', value: r(costByBand.central.admin), good: 5 },
        ];
        return (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 22 }}>
            {ratios.map((rr, i) => (
              <KPI key={i}
                label={rr.label}
                value={rr.value == null ? '—' : `${rr.value.toFixed(1)}%`}
                hint={rr.good ? `sector ~${rr.good}%` : undefined}
                color={rr.value != null && rr.value > rr.good * 1.4 ? colors.amber : colors.ink}
              />
            ))}
          </div>
        );
      })()}

      {/* Income split: funded vs private — visual context */}
      <Section title={`Income split — funded vs private · Y${activeYear}`}>
        <SplitBar
          left={{ label: 'Private fees', amount: incomeSplit.private, color: '#0e7fe0' }}
          right={{ label: 'LA funded', amount: incomeSplit.funded, color: '#16a34a' }}
        />
      </Section>

      {/* Consolidated matrix: capacity / occupancy / income / cost / net */}
      <Section title={`Capacity, income & costs · Y${activeYear}`}>
        <p style={{ fontSize: 11, color: colors.muted, margin: '0 0 10px' }}>
          Direct rows show fees and ratio-driven staff cost per age band. Central rows split shared costs:
          <strong> Management</strong> = manager salaries + pre-opening staffing;
          <strong> Admin</strong> = central admin overhead;
          <strong> Premises</strong> = rent / NDR / service charge / maintenance;
          <strong> Overheads</strong> = utilities, insurance, software, consumables, marketing, professional fees, pre-opening overhead.
          (Depreciation and interest are shown on the P&L below EBITDA.)
        </p>
        <table style={tableStyle}>
          <thead>
            <tr style={trHead}>
              <th style={th}>Category</th>
              <th style={{ ...th, textAlign: 'right' }}>Capacity</th>
              <th style={{ ...th, textAlign: 'right' }}>Occ %</th>
              <th style={{ ...th, textAlign: 'right' }}>Children</th>
              <th style={{ ...th, textAlign: 'right' }}>Income</th>
              <th style={{ ...th, textAlign: 'right' }}>Cost</th>
              <th style={{ ...th, textAlign: 'right' }}>Net</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ ...tr, background: '#f1f5f9' }}>
              <td style={{ ...td, fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: colors.muted }} colSpan={7}>
                Direct (by age band)
              </td>
            </tr>
            {AGE_BANDS.map(b => {
              const cap = capByBand[b.key];
              const occ = blendedOcc[b.key];
              const children = cap * occ / 100;
              const income = incomeByBand[b.key];
              const cost = costByBand[b.key];
              const net = income - cost;
              if (cap === 0 && income === 0 && cost === 0) return null;
              return (
                <tr key={b.key} style={tr}>
                  <td style={td}>{b.label}</td>
                  <td style={tdR}>{cap || '—'}</td>
                  <td style={tdR}>{cap > 0 ? fmtPct(occ) : '—'}</td>
                  <td style={tdR}>{cap > 0 ? children.toFixed(1) : '—'}</td>
                  <td style={tdR}>{fmtP(income, { compact: true })}</td>
                  <td style={tdR}>{fmtP(cost, { compact: true })}</td>
                  <td style={{ ...tdR, color: net >= 0 ? colors.green : colors.red }}>{fmtP(net, { compact: true })}</td>
                </tr>
              );
            })}
            <tr style={{ ...tr, fontWeight: 700, background: colors.bgSoft }}>
              <td style={td}>Direct subtotal</td>
              <td style={tdR}>{totalCapacity}</td>
              <td style={tdR}>{totalCapacity > 0 ? fmtPct(blendedOcc.total) : '—'}</td>
              <td style={tdR}>{totalCapacity > 0 ? (totalCapacity * blendedOcc.total / 100).toFixed(1) : '—'}</td>
              <td style={tdR}>{fmtP(incomeSplit.total, { compact: true })}</td>
              <td style={tdR}>{fmtP(costByBand.directTotal, { compact: true })}</td>
              <td style={{ ...tdR, color: (incomeSplit.total - costByBand.directTotal) >= 0 ? colors.green : colors.red }}>
                {fmtP(incomeSplit.total - costByBand.directTotal, { compact: true })}
              </td>
            </tr>

            <tr style={{ ...tr, background: '#f1f5f9' }}>
              <td style={{ ...td, fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: colors.muted }} colSpan={7}>
                Central
              </td>
            </tr>
            <CentralRow label="Management & support staff" hint="managers, admin, cooks + pre-opening staffing" amount={costByBand.central.management} />
            <CentralRow label="Admin" hint="central admin overhead" amount={costByBand.central.admin} />
            <CentralRow label="Premises" hint="rent / service charge / NDR / maintenance" amount={costByBand.central.premises} />
            <CentralRow label="Overheads" hint="utilities, insurance, software, consumables, marketing, professional fees, pre-opening" amount={costByBand.central.overheads} />
            <tr style={{ ...tr, fontWeight: 700, background: colors.bgSoft }}>
              <td style={td}>Central subtotal</td>
              <td style={tdR}>—</td>
              <td style={tdR}>—</td>
              <td style={tdR}>—</td>
              <td style={tdR}>—</td>
              <td style={tdR}>{fmtP(costByBand.centralTotal, { compact: true })}</td>
              <td style={{ ...tdR, color: colors.red }}>{fmtP(-costByBand.centralTotal, { compact: true })}</td>
            </tr>

            <tr style={{ ...tr, fontWeight: 700, background: colors.ink, color: '#fff' }}>
              <td style={{ ...td, color: '#fff' }}>Total · Y{activeYear}</td>
              <td style={{ ...tdR, color: '#fff' }}>{totalCapacity}</td>
              <td style={{ ...tdR, color: '#fff' }}>{totalCapacity > 0 ? fmtPct(blendedOcc.total) : '—'}</td>
              <td style={{ ...tdR, color: '#fff' }}>{totalCapacity > 0 ? (totalCapacity * blendedOcc.total / 100).toFixed(1) : '—'}</td>
              <td style={{ ...tdR, color: '#fff' }}>{fmtP(incomeSplit.total, { compact: true })}</td>
              <td style={{ ...tdR, color: '#fff' }}>{fmtP(costByBand.total, { compact: true })}</td>
              <td style={{ ...tdR, color: (incomeSplit.total - costByBand.total) >= 0 ? '#86efac' : '#fca5a5', fontWeight: 700 }}>
                {fmtP(incomeSplit.total - costByBand.total, { compact: true })}
              </td>
            </tr>
          </tbody>
        </table>
      </Section>
    </div>
  );
}

function CentralRow({ label, hint, amount }) {
  return (
    <tr style={{ borderBottom: `1px solid ${colors.borderSoft}` }}>
      <td style={{ padding: '8px 12px', color: colors.ink }}>
        <strong>{label}</strong>
        <span style={{ display: 'block', fontSize: 10, color: colors.muted, fontWeight: 400 }}>{hint}</span>
      </td>
      <td style={{ padding: '8px 12px', textAlign: 'right', color: colors.muted }}>—</td>
      <td style={{ padding: '8px 12px', textAlign: 'right', color: colors.muted }}>—</td>
      <td style={{ padding: '8px 12px', textAlign: 'right', color: colors.muted }}>—</td>
      <td style={{ padding: '8px 12px', textAlign: 'right', color: colors.muted }}>—</td>
      <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'ui-monospace, monospace', color: colors.ink }}>{fmtP(amount, { compact: true })}</td>
      <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'ui-monospace, monospace', color: amount > 0 ? colors.red : colors.muted }}>
        {amount > 0 ? fmtP(-amount, { compact: true }) : '—'}
      </td>
    </tr>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

function fmtPct(n, dp = 1) {
  if (n == null) return '—';
  return Number(n).toFixed(dp) + '%';
}

function Section({ title, children }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <H2>{title}</H2>
      {children}
    </section>
  );
}

function SplitBar({ left, right }) {
  const total = left.amount + right.amount;
  const lp = total > 0 ? (left.amount / total) * 100 : 0;
  const rp = total > 0 ? (right.amount / total) * 100 : 0;
  return (
    <div>
      <div style={{ display: 'flex', height: 36, borderRadius: 6, overflow: 'hidden', border: `1px solid ${colors.border}`, marginBottom: 8 }}>
        {total > 0 ? (
          <>
            <div style={{ width: lp + '%', background: left.color, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600 }}>
              {lp >= 8 ? `${left.label} · ${fmtPct(lp)}` : ''}
            </div>
            <div style={{ width: rp + '%', background: right.color, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600 }}>
              {rp >= 8 ? `${right.label} · ${fmtPct(rp)}` : ''}
            </div>
          </>
        ) : (
          <div style={{ flex: 1, background: colors.bgSoft, color: colors.muted, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>
            No revenue this year
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 24, fontSize: 12, color: colors.inkSoft }}>
        <div><span style={{ display: 'inline-block', width: 10, height: 10, background: left.color, borderRadius: 2, marginRight: 6 }} />
          {left.label}: <strong>{fmtP(left.amount, { compact: true })}</strong> ({fmtPct(lp)})</div>
        <div><span style={{ display: 'inline-block', width: 10, height: 10, background: right.color, borderRadius: 2, marginRight: 6 }} />
          {right.label}: <strong>{fmtP(right.amount, { compact: true })}</strong> ({fmtPct(rp)})</div>
      </div>
    </div>
  );
}

const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: fontStack, background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 8 };
const trHead = { background: colors.bgSoft };
const tr = { borderBottom: `1px solid ${colors.borderSoft}` };
const th = { padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: colors.muted };
const td = { padding: '8px 12px', color: colors.ink };
const tdR = { ...td, textAlign: 'right', fontFamily: 'ui-monospace, monospace' };
