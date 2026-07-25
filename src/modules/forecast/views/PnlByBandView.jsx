// P&L by age band — where the money is actually made.
//
// Revenue and room staff are the only things the engine tags by age band, so
// those attribute directly, broken out to role level. Management who stand in
// the statutory ratio are floor cover too, so the ratio-contributing share of
// their cost allocates automatically alongside room staff; only the
// supervisory remainder is genuinely central. Everything else — cook,
// premises, utilities, consumables, overheads, pre-opening — starts in
// CENTRAL and is allocated on a per-line basis you set in the Allocation
// sub-tab, because the right driver differs by cost.
//
// Raw `revenue` / `staff_cost` / `overhead` rows are PRE-inflation bases; the
// P&L applies per-period inflation factors on top. We apply the same factors
// (derived from the engine's own uplift rows) so this page ties to the P&L
// exactly — the tie-out check at the foot proves it every render.

import React, { useMemo, useState, useEffect } from 'react';
import { colors, fontStack, Section, Pill, selectStyle } from '../components/ui';
import LocationFilter, { resolveFilterToEntityIds } from '../components/LocationFilter';
import { deriveInflationFactors } from '../lib/aggregator';
import { buildOccupancyIndex, occKey } from '../lib/occupancy.js';
import { AGE_BANDS_LIST, AGE_BAND_LABELS } from '../lib/modules/locations.js';
import { STAFF_ROWS } from '../lib/export/aggregations';

const CENTRAL = '__central__';
const DIRECT_ROLES = STAFF_ROWS.filter(r => r.group === 'direct');

// Central cost lines. `key` is the state/storage identity — keep stable.
// `auto` lines are allocated by the model, not by the user.
const CENTRAL_LINES = [
  { key: 'siteMgmtFloor', label: 'Site management — floor cover (in ratio)', auto: 'direct_staff' },
  { key: 'siteMgmt',      label: 'Site management — supervisory (not in ratio)' },
  { key: 'cook',          label: 'Cook / kitchen' },
  { key: 'centralStaff',  label: 'Central staff (exec / senior mgr / admin)' },
  { key: 'niRelief',      label: 'Employment allowance (NI relief)' },
  { key: 'premises',      label: 'Premises (rent / SC / NDR / maintenance)' },
  { key: 'utilities',     label: 'Utilities' },
  { key: 'consumables',   label: 'Consumables & food' },
  { key: 'otherOh',       label: 'Other overheads' },
  { key: 'centralAdmin',  label: 'Central admin' },
  { key: 'preOpening',    label: 'Pre-opening' },
];

const BASES = [
  { key: 'none',         label: 'Leave in Central' },
  { key: 'kids_max',     label: 'Child count — max' },
  { key: 'kids_actual',  label: 'Child count — actual' },
  { key: 'direct_staff', label: 'Direct staff cost' },
  { key: 'revenue',      label: 'Revenue' },
  { key: 'manual',       label: 'Manual amounts' },
];
const basisLabel = (k) => BASES.find(b => b.key === k)?.label || k;

const money = (p) => {
  if (p == null) return '—';
  const gbp = p / 100 || 0;
  const abs = Math.abs(gbp);
  // Format the magnitude only — the sign is carried by the prefix.
  const s = abs >= 1000 ? Math.round(abs).toLocaleString('en-GB') : abs.toFixed(0);
  return (gbp < 0 ? '−£' : '£') + s;
};
const pct = (x) => (x == null || !isFinite(x)) ? '—' : `${x.toFixed(1)}%`;

function normalise(weights) {
  const total = Object.values(weights).reduce((s, v) => s + (v > 0 ? v : 0), 0);
  if (!(total > 0)) return null;
  const out = {};
  for (const [k, v] of Object.entries(weights)) out[k] = (v > 0 ? v : 0) / total;
  return out;
}

