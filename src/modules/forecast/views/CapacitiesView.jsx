// Capacities analysis — per-location capacity, utilisation and density.
// One row per location with: opening month, sq ft, capacity by age band,
// total capacity, sq ft per child (statutory benchmarks: babies 3.7 m²,
// 2-3s 2.8 m², 3-5s 2.3 m²; 1 m² ≈ 10.76 sq ft).
//
// Below the location table: a year-by-year matrix of effective children
// per location to show ramp.

import React, { useMemo, useState } from 'react';
import { colors, fontStack, H2, KPI, fmtP, serifStack } from '../components/ui';
import LocationFilter, { resolveFilterToEntityIds, filterLabel } from '../components/LocationFilter';

const AGE_BANDS = [
  { key: 'babies',         label: '0-2' },
  { key: 'twos',           label: '2-3' },
  { key: 'three_to_five',  label: '3-5' },
  { key: 'after_school',   label: 'After-school' },
];

// Care Inspectorate space requirements (Scotland) — square metres per child.
const SQM_PER_CHILD = { babies: 3.7, twos: 2.8, three_to_five: 2.3, after_school: 1.86 };
const SQFT_PER_SQM = 10.7639;

export default function CapacitiesView({
  outputs, forecast, periods,
  entities = [], groups = [], assignments = [],
  filter, onFilterChange,
}) {
  const [granularity, setGranularity] = useState('annual');

  const entityIds = useMemo(() => resolveFilterToEntityIds(filter, entities, assignments),
    [filter, entities, assignments]);

  const scopedEntities = useMemo(() =>
    entityIds ? entities.filter(e => entityIds.has(e.id)) : entities,
  [entities, entityIds]);

  const grouped = groupPeriods(periods, granularity);

  // Per-location summary
  const locationRows = scopedEntities.map(e => {
    const cfg = e.config || {};
    const cap = cfg.capacity_by_age_band || {};
    const total = (cap.babies || 0) + (cap.twos || 0) + (cap.three_to_five || 0) + (cap.after_school || 0);
    const sqft = Number(cfg.sq_ft) || 0;
    // Required minimum sq ft to legally accommodate this capacity:
    let requiredSqft = 0;
    for (const b of AGE_BANDS) {
      requiredSqft += (cap[b.key] || 0) * SQM_PER_CHILD[b.key] * SQFT_PER_SQM;
    }
    requiredSqft = Math.round(requiredSqft);
    const sqftPerChild = total > 0 ? sqft / total : 0;
    return {
      entity: e,
      cap, total, sqft, requiredSqft, sqftPerChild,
      compliant: sqft >= requiredSqft,
    };
  });

  // Aggregate KPIs across scope
  const aggCap = locationRows.reduce((acc, r) => ({
    babies: acc.babies + (r.cap.babies || 0),
    twos: acc.twos + (r.cap.twos || 0),
    three_to_five: acc.three_to_five + (r.cap.three_to_five || 0),
    after_school: acc.after_school + (r.cap.after_school || 0),
  }), { babies: 0, twos: 0, three_to_five: 0, after_school: 0 });
  const aggTotal = aggCap.babies + aggCap.twos + aggCap.three_to_five + aggCap.after_school;
  const aggSqft = locationRows.reduce((s, r) => s + r.sqft, 0);

  // Per-period × per-location effective children (capacity × occupancy at end of period)
  const periodMatrix = grouped.map(g => {
    const t = Math.max(...g.periods);
    return {
      label: g.label,
      perEntity: scopedEntities.map(e => {
        const cap = e.config?.capacity_by_age_band || {};
        let totalChildren = 0;
        for (const b of AGE_BANDS) {
          const occ = occupancyAt(e, b.key, t);
          totalChildren += (cap[b.key] || 0) * occ / 100;
        }
        return totalChildren;
      }),
    };
  });

  const totalCapAcrossEntities = scopedEntities.reduce((s, e) => {
    const cap = e.config?.capacity_by_age_band || {};
    return s + (cap.babies || 0) + (cap.twos || 0) + (cap.three_to_five || 0) + (cap.after_school || 0);
  }, 0);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
        <H2>
          Capacities <span style={{ fontSize: 13, fontWeight: 400, color: colors.muted, marginLeft: 8 }}>· {filterLabel(filter, entities, groups)}</span>
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

      {/* Aggregate KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 18 }}>
        <KPI label="Locations in scope" value={`${scopedEntities.length}`} />
        <KPI label="Total capacity" value={`${aggTotal} children`} hint={`${aggCap.babies} 0-2 · ${aggCap.twos} 2-3 · ${aggCap.three_to_five} 3-5 · ${aggCap.after_school} AS`} />
        <KPI label="Total square feet" value={aggSqft.toLocaleString('en-GB')} />
        <KPI label="Sq ft per child (avg)" value={aggTotal > 0 ? (aggSqft / aggTotal).toFixed(1) : '—'} hint="benchmark ≥ 25 sq ft" />
      </div>

      {/* Per-location capacity table */}
      <H2 style={{ fontSize: 16 }}>Capacity by location</H2>
      <p style={{ fontSize: 11, color: colors.muted, margin: '0 0 8px' }}>
        Required sq ft uses Scottish Care Inspectorate space-per-child guidance:
        0-2 3.7 m² · 2-3 2.8 m² · 3-5 2.3 m² · after-school 1.86 m². Sq ft margin = surplus over the legal minimum.
      </p>
      <div style={{ overflowX: 'auto', border: `1px solid ${colors.border}`, borderRadius: 8, background: '#fff', marginBottom: 22 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: fontStack }}>
          <thead>
            <tr style={{ background: colors.bgSoft }}>
              <th style={th}>Location</th>
              <th style={th}>Mode</th>
              <th style={{ ...th, textAlign: 'right' }}>Opens (mo)</th>
              <th style={{ ...th, textAlign: 'right' }}>0-2</th>
              <th style={{ ...th, textAlign: 'right' }}>2-3</th>
              <th style={{ ...th, textAlign: 'right' }}>3-5</th>
              <th style={{ ...th, textAlign: 'right' }}>AS</th>
              <th style={{ ...th, textAlign: 'right' }}>Total</th>
              <th style={{ ...th, textAlign: 'right' }}>Sq ft</th>
              <th style={{ ...th, textAlign: 'right' }}>Required sq ft</th>
              <th style={{ ...th, textAlign: 'right' }}>Sq ft / child</th>
              <th style={{ ...th, textAlign: 'right' }}>Margin</th>
            </tr>
          </thead>
          <tbody>
            {locationRows.length === 0 ? (
              <tr><td colSpan={12} style={{ ...td, color: colors.muted, fontStyle: 'italic' }}>No locations in scope.</td></tr>
            ) : locationRows.map(r => {
              const margin = r.sqft - r.requiredSqft;
              return (
                <tr key={r.entity.id} style={{ borderBottom: `1px solid ${colors.borderSoft}` }}>
                  <td style={td}><strong>{r.entity.label}</strong></td>
                  <td style={td}><span style={{ fontSize: 10, color: colors.muted }}>{r.entity.config?.lease_or_buy || '—'}</span></td>
                  <td style={tdR}>{r.entity.config?.opening_month_offset ?? 0}</td>
                  <td style={tdR}>{r.cap.babies || '—'}</td>
                  <td style={tdR}>{r.cap.twos || '—'}</td>
                  <td style={tdR}>{r.cap.three_to_five || '—'}</td>
                  <td style={tdR}>{r.cap.after_school || '—'}</td>
                  <td style={{ ...tdR, fontWeight: 600 }}>{r.total}</td>
                  <td style={tdR}>{r.sqft.toLocaleString('en-GB')}</td>
                  <td style={tdR}>{r.requiredSqft.toLocaleString('en-GB')}</td>
                  <td style={tdR}>{r.sqftPerChild > 0 ? r.sqftPerChild.toFixed(1) : '—'}</td>
                  <td style={{ ...tdR, color: r.compliant ? colors.green : colors.red, fontWeight: 600 }}>
                    {(margin >= 0 ? '+' : '') + margin.toLocaleString('en-GB')}
                  </td>
                </tr>
              );
            })}
            {locationRows.length > 0 && (
              <tr style={{ ...tr, fontWeight: 700, background: colors.bgSoft }}>
                <td style={td}>Total</td>
                <td style={td}></td>
                <td style={tdR}></td>
                <td style={tdR}>{aggCap.babies}</td>
                <td style={tdR}>{aggCap.twos}</td>
                <td style={tdR}>{aggCap.three_to_five}</td>
                <td style={tdR}>{aggCap.after_school}</td>
                <td style={tdR}>{aggTotal}</td>
                <td style={tdR}>{aggSqft.toLocaleString('en-GB')}</td>
                <td style={tdR}>—</td>
                <td style={tdR}>{aggTotal > 0 ? (aggSqft / aggTotal).toFixed(1) : '—'}</td>
                <td style={tdR}>—</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Per-period × per-location ratio compliance matrix */}
      <H2 style={{ fontSize: 16 }}>Ratio compliance by location</H2>
      <p style={{ fontSize: 11, color: colors.muted, margin: '0 0 8px' }}>
        Practitioners <strong>provided ÷ required</strong> at end of period. Required = sum of <code>ceil(children / band ratio)</code>.
        Provided = sum of headcount for roles flagged as ratio-counting in the staff drivers (default: senior qualified, qualified, setting manager).
        Anything below <strong>1.00×</strong> is a Care Inspectorate breach.
      </p>
      <div style={{ overflowX: 'auto', border: `1px solid ${colors.border}`, borderRadius: 8, background: '#fff', marginBottom: 22 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: fontStack }}>
          <thead>
            <tr style={{ background: colors.bgSoft }}>
              <th style={{ ...th, position: 'sticky', left: 0, background: colors.bgSoft, minWidth: 180 }}>Location</th>
              {grouped.map(g => <th key={g.label} style={{ ...th, textAlign: 'right', minWidth: 70 }}>{g.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {scopedEntities.map(e => {
              const lookupAtT = (nt, t) => {
                const row = outputs.find(o => o.module_key === 'staff' && o.nominal_type === nt && o.period === t && o.entity_id === e.id);
                return row?.amount_p ?? null;
              };
              return (
                <tr key={e.id} style={tr}>
                  <td style={td}><strong>{e.label}</strong></td>
                  {grouped.map(g => {
                    const t = Math.max(...g.periods);
                    const compRaw = lookupAtT('metric.ratio_compliance', t);
                    const req = lookupAtT('metric.ratio_required', t);
                    const prov = lookupAtT('metric.ratio_provided', t);
                    if (compRaw == null) return <td key={g.label} style={tdR}>—</td>;
                    const x = compRaw / 10000;
                    const tone = x >= 1.0 ? colors.green : (x >= 0.9 ? colors.amber : colors.red);
                    return (
                      <td key={g.label} style={{ ...tdR, color: tone, fontWeight: x < 1.0 ? 700 : 400 }}>
                        {x.toFixed(2)}×
                        <span style={{ display: 'block', fontSize: 9, color: colors.muted, fontWeight: 400 }}>{prov ?? 0} / {req ?? 0}</span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {scopedEntities.length > 1 && (() => {
              // Group total row from group-scope ratio metrics
              return (
                <tr style={{ ...tr, fontWeight: 700, background: colors.bgSoft }}>
                  <td style={td}>Group total</td>
                  {grouped.map(g => {
                    const t = Math.max(...g.periods);
                    const groupRow = outputs.find(o => o.module_key === 'staff' && o.nominal_type === 'metric.ratio_compliance' && o.period === t && !o.entity_id);
                    const groupReq = outputs.find(o => o.module_key === 'staff' && o.nominal_type === 'metric.ratio_required' && o.period === t && !o.entity_id);
                    const groupProv = outputs.find(o => o.module_key === 'staff' && o.nominal_type === 'metric.ratio_provided' && o.period === t && !o.entity_id);
                    if (!groupRow) return <td key={g.label} style={tdR}>—</td>;
                    const x = groupRow.amount_p / 10000;
                    const tone = x >= 1.0 ? colors.green : (x >= 0.9 ? colors.amber : colors.red);
                    return (
                      <td key={g.label} style={{ ...tdR, color: tone }}>
                        {x.toFixed(2)}×
                        <span style={{ display: 'block', fontSize: 9, color: colors.muted, fontWeight: 400 }}>{groupProv?.amount_p ?? 0} / {groupReq?.amount_p ?? 0}</span>
                      </td>
                    );
                  })}
                </tr>
              );
            })()}
          </tbody>
        </table>
      </div>

      {/* Per-period effective children matrix */}
      <H2 style={{ fontSize: 16 }}>Effective children — utilisation ramp</H2>
      <p style={{ fontSize: 11, color: colors.muted, margin: '0 0 8px' }}>
        End-of-period effective children = capacity × occupancy at the period's last month. Shows how each location ramps from opening.
      </p>
      <div style={{ overflowX: 'auto', border: `1px solid ${colors.border}`, borderRadius: 8, background: '#fff' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: fontStack }}>
          <thead>
            <tr style={{ background: colors.bgSoft }}>
              <th style={{ ...th, position: 'sticky', left: 0, background: colors.bgSoft, minWidth: 200 }}>Location</th>
              {grouped.map(g => <th key={g.label} style={{ ...th, textAlign: 'right', minWidth: 70 }}>{g.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {scopedEntities.map((e, ei) => {
              const cap = e.config?.capacity_by_age_band || {};
              const totalCap = (cap.babies || 0) + (cap.twos || 0) + (cap.three_to_five || 0) + (cap.after_school || 0);
              return (
                <tr key={e.id} style={tr}>
                  <td style={td}>
                    <strong>{e.label}</strong>
                    <span style={{ display: 'block', fontSize: 10, color: colors.muted }}>capacity {totalCap}</span>
                  </td>
                  {periodMatrix.map((pm, i) => {
                    const eff = pm.perEntity[ei];
                    const occPct = totalCap > 0 ? (eff / totalCap) * 100 : 0;
                    const intensity = Math.max(0, Math.min(100, occPct)) / 100;
                    return (
                      <td key={i} style={{
                        ...tdR,
                        background: `rgba(14, 127, 224, ${0.04 + intensity * 0.32})`,
                      }}>
                        {eff > 0 ? (
                          <>
                            {eff.toFixed(1)}
                            <div style={{ fontSize: 9, color: colors.muted }}>{occPct.toFixed(0)}%</div>
                          </>
                        ) : '—'}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {scopedEntities.length > 1 && (
              <tr style={{ ...tr, fontWeight: 700, background: colors.bgSoft }}>
                <td style={td}>Group total</td>
                {periodMatrix.map((pm, i) => {
                  const total = pm.perEntity.reduce((a, b) => a + b, 0);
                  const occPct = totalCapAcrossEntities > 0 ? (total / totalCapAcrossEntities) * 100 : 0;
                  return (
                    <td key={i} style={tdR}>
                      {total.toFixed(1)}
                      <div style={{ fontSize: 9, color: colors.muted, fontWeight: 400 }}>{occPct.toFixed(0)}%</div>
                    </td>
                  );
                })}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function occupancyAt(entity, band, period) {
  const cfg = entity?.config || {};
  const opening = cfg.opening_month_offset ?? 0;
  const ramp = cfg.ramp_to_target_months ?? 18;
  const target = cfg.target_occupancy_pct ?? 85;
  const start = cfg.starting_occupancy_pct ??
    (cfg.acquisition_type === 'acquired_going_concern' ? 70 : 0);
  if (period < opening) return 0;
  const tIn = period - opening;
  if (tIn === 0) return start;
  if (tIn >= ramp) return target;
  const frac = tIn / ramp;
  const eased = 1 - Math.pow(1 - frac, 2);
  return Math.max(0, Math.min(100, start + (target - start) * eased));
}

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

const th = { padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: colors.muted, borderBottom: `1px solid ${colors.border}` };
const tr = { borderBottom: `1px solid ${colors.borderSoft}` };
const td = { padding: '5px 10px', color: colors.ink };
const tdR = { ...td, textAlign: 'right', fontFamily: 'ui-monospace, monospace' };
