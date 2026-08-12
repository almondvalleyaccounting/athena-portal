// Generic period-x-line grid for P&L, BS, Cashflow.
// - Supports a "scope" filter (by location or group) — recomputes lines
//   from upstream rows when filtered.
// - Cells are clickable to drill into contributors.
// - Compact spacing by default for density; lines tagged group:'inflation'
//   are hidden behind an expand control on the P&L.
// - P&L gets a KPI footer with per-period operational ratios and sq ft.
// - BS gets a ratios panel below the table.

import React, { useMemo, useState } from 'react';
import { colors, fmtP, fontStack, periodLabel } from '../components/ui';
import { scopedAggregate } from '../lib/aggregator';
import LocationFilter, { resolveFilterToEntityIds, filterLabel } from '../components/LocationFilter';
import DrillModal from '../components/DrillModal';

export default function StatementView({
  title, lines, outputs, forecast, periods, openingPeriod, scenarioId,
  // Filtering / scope
  entities = [], groups = [], assignments = [], filter, onFilterChange,
  // Behaviour
  variant,   // 'pnl' | 'bs' | 'cf' | undefined
}) {
  const [granularity, setGranularity] = useState('annual');
  const [drillCell, setDrillCell] = useState(null);
  const [showInflation, setShowInflation] = useState(false);

  const entityIds = useMemo(() => resolveFilterToEntityIds(filter, entities, assignments),
    [filter, entities, assignments]);

  const usingScoped = !!entityIds;

  const scopedMap = useMemo(() => {
    if (!usingScoped) return null;
    return scopedAggregate({
      outputs, periods, entityIds, entities,
      // 'derive' inherits the scenario's inflation + dividend policy and
      // starts cash from the capital attributed to the in-scope locations
      // (central/unallocated pot excluded — see aggregator.js).
      inflationPct: 'derive',
      openingCash: 'derive', openingEquity: 'derive', taxLagMonths: 9,
    });
  }, [usingScoped, outputs, periods, entityIds]);

  const grouped = groupPeriods(periods, granularity);
  const entitiesById = useMemo(() => Object.fromEntries(entities.map(e => [e.id, e])), [entities]);

  const visibleLines = lines.filter(l => l.group === 'inflation' ? showInflation : true);
  const hasInflationLines = lines.some(l => l.group === 'inflation');

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 500, color: colors.ink, margin: 0 }}>
          {title}
          {/* Scope only means something on a lens with locations, which is
              also the only lens that passes a filter handler. */}
          {onFilterChange && (
            <span style={{ fontSize: 13, fontWeight: 400, color: colors.muted, marginLeft: 8 }}>· {filterLabel(filter, entities, groups)}</span>
          )}
        </h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {hasInflationLines && (
            <button
              onClick={() => setShowInflation(s => !s)}
              style={{
                padding: '5px 10px', fontSize: 11, fontFamily: fontStack,
                border: `1px solid ${colors.border}`, borderRadius: 6,
                background: showInflation ? colors.ink : '#fff',
                color: showInflation ? '#fff' : colors.inkSoft,
                cursor: 'pointer',
              }}
              title="Show / hide the 'of which: inflation uplift' breakdown rows"
            >
              {showInflation ? '▾ Inflation rows shown' : '▸ Inflation rows hidden'}
            </button>
          )}
          {onFilterChange && (
            <LocationFilter
              entities={entities} groups={groups} assignments={assignments}
              value={filter} onChange={onFilterChange}
            />
          )}
          <div style={{ display: 'flex', gap: 4, fontSize: 11 }}>
            {['monthly', 'quarterly', 'annual'].map(g => (
              <button
                key={g}
                onClick={() => setGranularity(g)}
                style={{
                  padding: '5px 9px', borderRadius: 6,
                  background: granularity === g ? colors.ink : '#fff',
                  color: granularity === g ? '#fff' : colors.inkSoft,
                  border: `1px solid ${colors.border}`,
                  cursor: 'pointer', fontFamily: fontStack, textTransform: 'capitalize',
                }}
              >{g}</button>
            ))}
          </div>
        </div>
      </div>

      {usingScoped && (
        <div style={{ padding: '6px 10px', fontSize: 11, color: '#7c2d12', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 6, marginBottom: 10 }}>
          Scoped to {filterLabel(filter, entities, groups)} — recomputed from upstream entity rows. Inflation, tax and dividend policy inherited from the scenario; central costs (HQ staff, admin, group loans) apportioned by revenue share; opening cash = capital attributed to these locations (central / unallocated pot excluded).
        </div>
      )}

      <div style={{ overflowX: 'auto', border: `1px solid ${colors.border}`, borderRadius: 8, background: '#fff' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: fontStack }}>
          <thead>
            <tr style={{ background: colors.bgSoft }}>
              <th style={{ ...th, position: 'sticky', left: 0, background: colors.bgSoft, minWidth: 220 }}>Line</th>
              {grouped.map(g => (
                <th key={g.label} style={{ ...th, textAlign: 'right', minWidth: 80 }}>{g.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleLines.map(line => {
              const totalsByGroup = grouped.map(g => sumPeriods({ outputs, scopedMap, usingScoped }, line.nominal_type, g.periods, line.aggregate || 'sum'));
              const isHeader = line.kind === 'header';
              const isSubtle = line.kind === 'subtle';
              return (
                <tr key={line.nominal_type} style={{
                  borderBottom: `1px solid ${colors.borderSoft}`,
                  background: isHeader ? colors.bgSoft : 'transparent',
                  fontWeight: isHeader ? 700 : 400,
                  color: isSubtle ? colors.muted : colors.ink,
                }}>
                  <td style={{ ...td, position: 'sticky', left: 0, background: isHeader ? colors.bgSoft : '#fff', fontWeight: isHeader ? 700 : 500 }}>
                    {line.indent ? <span style={{ display: 'inline-block', width: 12 }} /> : null}{line.label}
                  </td>
                  {totalsByGroup.map((v, i) => {
                    const g = grouped[i];
                    return (
                      <td
                        key={i}
                        onClick={() => setDrillCell({ line, periods: g.periods, periodsLabel: g.label, total_p: v })}
                        style={{
                          ...td, textAlign: 'right', fontFamily: 'ui-monospace, monospace',
                          cursor: 'pointer', userSelect: 'none',
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = '#f0f9ff'}
                        onMouseLeave={(e) => e.currentTarget.style.background = ''}
                      >
                        {v == null ? '—' : fmtP(v, { compact: true })}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {variant === 'pnl' && (
              <KpiFooter outputs={outputs} scopedMap={scopedMap} usingScoped={usingScoped} grouped={grouped} />
            )}
          </tbody>
        </table>
      </div>

      {variant === 'bs' && (
        <BsRatiosPanel outputs={outputs} scopedMap={scopedMap} usingScoped={usingScoped} grouped={grouped} />
      )}

      {drillCell && (
        <DrillModal
          line={drillCell.line}
          periods={drillCell.periods}
          periodsLabel={drillCell.periodsLabel}
          outputs={outputs}
          entityIds={entityIds}
          entitiesById={entitiesById}
          total_p={drillCell.total_p}
          scopedMap={scopedMap}
          scenarioId={scenarioId}
          onClose={() => setDrillCell(null)}
        />
      )}
    </div>
  );
}

// ── P&L KPI footer ───────────────────────────────────────────────

function KpiFooter({ outputs, scopedMap, usingScoped, grouped }) {
  const get = (nt, periods, aggregate = 'sum') =>
    sumPeriods({ outputs, scopedMap, usingScoped }, nt, periods, aggregate);

  // Compute per-group KPI rows. Sq-ft metrics use 'last' (point-in-time);
  // headcount uses 'last' as well (snapshot at end of period range);
  // financial ratios use sums over the period range.
  const rows = grouped.map(g => {
    const revenue = get('pnl.revenue_total', g.periods);
    const ebitda  = get('pnl.ebitda', g.periods);
    const pbt     = get('pnl.pbt', g.periods);
    const npat    = get('pnl.npat', g.periods);
    // sign: negative cost row -> staff cost positive
    const staff   = -get('pnl.cost_staff_direct', g.periods) + -get('pnl.cost_staff_overhead', g.periods);
    const utilities = -get('pnl.cost_utilities', g.periods);
    const premises  = -get('pnl.cost_premises', g.periods);
    const otherOh   = -get('pnl.cost_other_overhead', g.periods);
    const admin     = -get('pnl.cost_admin', g.periods);
    const totalCostsExStaff = utilities + premises + otherOh + admin;
    const headcount = get('metric.headcount_total', g.periods, 'last');
    const sqft      = get('metric.sqft_total', g.periods, 'last');
    const sqftLeased= get('metric.sqft_leased', g.periods, 'last');

    const months = g.periods.length;
    const monthsActive = months > 0 ? months : 1;

    // Maintenance is in cost_premises but not separated out — derive from upstream "Maintenance" rows
    let maintenance = 0;
    for (const r of outputs) {
      if (r.nominal_type !== 'overhead') continue;
      if ((r.line_label || '') !== 'Maintenance') continue;
      if (!g.periods.includes(r.period)) continue;
      maintenance += r.amount_p;
    }

    const pct = (num, denom) => denom !== 0 ? (num / denom) * 100 : null;
    const perSqft = (val) => (sqft > 0 ? val / sqft : null);

    return { g,
      headcount,
      staffPct: pct(staff, revenue),
      ebitdaPct: pct(ebitda, revenue),
      pbtPct: pct(pbt, revenue),
      patPct: pct(npat, revenue),
      sqft, sqftLeased,
      rentPerSqftAnnual: sqftLeased > 0 ? perSqft(premises) * (12 / monthsActive) : null,
      utilitiesPerSqftAnnual: perSqft(utilities) != null ? perSqft(utilities) * (12 / monthsActive) : null,
      maintenancePerSqftAnnual: perSqft(maintenance) != null ? perSqft(maintenance) * (12 / monthsActive) : null,
      totalCostsExStaffPerSqftAnnual: perSqft(totalCostsExStaff) != null ? perSqft(totalCostsExStaff) * (12 / monthsActive) : null,
      ebitdaPerSqftAnnual: perSqft(ebitda) != null ? perSqft(ebitda) * (12 / monthsActive) : null,
    };
  });

  const fmtPctV = (v) => v == null ? '—' : `${v.toFixed(1)}%`;
  const fmtN = (v) => v == null ? '—' : Math.round(v).toLocaleString('en-GB');
  const fmtPerSqft = (v) => v == null ? '—' : '£' + (v / 100).toLocaleString('en-GB', { maximumFractionDigits: 1 });

  const KPI_ROWS = [
    { key: 'headcount',     label: '# Staff',                      get: r => fmtN(r.headcount) },
    { key: 'staffPct',      label: 'Staff costs / turnover',       get: r => fmtPctV(r.staffPct) },
    { key: 'ebitdaPct',     label: 'EBITDA %',                     get: r => fmtPctV(r.ebitdaPct) },
    { key: 'pbtPct',        label: 'PBT %',                        get: r => fmtPctV(r.pbtPct) },
    { key: 'patPct',        label: 'PAT (NPAT) %',                 get: r => fmtPctV(r.patPct) },
    { key: 'sqft',          label: 'Total square feet',            get: r => fmtN(r.sqft) },
    { key: 'sqftLeased',    label: 'Rented square feet',           get: r => fmtN(r.sqftLeased) },
    { key: 'rentPSF',       label: 'Rent / sq ft (annualised)',    get: r => fmtPerSqft(r.rentPerSqftAnnual) },
    { key: 'utilPSF',       label: 'Utilities / sq ft',            get: r => fmtPerSqft(r.utilitiesPerSqftAnnual) },
    { key: 'maintPSF',      label: 'Maintenance / sq ft',          get: r => fmtPerSqft(r.maintenancePerSqftAnnual) },
    { key: 'costExStaffPSF',label: 'Total non-staff costs / sq ft',get: r => fmtPerSqft(r.totalCostsExStaffPerSqftAnnual) },
    { key: 'ebitdaPSF',     label: 'EBITDA / sq ft',               get: r => fmtPerSqft(r.ebitdaPerSqftAnnual) },
  ];

  return (
    <>
      <tr style={{ background: '#0f172a' }}>
        <td colSpan={1 + grouped.length} style={{
          padding: '6px 12px', color: '#e2e8f0', fontSize: 10,
          fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
        }}>
          KPIs · per-period operational ratios
        </td>
      </tr>
      {KPI_ROWS.map(kr => (
        <tr key={kr.key} style={{ borderBottom: `1px solid ${colors.borderSoft}`, background: '#fafafa' }}>
          <td style={{ ...td, position: 'sticky', left: 0, background: '#fafafa', color: colors.muted, fontSize: 11 }}>
            {kr.label}
          </td>
          {rows.map((r, i) => (
            <td key={i} style={{ ...td, textAlign: 'right', fontFamily: 'ui-monospace, monospace', fontSize: 11, color: colors.inkSoft }}>
              {kr.get(r)}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ── BS Ratios Panel ──────────────────────────────────────────────

function BsRatiosPanel({ outputs, scopedMap, usingScoped, grouped }) {
  const get = (nt, periods, aggregate = 'last') =>
    sumPeriods({ outputs, scopedMap, usingScoped }, nt, periods, aggregate);

  const rows = grouped.map(g => {
    const ca = get('bs.current_assets', g.periods);
    const cl = get('bs.current_liabilities', g.periods);
    const cash = get('bs.cash', g.periods);
    const debtors = get('bs.debtors_private', g.periods) + get('bs.debtors_la', g.periods);
    const ta = get('bs.total_assets', g.periods);
    const debt = get('bs.debt', g.periods);
    const eq = get('bs.equity', g.periods);
    const ncl = get('bs.non_current_liabilities', g.periods);
    return {
      label: g.label,
      currentRatio: cl > 0 ? ca / cl : null,
      quickRatio:   cl > 0 ? (cash + debtors) / cl : null,
      gearing:      eq > 0 ? debt / eq : null,
      equityRatio:  ta > 0 ? eq / ta * 100 : null,
      ncl_eq:       eq > 0 ? ncl / eq : null,
    };
  });

  const fmtX = (v) => v == null ? '—' : `${v.toFixed(2)}×`;
  const fmtPctV = (v) => v == null ? '—' : `${v.toFixed(1)}%`;

  const ROWS = [
    { key: 'current', label: 'Current ratio',           get: r => fmtX(r.currentRatio),  hint: 'CA / CL · health > 1.0×' },
    { key: 'quick',   label: 'Quick ratio (acid test)', get: r => fmtX(r.quickRatio),    hint: '(Cash + debtors) / CL · health > 0.7×' },
    { key: 'gearing', label: 'Gearing (debt / equity)', get: r => fmtX(r.gearing),       hint: 'Lender comfort < 2.0×' },
    { key: 'equityR', label: 'Equity ratio',            get: r => fmtPctV(r.equityRatio),hint: 'Equity / total assets · > 30% conservative' },
    { key: 'nclEq',   label: 'Long-term debt / equity', get: r => fmtX(r.ncl_eq),        hint: 'Including directors\' loans' },
  ];

  return (
    <div style={{ marginTop: 16, border: `1px solid ${colors.border}`, borderRadius: 8, background: '#fff', overflowX: 'auto' }}>
      <div style={{ padding: '8px 12px', background: colors.bgSoft, borderBottom: `1px solid ${colors.border}` }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Balance sheet ratios
        </span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: fontStack }}>
        <thead>
          <tr style={{ background: '#fff' }}>
            <th style={{ ...th, minWidth: 220 }}>Ratio</th>
            {grouped.map(g => <th key={g.label} style={{ ...th, textAlign: 'right', minWidth: 80 }}>{g.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {ROWS.map(rr => (
            <tr key={rr.key} style={{ borderBottom: `1px solid ${colors.borderSoft}` }}>
              <td style={td}>
                {rr.label}
                {rr.hint && <span style={{ display: 'block', fontSize: 10, color: colors.muted }}>{rr.hint}</span>}
              </td>
              {rows.map((r, i) => (
                <td key={i} style={{ ...td, textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>
                  {rr.get(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

function groupPeriods(periods, granularity) {
  const groups = [];
  if (granularity === 'monthly') {
    for (const p of periods) groups.push({ label: 'M' + p, periods: [p] });
  } else if (granularity === 'quarterly') {
    for (let i = 0; i < periods.length; i += 3) {
      const slice = periods.slice(i, i + 3);
      groups.push({ label: `Q${Math.floor(i / 3) + 1}`, periods: slice });
    }
  } else {
    for (let i = 0; i < periods.length; i += 12) {
      const slice = periods.slice(i, i + 12);
      groups.push({ label: `Y${Math.floor(i / 12) + 1}`, periods: slice });
    }
  }
  return groups;
}

function sumPeriods({ outputs, scopedMap, usingScoped }, nominal, periods, aggregate) {
  const setP = new Set(periods);
  let sum = 0; let count = 0;
  const byPeriod = new Map();

  if (usingScoped && scopedMap) {
    for (const t of periods) {
      const v = scopedMap.get(`${nominal}::${t}`);
      if (v == null) continue;
      sum += v; count += 1;
      byPeriod.set(t, v);
    }
  } else {
    for (const o of outputs) {
      if (o.nominal_type !== nominal) continue;
      if (!setP.has(o.period)) continue;
      sum += o.amount_p;
      count += 1;
      byPeriod.set(o.period, o.amount_p);
    }
  }

  if (count === 0) return 0;
  if (aggregate === 'first') {
    const minP = Math.min(...periods);
    return byPeriod.has(minP) ? byPeriod.get(minP) : 0;
  }
  if (aggregate === 'last') {
    const maxP = Math.max(...periods);
    return byPeriod.has(maxP) ? byPeriod.get(maxP) : 0;
  }
  if (aggregate === 'avg') return sum / count;
  return sum;
}

const th = { padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: colors.muted, borderBottom: `1px solid ${colors.border}` };
const td = { padding: '5px 10px' };