export default function PnlByBandView({
  outputs = [], forecast, periods = [],
  entities = [], groups = [], assignments = [],
  filter, onFilterChange,
}) {
  const horizonYears = Math.max(1, Math.ceil((forecast?.horizon_months || 60) / 12));
  const [year, setYear] = useState('1');
  const [subTab, setSubTab] = useState('report');

  const lsKey = `fc.pnlByBand.v3.${forecast?.id || 'none'}`;
  const [defaultBasis, setDefaultBasis] = useState('none');
  const [basisByLine, setBasisByLine] = useState({});
  const [manualByLine, setManualByLine] = useState({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem(lsKey);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.defaultBasis) setDefaultBasis(s.defaultBasis);
      if (s.basisByLine) setBasisByLine(s.basisByLine);
      if (s.manualByLine) setManualByLine(s.manualByLine);
    } catch { /* ignore */ }
  }, [lsKey]);

  const persist = (next) => {
    try {
      localStorage.setItem(lsKey, JSON.stringify({ defaultBasis, basisByLine, manualByLine, ...next }));
    } catch { /* ignore */ }
  };
  const setDefault = (v) => { setDefaultBasis(v); persist({ defaultBasis: v }); };
  const setLineBasis = (key, v) => {
    const next = { ...basisByLine };
    if (v === '__default__') delete next[key]; else next[key] = v;
    setBasisByLine(next); persist({ basisByLine: next });
  };
  const setLineManual = (key, band, v) => {
    const next = { ...manualByLine, [key]: { ...(manualByLine[key] || {}), [band]: v } };
    setManualByLine(next); persist({ manualByLine: next });
  };

  const entityIds = useMemo(() => resolveFilterToEntityIds(filter, entities, assignments),
    [filter, entities, assignments]);
  const scopedEntities = useMemo(() => entityIds ? entities.filter(e => entityIds.has(e.id)) : entities,
    [entities, entityIds]);

  const yearPeriods = useMemo(() => {
    if (year === 'all') return periods;
    const start = (Number(year) - 1) * 12;
    return periods.filter(p => p >= start && p < start + 12);
  }, [year, periods]);

  const model = useMemo(() => {
    const setP = new Set(yearPeriods);
    const inScope = (r) => !entityIds || r.entity_id == null || entityIds.has(r.entity_id);
    const { incomeFactor, costFactor } = deriveInflationFactors(outputs);

    const zero = () => Object.fromEntries([...AGE_BANDS_LIST, CENTRAL].map(b => [b, 0]));
    const revPrivate = zero(), revFunded = zero(), roomStaff = zero();
    const roomByRole = {};
    const central = Object.fromEntries(CENTRAL_LINES.map(l => [l.key, 0]));
    const hcMonths = zero(), staffCostForFte = zero(), floorMonths = zero();
    const nMonths = yearPeriods.length || 1;

    for (const r of outputs) {
      if (!setP.has(r.period) || !inScope(r)) continue;
      const band = r.tags?.age_band;
      const fc = costFactor(r.period);
      const fi = incomeFactor(r.period);

      switch (r.nominal_type) {
        case 'revenue': {
          const tgt = band && revPrivate[band] != null ? band : CENTRAL;
          const amt = Number(r.amount_p) * fi;
          if (r.tags?.revenue_kind === 'funded') revFunded[tgt] += amt;
          else revPrivate[tgt] += amt;
          break;
        }
        case 'metric.floor_positions':
          // Only the band-tagged rows; untagged ones are entity/group totals.
          if (band && floorMonths[band] != null && r.entity_id != null) {
            floorMonths[band] += Number(r.amount_p);
          }
          break;
        case 'staff_cost': {
          const amt = Number(r.amount_p) * fc;
          if (r.module_key === 'pre_opening') { central.preOpening += amt; break; }
          const role = r.tags?.role;
          const hc = Number(r.tags?.headcount) || 0;
          const forFte = role !== 'employment_allowance';
          if (band && roomStaff[band] != null) {
            roomStaff[band] += amt;
            hcMonths[band] += hc;
            if (forFte) staffCostForFte[band] += amt;
            (roomByRole[role] ||= zero())[band] += amt;
            break;
          }
          hcMonths[CENTRAL] += hc;
          if (forFte) staffCostForFte[CENTRAL] += amt;
          if (role === 'cook') central.cook += amt;
          else if (role === 'setting_manager' || role === 'assistant_manager') {
            // The share of their time that stands in the ratio IS floor
            // cover, so it allocates with room staff; the rest is
            // supervisory and stays central.
            const ff = Math.max(0, Math.min(1, Number(r.tags?.floor_factor) || 0));
            central.siteMgmtFloor += amt * ff;
            central.siteMgmt += amt * (1 - ff);
          }
          else if (role === 'employment_allowance') central.niRelief += amt;
          else central.centralStaff += amt;
          break;
        }
        case 'overhead': {
          const amt = Number(r.amount_p) * fc;
          const lbl = r.line_label || '';
          if (r.module_key === 'pre_opening') central.preOpening += amt;
          else if (lbl === 'Rent' || lbl === 'Service charge' || lbl === 'NDR' || lbl === 'Maintenance') central.premises += amt;
          else if (/utilit/i.test(lbl)) central.utilities += amt;
          else if (/consumable|food/i.test(lbl)) central.consumables += amt;
          else if (lbl === 'Central admin') central.centralAdmin += amt;
          else central.otherOh += amt;
          break;
        }
        case 'cost_of_sales':
          central.otherOh += Number(r.amount_p) * fc;
          break;
        default: break;
      }
    }

    const activeBands = AGE_BANDS_LIST.filter(b =>
      scopedEntities.some(e => (e.config?.capacity_by_age_band?.[b] || 0) > 0)
      || revPrivate[b] || revFunded[b] || roomStaff[b]);

    const occIdx = buildOccupancyIndex(outputs);
    const wKidsMax = {}, wKidsActual = {}, wDirect = {}, wRevenue = {};
    for (const b of activeBands) {
      wKidsMax[b] = scopedEntities.reduce((s, e) => s + (e.config?.capacity_by_age_band?.[b] || 0), 0);
      let sum = 0, n = 0;
      for (const t of yearPeriods) {
        let kids = 0;
        for (const e of scopedEntities) {
          const cap = e.config?.capacity_by_age_band?.[b] || 0;
          if (!cap) continue;
          kids += cap * ((occIdx.get(occKey(e.id, b, t)) ?? 0) / 100);
        }
        sum += kids; n += 1;
      }
      wKidsActual[b] = n ? sum / n : 0;
      wDirect[b] = roomStaff[b];
      wRevenue[b] = revPrivate[b] + revFunded[b];
    }
    const shareByBasis = {
      kids_max: normalise(wKidsMax),
      kids_actual: normalise(wKidsActual),
      direct_staff: normalise(wDirect),
      revenue: normalise(wRevenue),
    };

    const cols = [...activeBands, CENTRAL];
    const allocated = Object.fromEntries(cols.map(c => [c, 0]));
    const lineRows = [];
    let centralTotal = 0, unallocated = 0;

    for (const line of CENTRAL_LINES) {
      const amt = central[line.key];
      if (amt === 0) continue;
      centralTotal += amt;

      const effBasis = line.auto ? line.auto : (basisByLine[line.key] ?? defaultBasis);
      const spread = { [CENTRAL]: 0 };
      let overTyped = 0;

      if (effBasis === 'manual') {
        // Type an amount per band; whatever isn't typed stays in Central.
        let typed = 0;
        for (const b of activeBands) {
          const v = Math.round((Number(manualByLine[line.key]?.[b]) || 0) * 100);
          spread[b] = v; typed += v;
          allocated[b] += v;
        }
        const rest = amt - typed;
        spread[CENTRAL] = rest;
        allocated[CENTRAL] += rest;
        unallocated += rest;
        if (typed > amt) overTyped = typed - amt;
      } else {
        const share = effBasis === 'none' ? null : shareByBasis[effBasis];
        if (share) {
          for (const b of activeBands) {
            const v = amt * (share[b] || 0);
            spread[b] = v;
            allocated[b] += v;
          }
        } else {
          spread[CENTRAL] = amt;
          allocated[CENTRAL] += amt;
          unallocated += amt;
        }
      }
      lineRows.push({
        ...line, amt, effBasis, overTyped,
        explicit: !line.auto && basisByLine[line.key] != null,
        spread,
      });
    }

    const revenue = {}, contribution = {}, ebitda = {};
    for (const c of cols) {
      revenue[c] = (revPrivate[c] || 0) + (revFunded[c] || 0);
      contribution[c] = revenue[c] - (roomStaff[c] || 0);
      ebitda[c] = contribution[c] - (allocated[c] || 0);
    }

    // ── Operating metrics ───────────────────────────────────────────
    const lfRow = outputs.find(o => o.nominal_type === 'metric.staff_load_factor' && setP.has(o.period));
    const loadFactor = lfRow ? Number(lfRow.amount_p) / 10000 : null;

    const maxKids = {}, avgKids = {}, capPct = {}, staffFte = {},
          wagePerFte = {}, loadedPerFte = {}, kidsPerStaff = {}, kidsPerFloor = {};
    for (const c of cols) {
      if (c === CENTRAL) {
        maxKids[c] = null; avgKids[c] = null; capPct[c] = null; kidsPerFloor[c] = null;
      } else {
        maxKids[c] = scopedEntities.reduce((s, e) => s + (e.config?.capacity_by_age_band?.[c] || 0), 0);
        avgKids[c] = wKidsActual[c] || 0;
        capPct[c] = maxKids[c] > 0 ? avgKids[c] / maxKids[c] * 100 : null;
        const floorAvg = (floorMonths[c] || 0) / nMonths;
        kidsPerFloor[c] = floorAvg > 0 ? avgKids[c] / floorAvg : null;
      }
      const fte = (hcMonths[c] || 0) / nMonths;
      staffFte[c] = fte;
      kidsPerStaff[c] = (c !== CENTRAL && fte > 0) ? avgKids[c] / fte : null;
      const annualised = fte > 0 ? (staffCostForFte[c] || 0) / nMonths * 12 / fte : null;
      loadedPerFte[c] = annualised;
      wagePerFte[c] = (annualised != null && loadFactor) ? annualised / loadFactor : null;
    }
    const totalKids = activeBands.reduce((s, b) => s + (avgKids[b] || 0), 0);
    const totalFloor = activeBands.reduce((s, b) => s + (floorMonths[b] || 0), 0) / nMonths;
    const totalFte = cols.reduce((s, c) => s + (staffFte[c] || 0), 0);

    const pnl = (nt) => outputs.filter(o => o.nominal_type === nt && setP.has(o.period)
      && (!entityIds || o.entity_id == null || entityIds.has(o.entity_id)))
      .reduce((s, o) => s + Number(o.amount_p), 0);
    const revCheck = Object.values(revenue).reduce((s, v) => s + v, 0) - pnl('pnl.revenue_total');
    const ebitdaCheck = Object.values(ebitda).reduce((s, v) => s + v, 0) - pnl('pnl.ebitda');

    return {
      cols, activeBands, revPrivate, revFunded, roomStaff, roomByRole,
      lineRows, centralTotal, unallocated, allocated,
      revenue, contribution, ebitda, revCheck, ebitdaCheck,
      maxKids, avgKids, capPct, staffFte, wagePerFte, loadedPerFte,
      kidsPerStaff, kidsPerFloor, loadFactor,
      totalKids, totalFloor, totalFte,
    };
  }, [outputs, yearPeriods, entityIds, scopedEntities, defaultBasis, basisByLine, manualByLine]);

  const { cols, activeBands, revPrivate, revFunded, roomStaff, roomByRole,
          lineRows, unallocated, allocated, revenue, contribution, ebitda,
          revCheck, ebitdaCheck, maxKids, avgKids, capPct, staffFte,
          wagePerFte, loadedPerFte, kidsPerStaff, kidsPerFloor, loadFactor,
          totalKids, totalFloor, totalFte } = model;

  const colLabel = (c) => c === CENTRAL ? 'Central' : AGE_BAND_LABELS[c] || c;
  const total = (m) => cols.reduce((s, c) => s + (m[c] || 0), 0);
  const nCols = cols.length + 2;   // label + bands/central + total

  const basisNote = (line) =>
    line.auto ? 'automatic — stands in ratio'
      : line.effBasis === 'none' ? 'kept central'
      : `by ${basisLabel(line.effBasis).toLowerCase()}`;

  return (
    <Section
      title="P&L by age band"
      right={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <LocationFilter entities={entities} groups={groups} assignments={assignments}
            value={filter} onChange={onFilterChange} />
          <select value={year} onChange={(e) => setYear(e.target.value)} style={selectStyle}>
            {Array.from({ length: horizonYears }, (_, i) => (
              <option key={i} value={String(i + 1)}>Year {i + 1}</option>
            ))}
            <option value="all">Full horizon</option>
          </select>
        </div>
      }
    >
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${colors.border}`, marginBottom: 12 }}>
        {[['report', 'Report'], ['alloc', 'Allocation method']].map(([k, lbl]) => (
          <button key={k} onClick={() => setSubTab(k)} style={{
            padding: '8px 14px', fontSize: 12, fontWeight: subTab === k ? 600 : 400,
            color: subTab === k ? colors.ink : colors.muted, background: 'transparent', border: 'none',
            borderBottom: `2px solid ${subTab === k ? colors.accent : 'transparent'}`,
            cursor: 'pointer', fontFamily: fontStack,
          }}>{lbl}</button>
        ))}
      </div>

      {subTab === 'alloc' ? (
        <AllocationPanel
          lineRows={lineRows} activeBands={activeBands}
          defaultBasis={defaultBasis} setDefault={setDefault}
          basisByLine={basisByLine} setLineBasis={setLineBasis}
          manualByLine={manualByLine} setLineManual={setLineManual}
          resetOverrides={() => { setBasisByLine({}); persist({ basisByLine: {} }); }}
        />
      ) : (
        <>
          <p style={{ fontSize: 12, color: colors.muted, margin: '0 0 10px' }}>
            Revenue and room staff attribute by age band. Management who stand in the ratio are
            allocated with them automatically; the rest is indirect and follows the bases set on the
            <strong> Allocation method</strong> tab. Contribution is revenue less room staff only.
          </p>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: fontStack }}>
              <thead>
                <tr>
                  <th style={th}>&nbsp;</th>
                  {cols.map(c => (
                    <th key={c} style={{ ...th, textAlign: 'right', ...(c === CENTRAL ? { borderLeft: `1px solid ${colors.border}` } : {}) }}>
                      {colLabel(c)}
                    </th>
                  ))}
                  <th style={{ ...th, textAlign: 'right', borderLeft: `1px solid ${colors.border}` }}>Total</th>
                </tr>
              </thead>
              <tbody>
                <SectionRow label="Income" nCols={nCols} />
                <Row label="Private fees" m={revPrivate} cols={cols} total={total} />
                <Row label="LA funded" m={revFunded} cols={cols} total={total} />
                <Row label="Revenue" m={revenue} cols={cols} total={total} strong />

                <SectionRow label="Room staff — ratio-driven, by role" nCols={nCols} />
                {DIRECT_ROLES.filter(r => roomByRole[r.role]).map(r => (
                  <Row key={r.role} label={r.label} m={roomByRole[r.role]} cols={cols} total={total} negate indent />
                ))}
                {Object.keys(roomByRole).filter(role => !DIRECT_ROLES.some(r => r.role === role)).map(role => (
                  <Row key={role} label={role} m={roomByRole[role]} cols={cols} total={total} negate indent />
                ))}
                <Row label="Total room staff" m={roomStaff} cols={cols} total={total} negate strong />
                <Row label="Contribution" m={contribution} cols={cols} total={total} strong />
                <PctRow label="Contribution margin" num={contribution} den={revenue} cols={cols} total={total} />

                <SectionRow label="Central costs" nCols={nCols} />
                {lineRows.map(line => (
                  <Row key={line.key} label={line.label} sub={basisNote(line)}
                    m={line.spread} cols={cols} total={total} negate />
                ))}
                <Row label="Total central costs" m={allocated} cols={cols} total={total} negate strong />
                {unallocated !== 0 && (
                  <PlainRow nCols={nCols} text={`${money(unallocated)} left in Central — set a basis on those lines in the Allocation method tab.`} />
                )}

                <SectionRow label="Result" nCols={nCols} />
                <Row label="EBITDA" m={ebitda} cols={cols} total={total} strong />
                <PctRow label="EBITDA margin" num={ebitda} den={revenue} cols={cols} total={total} />

                <SectionRow label="Operating metrics" nCols={nCols} />
                <MetricRow label="Max kids (registered places)" m={maxKids} cols={cols}
                  fmt={(v) => v.toLocaleString('en-GB')} agg="sum" />
                <MetricRow label="Average kids (FTE)" m={avgKids} cols={cols}
                  fmt={(v) => v.toFixed(1)} agg="sum" />
                <MetricRow label="Average capacity %" m={capPct} cols={cols} fmt={(v) => `${v.toFixed(1)}%`}
                  aggValue={totalKids > 0 && sumOf(maxKids, cols) > 0 ? totalKids / sumOf(maxKids, cols) * 100 : null} />
                <MetricRow label="Children per adult on floor" m={kidsPerFloor} cols={cols}
                  fmt={(v) => `1 : ${v.toFixed(1)}`} hint="statutory ratio the model staffed to"
                  aggValue={totalFloor > 0 ? totalKids / totalFloor : null} />
                <MetricRow label="Children per staff FTE employed" m={kidsPerStaff} cols={cols}
                  fmt={(v) => `1 : ${v.toFixed(1)}`}
                  hint="lower than the ratio above — a contract covers ~36 of the ~50 hours a room is open"
                  aggValue={totalFte > 0 ? totalKids / totalFte : null} />
                <MetricRow label="Staff (average FTE)" m={staffFte} cols={cols}
                  fmt={(v) => v.toFixed(1)} agg="sum" hint="room staff by band; management, cook and exec in Central" />
                <MetricRow label="Average wage per FTE (annual)" m={wagePerFte} cols={cols} fmt={money}
                  aggValue={weightedPerFte(wagePerFte, staffFte, cols)} />
                <MetricRow label="Average fully loaded cost per FTE (annual)" m={loadedPerFte} cols={cols} fmt={money}
                  aggValue={weightedPerFte(loadedPerFte, staffFte, cols)}
                  hint={loadFactor ? `on-costs +${((loadFactor - 1) * 100).toFixed(1)}% (NI, pension, cover)` : undefined} />
              </tbody>
            </table>
          </div>

          <p style={{ fontSize: 11, color: colors.muted, marginTop: 10 }}>
            {Math.abs(revCheck) < 100 && Math.abs(ebitdaCheck) < 100
              ? '✓ Ties to the P&L: revenue and EBITDA agree with the Profit & Loss tab for this scope and period.'
              : `⚠ Tie-out variance vs P&L — revenue ${money(revCheck)}, EBITDA ${money(ebitdaCheck)}.`}
            {' '}EBITDA excludes depreciation, interest and tax.
          </p>
        </>
      )}
    </Section>
  );
}

// ── Allocation method sub-tab ───────────────────────────────────────────
function AllocationPanel({
  lineRows, activeBands, defaultBasis, setDefault,
  basisByLine, setLineBasis, manualByLine, setLineManual, resetOverrides,
}) {
  const overrides = Object.keys(basisByLine).length;
  return (
    <div>
      <p style={{ fontSize: 12, color: colors.muted, margin: '0 0 12px' }}>
        Choose how each indirect cost is pushed out to the age bands. With <em>Manual amounts</em>,
        type what each band should carry and the balance stays in Central. Management time that
        stands in the statutory ratio is allocated automatically and can't be overridden — it's
        floor cover, not overhead.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <span style={{ fontSize: 11, color: colors.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }}>
          Default basis
        </span>
        <select value={defaultBasis} onChange={(e) => setDefault(e.target.value)} style={{ ...selectStyle, minWidth: 180 }}>
          {BASES.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
        </select>
        {overrides > 0 && (
          <button onClick={resetOverrides} style={{
            background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6,
            padding: '4px 10px', fontSize: 11, color: colors.muted, cursor: 'pointer', fontFamily: fontStack,
          }}>reset {overrides} override{overrides !== 1 ? 's' : ''}</button>
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: fontStack }}>
          <thead>
            <tr>
              <th style={th}>Cost line</th>
              <th style={{ ...th, textAlign: 'right' }}>Total</th>
              <th style={th}>Allocate by</th>
              {activeBands.map(b => <th key={b} style={{ ...th, textAlign: 'right' }}>{AGE_BAND_LABELS[b]}</th>)}
              <th style={{ ...th, textAlign: 'right', borderLeft: `1px solid ${colors.border}` }}>Central</th>
            </tr>
          </thead>
          <tbody>
            {lineRows.length === 0 && (
              <tr><td colSpan={activeBands.length + 4} style={{ ...td, color: colors.muted }}>
                No central costs in this period.
              </td></tr>
            )}
            {lineRows.map(line => (
              <tr key={line.key} style={{ borderBottom: `1px dotted ${colors.borderSoft}` }}>
                <td style={td}>{line.label}</td>
                <td style={tdR}>{money(line.amt)}</td>
                <td style={td}>
                  {line.auto ? (
                    <Pill color={colors.green}>automatic</Pill>
                  ) : (
                    <select
                      value={line.explicit ? line.effBasis : '__default__'}
                      onChange={(e) => setLineBasis(line.key, e.target.value)}
                      style={{
                        padding: '4px 6px', fontSize: 11, fontFamily: fontStack, borderRadius: 6,
                        border: `1px solid ${line.explicit ? colors.accent : colors.border}`, background: '#fff',
                      }}
                    >
                      <option value="__default__">default · {basisLabel(defaultBasis)}</option>
                      {BASES.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
                    </select>
                  )}
                </td>
                {activeBands.map(b => (
                  <td key={b} style={tdR}>
                    {line.effBasis === 'manual' && !line.auto ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                        <span style={{ fontSize: 10, color: colors.muted }}>£</span>
                        <input
                          value={manualByLine[line.key]?.[b] ?? ''}
                          onChange={(e) => setLineManual(line.key, b, e.target.value)}
                          placeholder="0"
                          inputMode="decimal"
                          style={{ width: 76, padding: '3px 6px', textAlign: 'right', borderRadius: 5,
                                   border: `1px solid ${colors.border}`, fontSize: 11, fontFamily: fontStack }}
                        />
                      </span>
                    ) : (
                      <span style={{ color: colors.muted }}>{money(line.spread[b] ?? 0)}</span>
                    )}
                  </td>
                ))}
                <td style={{ ...tdR, borderLeft: `1px solid ${colors.border}`,
                             color: (line.spread[CENTRAL] || 0) < 0 ? colors.red : colors.ink }}>
                  {money(line.spread[CENTRAL] || 0)}
                  {line.overTyped > 0 && (
                    <span style={{ display: 'block', fontSize: 10, color: colors.red }}>
                      over by {money(line.overTyped)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({ label, sub, m, cols, total, strong, negate, indent }) {
  const v = (c) => {
    const raw = m[c];
    if (raw == null) return null;
    return negate ? -raw : raw;
  };
  const tot = negate ? -total(m) : total(m);
  return (
    <tr style={{ borderBottom: `1px dotted ${colors.borderSoft}`, background: strong ? colors.bgSoft : '#fff' }}>
      <td style={{ ...td, fontWeight: strong ? 700 : 400, paddingLeft: indent ? 20 : 8 }}>
        {label}
        {sub && <span style={{ display: 'block', fontSize: 10, color: colors.muted }}>{sub}</span>}
      </td>
      {cols.map(c => {
        const val = v(c);
        return (
          <td key={c} style={{ ...tdR, fontWeight: strong ? 600 : 400,
                               borderLeft: c === CENTRAL ? `1px solid ${colors.border}` : undefined,
                               color: val != null && val < 0 ? colors.red : colors.ink }}>
            {val == null ? '—' : money(val)}
          </td>
        );
      })}
      <td style={{ ...tdR, fontWeight: 700, borderLeft: `1px solid ${colors.border}`,
                   color: tot < 0 ? colors.red : colors.ink }}>{money(tot)}</td>
    </tr>
  );
}

const sumOf = (m, cols) => cols.reduce((s, c) => s + (m[c] || 0), 0);
// Per-FTE averages can't be summed — re-weight by the FTE behind each one.
const weightedPerFte = (perFte, fte, cols) => {
  let num = 0, den = 0;
  for (const c of cols) {
    if (perFte[c] == null || !fte[c]) continue;
    num += perFte[c] * fte[c]; den += fte[c];
  }
  return den > 0 ? num / den : null;
};

function MetricRow({ label, m, cols, fmt, agg, aggValue, hint }) {
  const totalVal = aggValue !== undefined ? aggValue : (agg === 'sum' ? sumOf(m, cols) : null);
  return (
    <tr style={{ borderBottom: `1px dotted ${colors.borderSoft}` }}>
      <td style={td}>
        {label}
        {hint && <span style={{ display: 'block', fontSize: 10, color: colors.muted }}>{hint}</span>}
      </td>
      {cols.map(c => (
        <td key={c} style={{ ...tdR, borderLeft: c === CENTRAL ? `1px solid ${colors.border}` : undefined }}>
          {m[c] == null ? '—' : fmt(m[c])}
        </td>
      ))}
      <td style={{ ...tdR, fontWeight: 600, borderLeft: `1px solid ${colors.border}` }}>
        {totalVal == null ? '—' : fmt(totalVal)}
      </td>
    </tr>
  );
}

function PctRow({ label, num, den, cols, total }) {
  const calc = (n, d) => (d > 0 ? n / d * 100 : null);
  return (
    <tr style={{ borderBottom: `1px dotted ${colors.borderSoft}` }}>
      <td style={{ ...td, color: colors.muted }}>{label}</td>
      {cols.map(c => (
        <td key={c} style={{ ...tdR, color: colors.muted,
                             borderLeft: c === CENTRAL ? `1px solid ${colors.border}` : undefined }}>
          {pct(calc(num[c] || 0, den[c] || 0))}
        </td>
      ))}
      <td style={{ ...tdR, color: colors.muted, borderLeft: `1px solid ${colors.border}` }}>
        {pct(calc(total(num), total(den)))}
      </td>
    </tr>
  );
}

function SectionRow({ label, nCols }) {
  return (
    <tr>
      <td colSpan={nCols} style={{
        padding: '14px 8px 4px', fontSize: 10, fontWeight: 700, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: `1px solid ${colors.border}`,
      }}>{label}</td>
    </tr>
  );
}

function PlainRow({ nCols, text }) {
  return (
    <tr>
      <td colSpan={nCols} style={{ padding: '4px 8px 8px', fontSize: 11, color: colors.muted, fontStyle: 'italic' }}>
        {text}
      </td>
    </tr>
  );
}

const th = { padding: '6px 8px', textAlign: 'left', fontWeight: 600, color: colors.muted,
             borderBottom: `1px solid ${colors.border}`, background: colors.bgSoft, fontSize: 10,
             textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap' };
const td = { padding: '6px 8px', color: colors.ink, verticalAlign: 'middle' };
const tdR = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
