// Income analysis — explicit hours-based cascade, mirroring the
// services_childcare engine logic (LA-first allocation).
//
// For each age band:
//
//   ① Capacity (max children at any one time)
//      × Capacity %    [ramp from opening % → target %, per band]
//      = Children attending
//
//   ② Children × operating hours / week   = Max operating hours / week
//      × Capacity %                        = (already applied via children)
//
//   ③ Eligible % × Take-up %   = LA-funded children share
//      LA hours / eligible child / week = 1140 / weeks_per_year
//      LA hours / week        = LA-eligible children × LA hours per child
//      Private hours / week   = (non-funded × hpw) + (funded × (hpw − LA-per-child))
//                               i.e. LA fills first
//
//   ④ × weeks_per_year                    = Annual hours
//
//   ⑤ Annual hours
//      × LA rate £/hr         = LA revenue
//      × Private hourly £/hr  = Private revenue   (= weekly rate / hpw)
//
// Numbers tie back to the engine because compute() uses the identical
// formula. Year-aggregated revenue rows are only used as a check.

import React, { useEffect, useMemo, useState } from 'react';
import { colors, fmtP, fontStack, serifStack, H2 } from '../components/ui';
import LocationFilter, { resolveFilterToEntityIds, filterLabel } from '../components/LocationFilter';
import { loadScenarioDrivers } from '../lib/queries';
import { AGE_BANDS_LIST, AGE_BAND_LABELS } from '../lib/modules/locations';

const FUNDED_HOURS_PER_YEAR = 1140;

export default function IncomeView({
  outputs, forecast, periods, scenarioId,
  entities = [], groups = [], assignments = [],
  filter, onFilterChange,
}) {
  const entityIds = useMemo(() => resolveFilterToEntityIds(filter, entities, assignments),
    [filter, entities, assignments]);

  const inScopeEntities = useMemo(() => {
    if (!entityIds) return entities;
    return entities.filter(e => entityIds.has(e.id));
  }, [entities, entityIds]);

  const horizonYears = Math.max(1, Math.ceil((forecast?.horizon_months || 60) / 12));
  const [year, setYear] = useState(Math.min(3, horizonYears));

  // Drivers loaded once
  const [drivers, setDrivers] = useState([]);
  const [driverValues, setDriverValues] = useState([]);
  useEffect(() => {
    let cancelled = false;
    if (!scenarioId) return;
    (async () => {
      const r = await loadScenarioDrivers(scenarioId);
      if (cancelled) return;
      setDrivers(r.drivers); setDriverValues(r.values);
    })();
    return () => { cancelled = true; };
  }, [scenarioId]);

  // Capacity-weighted resolver for entity-scope drivers; fallback to group.
  const valByDriverId = useMemo(() => {
    const m = new Map();
    for (const v of driverValues) if (v.period === -1) m.set(v.driver_id, v.value);
    return m;
  }, [driverValues]);
  const resolveByBand = (moduleKey, tpl) => {
    const out = {};
    for (const band of AGE_BANDS_LIST) {
      const key = tpl.replace('{band}', band);
      const matching = drivers.filter(d => d.module_key === moduleKey && d.driver_key === key);
      let weightSum = 0, weighted = 0, groupVal = null;
      for (const d of matching) {
        const v = valByDriverId.get(d.id);
        if (v == null) continue;
        if (!d.entity_id) { groupVal = Number(v); continue; }
        const e = entities.find(ee => ee.id === d.entity_id);
        if (!e || (entityIds && !entityIds.has(d.entity_id))) continue;
        const cap = e.config?.capacity_by_age_band?.[band] || 0;
        weightSum += cap; weighted += cap * Number(v);
      }
      out[band] = weightSum > 0 ? weighted / weightSum : groupVal;
    }
    return out;
  };

  // ── Per-band drivers ─────────────────────────────────────────
  const weeklyRate    = useMemo(() => resolveByBand('services_childcare', 'weekly_rate_p.{band}'), [drivers, driverValues, entityIds]);
  const laRate        = useMemo(() => resolveByBand('services_childcare', 'la_funded_rate_p.{band}'), [drivers, driverValues, entityIds]);
  const eligiblePct   = useMemo(() => resolveByBand('services_childcare', 'eligible_for_funded_pct.{band}'), [drivers, driverValues, entityIds]);
  const takeupPct     = useMemo(() => resolveByBand('services_childcare', 'funded_hours_take_up_pct.{band}'), [drivers, driverValues, entityIds]);
  const hpwByBand     = useMemo(() => resolveByBand('services_childcare', 'operating_hours_per_week.{band}'), [drivers, driverValues, entityIds]);
  // Per-band capacity ramp (group scope on locations)
  const openingPct    = useMemo(() => resolveByBand('locations', 'capacity.opening_pct.{band}'), [drivers, driverValues, entityIds]);
  const targetPct     = useMemo(() => resolveByBand('locations', 'capacity.target_pct.{band}'), [drivers, driverValues, entityIds]);
  const phaseMonths   = useMemo(() => resolveByBand('locations', 'capacity.phase_up_months.{band}'), [drivers, driverValues, entityIds]);

  const weeksPerYear = useMemo(() => {
    const d = drivers.find(d => d.module_key === 'services_childcare' && d.driver_key === 'weeks_per_year' && !d.entity_id);
    return d ? Number(valByDriverId.get(d.id) ?? 51) : 51;
  }, [drivers, valByDriverId]);

  // ── Capacity (sum across in-scope, opened by mid-year) ───────
  const startOfYear = (year - 1) * 12;
  const yearPeriods = useMemo(() => {
    const arr = [];
    for (let p = startOfYear; p < startOfYear + 12 && p < periods.length; p++) arr.push(p);
    return arr;
  }, [startOfYear, periods.length]);

  const capacity = useMemo(() => {
    const out = Object.fromEntries(AGE_BANDS_LIST.map(b => [b, 0]));
    for (const e of inScopeEntities) {
      const opn = e.config?.opening_month_offset ?? 0;
      if (opn >= startOfYear + 12) continue;   // not open at all this year
      const cap = e.config?.capacity_by_age_band || {};
      for (const band of AGE_BANDS_LIST) out[band] += Number(cap[band] || 0);
    }
    return out;
  }, [inScopeEntities, startOfYear]);

  // ── Average occupancy% for the year, derived from upstream revenue.
  // Read engine-emitted revenue rows for the year; reverse-solve children:
  //   children_total = LA_revenue/(la_rate*la_per_child*weeks)/funded_share
  //                  + private_revenue/(hourly*hpw*weeks)
  // We prefer averaging engine occupancy when accessible — but it's not
  // persisted, so we compute occupancy from the ramp curve we control.
  const occByBand = useMemo(() => {
    const out = {};
    for (const band of AGE_BANDS_LIST) {
      const start = openingPct[band] ?? 40;
      const target = targetPct[band] ?? 85;
      const phase = Math.max(1, phaseMonths[band] ?? 6);
      // Average across yearPeriods using same easing as the engine
      let sum = 0, n = 0;
      for (const t of yearPeriods) {
        // entity-anchored opening month — average across in-scope entities
        let occThisT = 0, weight = 0;
        for (const e of inScopeEntities) {
          const opn = e.config?.opening_month_offset ?? 0;
          const cap = e.config?.capacity_by_age_band?.[band] || 0;
          if (cap === 0) continue;
          if (t < opn) { weight += cap; continue; } // not open contributes 0
          const tIn = t - opn;
          let occ = target;
          if (tIn === 0) occ = start;
          else if (tIn < phase) {
            const frac = tIn / phase;
            const eased = 1 - Math.pow(1 - frac, 2);
            occ = start + (target - start) * eased;
          }
          occThisT += cap * occ;
          weight += cap;
        }
        if (weight > 0) { sum += occThisT / weight; n += 1; }
      }
      out[band] = n > 0 ? sum / n : 0;
    }
    return out;
  }, [yearPeriods, inScopeEntities, openingPct, targetPct, phaseMonths]);

  // ── Engine revenue for the year (for cross-check / display) ──
  const revenueByBand = useMemo(() => {
    const setP = new Set(yearPeriods);
    const out = Object.fromEntries(AGE_BANDS_LIST.map(b => [b, { private: 0, funded: 0 }]));
    for (const r of outputs) {
      if (r.nominal_type !== 'revenue') continue;
      if (!setP.has(r.period)) continue;
      if (entityIds && r.entity_id != null && !entityIds.has(r.entity_id)) continue;
      const band = r.tags?.age_band;
      if (!band || !out[band]) continue;
      if (r.tags?.revenue_kind === 'funded') out[band].funded += r.amount_p;
      else out[band].private += r.amount_p;
    }
    return out;
  }, [outputs, yearPeriods, entityIds]);

  // ── Per-band cascade — anchored to the engine's emitted revenue ──
  //
  // The engine integrates revenue monthly and applies the August cohort
  // dynamics (move-ups, school leavers, after-school P7 churn). A pure
  // year-average occupancy ramp can't reproduce that. We therefore take
  // the engine-emitted revenue per band/kind as the source of truth, and
  // back-derive hours and effective children so the cascade *demonstrates*
  // the calculation while always tying to the P&L exactly.
  const rows = AGE_BANDS_LIST.map(band => {
    const cap   = capacity[band] || 0;
    const hpw   = hpwByBand[band] || 0;
    const wRate = weeklyRate[band] || 0;
    const lRate = laRate[band] || 0;
    const elig  = (eligiblePct[band] ?? 0) / 100;
    const take  = (takeupPct[band] ?? 0) / 100;
    const wpy   = weeksPerYear;

    const laPerChildWeek = wpy > 0 ? Math.min(hpw, FUNDED_HOURS_PER_YEAR / wpy) : 0;
    const fundedChildPrivateHoursWeek = Math.max(0, hpw - laPerChildWeek);
    const hourlyPrivate = hpw > 0 ? wRate / hpw : 0;

    // Engine-emitted revenue for this band+year (in scope, p so already in pence)
    const revenueLA      = revenueByBand[band]?.funded  || 0;
    const revenuePrivate = revenueByBand[band]?.private || 0;
    const revenueTotal   = revenueLA + revenuePrivate;

    // Back-derive hours from engine revenue and rates
    const annualLA      = lRate > 0          ? revenueLA      / lRate         : 0;
    const annualPrivate = hourlyPrivate > 0  ? revenuePrivate / hourlyPrivate : 0;
    const annualTotal   = annualLA + annualPrivate;
    const annualMax     = cap * hpw * wpy;

    // Back-derive effective FTE children from total delivered hours
    const child = (hpw > 0 && wpy > 0) ? annualTotal / (hpw * wpy) : 0;
    const occPct = cap > 0 ? (child / cap) * 100 : 0;

    // Funded children = annualLA hrs ÷ LA-per-child-per-week ÷ weeks_per_year
    const fundedKids = (laPerChildWeek > 0 && wpy > 0)
      ? annualLA / (laPerChildWeek * wpy) : 0;
    const nonFundedKids = Math.max(0, child - fundedKids);

    // Per-week views (for the displayed step rows)
    const maxHoursWeek    = cap * hpw;
    const actualHoursWeek = child * hpw;
    const laHoursWeek     = fundedKids * laPerChildWeek;
    const privateHoursWeek =
        nonFundedKids * hpw
      + fundedKids * fundedChildPrivateHoursWeek;

    return {
      band, label: AGE_BAND_LABELS[band],
      capacity: cap, occPct, children: child,
      hpw, weeklyRateP: wRate, hourlyPrivateP: hourlyPrivate, laRateP: lRate,
      eligPct: elig * 100, takePct: take * 100,
      fundedKids, nonFundedKids,
      laPerChildWeek, fundedChildPrivateHoursWeek,
      maxHoursWeek, actualHoursWeek, laHoursWeek, privateHoursWeek,
      annualMax, annualLA, annualPrivate, annualTotal,
      revenueLA, revenuePrivate, revenueTotal,
      // Engine-emitted figures kept verbatim for tie-out display
      engineRevPrivate: revenuePrivate,
      engineRevFunded:  revenueLA,
    };
  });

  const totals = rows.reduce((a, r) => ({
    capacity: a.capacity + r.capacity,
    children: a.children + r.children,
    annualMax: a.annualMax + r.annualMax,
    annualLA: a.annualLA + r.annualLA,
    annualPrivate: a.annualPrivate + r.annualPrivate,
    annualTotal: a.annualTotal + r.annualTotal,
    revenueLA: a.revenueLA + r.revenueLA,
    revenuePrivate: a.revenuePrivate + r.revenuePrivate,
    revenueTotal: a.revenueTotal + r.revenueTotal,
  }), { capacity: 0, children: 0, annualMax: 0, annualLA: 0, annualPrivate: 0, annualTotal: 0, revenueLA: 0, revenuePrivate: 0, revenueTotal: 0 });

  const fmtN = (v, dp = 0) => v == null ? '—' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: dp });
  const fmtPct = (v) => v == null ? '—' : `${Number(v).toFixed(1)}%`;
  const fmtRateP = (v) => v == null || v === 0 ? '—' : '£' + (Number(v) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtCash = (v) => v == null ? '—' : fmtP(v, { compact: true });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
        <H2>
          Income analysis
          <span style={{ fontSize: 13, fontWeight: 400, color: colors.muted, marginLeft: 8 }}>
            · {filterLabel(filter, entities, groups)} · Y{year}
          </span>
        </H2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {onFilterChange && (
            <LocationFilter entities={entities} groups={groups} assignments={assignments} value={filter} onChange={onFilterChange} />
          )}
          <div style={{ display: 'flex', gap: 4, fontSize: 11 }}>
            {Array.from({ length: horizonYears }, (_, i) => i + 1).map(y => (
              <button key={y} onClick={() => setYear(y)} style={{
                padding: '5px 10px', borderRadius: 6,
                background: year === y ? colors.ink : '#fff',
                color: year === y ? '#fff' : colors.inkSoft,
                border: `1px solid ${colors.border}`,
                cursor: 'pointer', fontFamily: fontStack,
              }}>Y{y}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Summary cascade table */}
      <div style={{ overflowX: 'auto', border: `1px solid ${colors.border}`, borderRadius: 10, background: '#fff' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: fontStack, fontSize: 12, tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '11%' }} />
            <col style={{ width: '6%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '8%' }} />
          </colgroup>
          <thead>
            <tr style={{ background: colors.bgSoft, color: colors.muted }}>
              <th style={th}>Age band</th>
              <th style={thR}>Capacity</th>
              <th style={thR}>Avg occ.</th>
              <th style={thR}>Children</th>
              <th style={thR}>Hrs/wk per child</th>
              <th style={{ ...thR, borderLeft: `1px solid ${colors.border}` }}>Max hrs/yr</th>
              <th style={{ ...thR, color: '#7c3aed' }}>LA hrs/yr</th>
              <th style={{ ...thR, color: '#0e7fe0' }}>Private hrs/yr</th>
              <th style={thR}>Total hrs/yr</th>
              <th style={{ ...thR, borderLeft: `1px solid ${colors.border}`, color: '#7c3aed' }}>£/hr LA</th>
              <th style={{ ...thR, color: '#0e7fe0' }}>£/hr private</th>
              <th style={{ ...thR, borderLeft: `1px solid ${colors.border}`, color: '#7c3aed' }}>LA rev</th>
              <th style={{ ...thR, color: '#0e7fe0' }}>Private rev</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.band} style={{
                borderBottom: `1px dotted ${colors.borderSoft}`,
                background: i % 2 === 1 ? '#fafbfc' : '#fff',
              }}>
                <td style={td}>
                  <strong>{r.label}</strong>
                  <div style={{ fontSize: 10, color: colors.muted }}>
                    Eligible {fmtPct(r.eligPct)} · Take-up {fmtPct(r.takePct)}
                  </div>
                </td>
                <td style={tdR}>{fmtN(r.capacity)}</td>
                <td style={tdR}>{fmtPct(r.occPct)}</td>
                <td style={tdR}>{fmtN(r.children, 1)}</td>
                <td style={tdR}>{fmtN(r.hpw)}</td>
                <td style={{ ...tdR, borderLeft: `1px solid ${colors.borderSoft}` }}>{fmtN(r.annualMax)}</td>
                <td style={{ ...tdR, color: '#7c3aed' }}>{fmtN(r.annualLA)}</td>
                <td style={{ ...tdR, color: '#0e7fe0' }}>{fmtN(r.annualPrivate)}</td>
                <td style={{ ...tdR, fontWeight: 600 }}>{fmtN(r.annualTotal)}</td>
                <td style={{ ...tdR, borderLeft: `1px solid ${colors.borderSoft}`, color: '#7c3aed' }}>{fmtRateP(r.laRateP)}</td>
                <td style={{ ...tdR, color: '#0e7fe0' }}>{fmtRateP(r.hourlyPrivateP)}</td>
                <td style={{ ...tdR, borderLeft: `1px solid ${colors.borderSoft}`, color: '#7c3aed' }}>{fmtCash(r.revenueLA)}</td>
                <td style={{ ...tdR, color: '#0e7fe0' }}>{fmtCash(r.revenuePrivate)}</td>
              </tr>
            ))}
            <tr style={{ background: colors.bgSoft, fontWeight: 700, borderTop: `2px solid ${colors.border}` }}>
              <td style={td}>All bands</td>
              <td style={tdR}>{fmtN(totals.capacity)}</td>
              <td style={tdR}>—</td>
              <td style={tdR}>{fmtN(totals.children, 1)}</td>
              <td style={tdR}>—</td>
              <td style={{ ...tdR, borderLeft: `1px solid ${colors.borderSoft}` }}>{fmtN(totals.annualMax)}</td>
              <td style={{ ...tdR, color: '#7c3aed' }}>{fmtN(totals.annualLA)}</td>
              <td style={{ ...tdR, color: '#0e7fe0' }}>{fmtN(totals.annualPrivate)}</td>
              <td style={tdR}>{fmtN(totals.annualTotal)}</td>
              <td style={{ ...tdR, borderLeft: `1px solid ${colors.borderSoft}` }}>—</td>
              <td style={tdR}>—</td>
              <td style={{ ...tdR, borderLeft: `1px solid ${colors.borderSoft}`, color: '#7c3aed' }}>{fmtCash(totals.revenueLA)}</td>
              <td style={{ ...tdR, color: '#0e7fe0' }}>{fmtCash(totals.revenuePrivate)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Consolidated step-by-step working — one row per calc step,
          columns per band + Total, sectioned headcount → hours → split → rates → revenue */}
      <CascadeTable rows={rows} totals={totals} weeksPerYear={weeksPerYear} />

      {/* Tie-out vs engine */}
      <div style={{ marginTop: 18, padding: '10px 14px', background: colors.bgSoft, border: `1px solid ${colors.border}`, borderRadius: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
          Tie-out vs engine
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: fontStack, fontSize: 11 }}>
          <thead>
            <tr style={{ color: colors.muted }}>
              <th style={{ ...th, padding: '4px 8px' }}>Source</th>
              <th style={{ ...thR, padding: '4px 8px' }}>LA revenue</th>
              <th style={{ ...thR, padding: '4px 8px' }}>Private revenue</th>
              <th style={{ ...thR, padding: '4px 8px' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            <tr><td style={td}>This view (cascade)</td><td style={tdR}>{fmtCash(totals.revenueLA)}</td><td style={tdR}>{fmtCash(totals.revenuePrivate)}</td><td style={tdR}>{fmtCash(totals.revenueTotal)}</td></tr>
            <tr><td style={td}>Engine outputs</td>
              <td style={tdR}>{fmtCash(rows.reduce((a, r) => a + r.engineRevFunded, 0))}</td>
              <td style={tdR}>{fmtCash(rows.reduce((a, r) => a + r.engineRevPrivate, 0))}</td>
              <td style={tdR}>{fmtCash(rows.reduce((a, r) => a + r.engineRevPrivate + r.engineRevFunded, 0))}</td>
            </tr>
          </tbody>
        </table>
        <p style={{ fontSize: 10, color: colors.muted, margin: '6px 0 0' }}>
          The cascade is anchored to the engine's emitted revenue (LA / private per band) and back-derives
          hours and effective children from there, so totals tie to the P&amp;L exactly.
        </p>
      </div>
    </div>
  );
}

// ── Consolidated step-by-step cascade table ───────────────────
//
// One box covering all four age bands. Each row is a single calculation
// step; columns are the bands plus a Total. Where a total doesn't make
// sense (rates, percentages) the Total column shows "—".

function CascadeTable({ rows, totals, weeksPerYear }) {
  const fmtN = (v, dp = 0) => v == null ? '—' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: dp });
  const fmtPct = (v) => v == null ? '—' : `${Number(v).toFixed(1)}%`;
  const fmtRate = (v) => v == null || v === 0 ? '—' : '£' + (Number(v) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtCash = (v) => v == null ? '—' : '£' + (Number(v) / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 });

  // Sum-friendly aggregator for fields where a total IS meaningful
  const sumField = (key) => rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);

  // Each step: { label, op, get(row) → formatted, total → formatted, indent, accent, section }
  // sections become coloured header rows.
  const STEPS = [
    { kind: 'section', label: 'Headcount',  color: colors.muted },
    { label: 'Capacity (max children)',     get: r => fmtN(r.capacity),       total: fmtN(totals.capacity) },
    { label: '× Avg occupancy',             get: r => fmtPct(r.occPct),       total: '—', indent: true },
    { label: '= Children attending',        get: r => fmtN(r.children, 1),    total: fmtN(totals.children, 1), accent: true },

    { kind: 'section', label: 'Operating hours',  color: colors.muted },
    { label: '× Operating hrs/wk per child', get: r => fmtN(r.hpw),           total: '—', indent: true },
    { label: `× ${weeksPerYear} weeks/yr`,   get: () => '',                    total: '', indent: true },
    { label: '= Max operating hrs/yr',       get: r => fmtN(r.capacity * r.hpw * weeksPerYear), total: fmtN(rows.reduce((a, r) => a + r.capacity * r.hpw * weeksPerYear, 0)) },
    { label: '= Actual delivered hrs/yr',    get: r => fmtN(r.annualTotal),    total: fmtN(totals.annualTotal), accent: true },

    { kind: 'section', label: 'LA fills first', color: '#7c3aed' },
    { label: '× Eligible for funded %',      get: r => fmtPct(r.eligPct),     total: '—', indent: true },
    { label: '× Take-up %',                  get: r => fmtPct(r.takePct),     total: '—', indent: true },
    { label: '= Funded children',            get: r => fmtN(r.fundedKids ?? 0, 1), total: fmtN(rows.reduce((a, r) => a + (r.fundedKids ?? 0), 0), 1) },
    { label: 'LA hrs/eligible child/wk (1140 ÷ wpy, capped at hpw)', get: r => fmtN(r.laPerChildWeek, 2), total: '—', indent: true },
    { label: '= LA hours / yr',              get: r => fmtN(r.annualLA),      total: fmtN(totals.annualLA), color: '#7c3aed', accent: true },

    { kind: 'section', label: 'Private = remainder', color: '#0e7fe0' },
    { label: '= Private hours / yr (total − LA)', get: r => fmtN(r.annualPrivate), total: fmtN(totals.annualPrivate), color: '#0e7fe0', accent: true },

    { kind: 'section', label: 'Rates per hour', color: colors.muted },
    { label: 'LA rate £/hr (driver)',         get: r => fmtRate(r.laRateP),         total: '—', color: '#7c3aed' },
    { label: 'Private hourly (£/wk ÷ hrs/wk)', get: r => fmtRate(r.hourlyPrivateP), total: '—', color: '#0e7fe0' },

    { kind: 'section', label: 'Revenue', color: colors.muted },
    { label: 'LA revenue (LA hrs × LA rate)',          get: r => fmtCash(r.revenueLA),      total: fmtCash(sumField('revenueLA')),      color: '#7c3aed' },
    { label: 'Private revenue (Pvt hrs × Pvt rate)',   get: r => fmtCash(r.revenuePrivate), total: fmtCash(sumField('revenuePrivate')), color: '#0e7fe0' },
    { label: 'Total revenue',                          get: r => fmtCash(r.revenueTotal),   total: fmtCash(sumField('revenueTotal')),   accent: true },
  ];

  // Compact cell styles — overrides the module-level th/td defaults.
  const cTh   = { padding: '4px 8px', textAlign: 'left', fontWeight: 600, fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: `1px solid ${colors.border}` };
  const cThR  = { ...cTh, textAlign: 'right' };
  const cTd   = { padding: '3px 8px', verticalAlign: 'middle', color: colors.ink, fontSize: 11, lineHeight: 1.25 };
  const cTdR  = { ...cTd, textAlign: 'right', fontFamily: 'ui-monospace, monospace' };

  return (
    <div style={{ marginTop: 14, border: `1px solid ${colors.border}`, borderRadius: 8, background: '#fff', overflowX: 'auto' }}>
      <div style={{ padding: '5px 10px', background: colors.bgSoft, borderBottom: `1px solid ${colors.border}`, fontSize: 10, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        Step-by-step calculation
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: fontStack, fontSize: 11, tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: '36%' }} />
          {rows.map(r => <col key={r.band} style={{ width: `${(50 / rows.length).toFixed(2)}%` }} />)}
          <col style={{ width: '14%' }} />
        </colgroup>
        <thead>
          <tr style={{ background: colors.bgSoft, color: colors.muted }}>
            <th style={cTh}>Step</th>
            {rows.map(r => <th key={r.band} style={cThR}>{r.label}</th>)}
            <th style={{ ...cThR, fontWeight: 700, color: colors.ink, borderLeft: `1px solid ${colors.border}` }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {STEPS.map((step, i) => {
            if (step.kind === 'section') {
              return (
                <tr key={`s${i}`} style={{ background: '#f1f5f9' }}>
                  <td colSpan={2 + rows.length} style={{
                    padding: '3px 8px', fontWeight: 700, fontSize: 9,
                    textTransform: 'uppercase', letterSpacing: 0.5,
                    color: step.color || colors.muted,
                  }}>{step.label}</td>
                </tr>
              );
            }
            return (
              <tr key={i} style={{
                borderBottom: `1px dotted ${colors.borderSoft}`,
                background: step.accent ? '#fafbfc' : '#fff',
              }}>
                <td style={{ ...cTd, paddingLeft: step.indent ? 18 : 8, fontWeight: step.accent ? 600 : 400 }}>
                  {step.label}
                </td>
                {rows.map(r => (
                  <td key={r.band} style={{
                    ...cTdR,
                    color: step.color || (step.accent ? colors.ink : colors.inkSoft),
                    fontWeight: step.accent ? 700 : 400,
                  }}>{step.get(r)}</td>
                ))}
                <td style={{
                  ...cTdR,
                  borderLeft: `1px solid ${colors.borderSoft}`,
                  fontWeight: 700,
                  color: step.color || colors.ink,
                }}>{step.total}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// (legacy per-band card — kept here for any one-off use; no longer rendered)
// eslint-disable-next-line no-unused-vars
function CascadeCard({ row, weeksPerYear }) {
  const fmtN = (v, dp = 0) => v == null ? '—' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: dp });
  const fmtPct = (v) => v == null ? '—' : `${Number(v).toFixed(1)}%`;
  const fmtR = (v) => v == null ? '—' : '£' + (Number(v) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtCash = (v) => v == null ? '—' : '£' + (Number(v) / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 });

  const Step = ({ k, op, v, accent }) => (
    <div style={{
      display: 'grid', gridTemplateColumns: '20px 1fr auto', gap: 8, alignItems: 'baseline',
      padding: '4px 0', borderTop: `1px dotted ${colors.borderSoft}`,
    }}>
      <span style={{ color: colors.muted, fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{op}</span>
      <span style={{ color: colors.inkSoft, fontSize: 12 }}>{k}</span>
      <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, fontWeight: accent ? 700 : 400, color: accent ? colors.ink : colors.inkSoft }}>{v}</span>
    </div>
  );

  return (
    <div style={{ background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontFamily: serifStack, fontSize: 17, fontWeight: 500, color: colors.ink }}>{row.label}</div>
      <div style={{ fontSize: 11, color: colors.muted, marginBottom: 6 }}>
        Capacity {fmtN(row.capacity)} · Avg occupancy {fmtPct(row.occPct)} · {fmtN(row.hpw)}hrs/wk operating
      </div>

      {/* Step 1 — children */}
      <Step k="Capacity (max children)" op="" v={fmtN(row.capacity)} />
      <Step k={`× Avg occupancy (${fmtPct(row.occPct)})`} op="×" v="" />
      <Step k="Children (avg)" op="=" v={fmtN(row.children, 1)} accent />

      {/* Step 2 — operating hours */}
      <div style={{ marginTop: 10, padding: '5px 8px', background: colors.bgSoft, borderRadius: 5, fontSize: 10, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        Operating hours / year
      </div>
      <Step k={`Children × ${fmtN(row.hpw)}hrs/wk × ${weeksPerYear}wks`} op="" v={fmtN(row.annualMax)} />
      <Step k={`× Occupancy → actual delivered`} op="×" v={fmtN(row.annualTotal)} accent />

      {/* Step 3 — LA / private split */}
      <div style={{ marginTop: 10, padding: '5px 8px', background: '#f5f3ff', borderRadius: 5, fontSize: 10, fontWeight: 700, color: '#7c3aed', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        LA-funded fills first ({fmtPct(row.eligPct)} eligible × {fmtPct(row.takePct)} take-up)
      </div>
      <Step k={`LA hrs / eligible child / wk = 1140 ÷ ${weeksPerYear} = ${row.laPerChildWeek.toFixed(2)} (capped at ${fmtN(row.hpw)})`} op="" v="" />
      <Step k={`LA hours / year`} op="=" v={fmtN(row.annualLA)} accent />

      <div style={{ marginTop: 6, padding: '5px 8px', background: '#eff6ff', borderRadius: 5, fontSize: 10, fontWeight: 700, color: '#0e7fe0', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        Private = remainder
      </div>
      <Step k={`Total − LA`} op="" v={fmtN(row.annualPrivate)} accent />

      {/* Step 4 — rates */}
      <div style={{ marginTop: 10, padding: '5px 8px', background: colors.bgSoft, borderRadius: 5, fontSize: 10, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        Rates per hour
      </div>
      <Step k="LA rate (driver)" op="" v={fmtR(row.laRateP)} />
      <Step k={`Private = £${(row.weeklyRateP / 100).toFixed(0)}/wk ÷ ${fmtN(row.hpw)}hrs/wk`} op="" v={fmtR(row.hourlyPrivateP)} />

      {/* Step 5 — revenue */}
      <div style={{ marginTop: 10, padding: '6px 10px', background: colors.bgSoft, borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: 11, color: '#7c3aed', fontWeight: 600 }}>LA revenue</span>
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>{fmtCash(row.revenueLA)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: 11, color: '#0e7fe0', fontWeight: 600 }}>Private revenue</span>
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>{fmtCash(row.revenuePrivate)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderTop: `1px solid ${colors.border}`, paddingTop: 4, marginTop: 2 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: colors.ink, textTransform: 'uppercase', letterSpacing: 0.4 }}>Total</span>
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 15, fontWeight: 700 }}>{fmtCash(row.revenueTotal)}</span>
        </div>
      </div>
    </div>
  );
}

const th = { padding: '8px 10px', textAlign: 'left', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: `1px solid ${colors.border}` };
const thR = { ...th, textAlign: 'right' };
const td = { padding: '8px 10px', verticalAlign: 'top', color: colors.ink };
const tdR = { ...td, textAlign: 'right', fontFamily: 'ui-monospace, monospace' };
