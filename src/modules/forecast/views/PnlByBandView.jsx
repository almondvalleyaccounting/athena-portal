// P&L by age band — where the money is actually made.
//
// Revenue and room (ratio-driven) staff are the only things the engine tags
// by age band, so those attribute directly — broken out to role level
// (senior / qualified / apprentice). Everything else — site management, the
// cook, premises, utilities, consumables, overheads, pre-opening — is
// genuinely indirect and lands in a CENTRAL column. Each central line has
// its OWN allocation basis, because the right driver differs per line: site
// management tracks staffing, premises tracks floor space (≈ registered
// places), catering tracks actual heads through the door.
//
// Raw `revenue` / `staff_cost` / `overhead` rows are PRE-inflation bases;
// the P&L applies per-period inflation factors on top. We apply the same
// factors (derived from the engine's own uplift rows) so this page ties to
// the P&L exactly — the tie-out check at the foot proves it every render.

import React, { useMemo, useState, useEffect } from 'react';
import { colors, fontStack, Section, Pill, selectStyle } from '../components/ui';
import LocationFilter, { resolveFilterToEntityIds } from '../components/LocationFilter';
import { deriveInflationFactors } from '../lib/aggregator';
import { buildOccupancyIndex, occKey } from '../lib/occupancy.js';
import { AGE_BANDS_LIST, AGE_BAND_LABELS } from '../lib/modules/locations.js';
import { STAFF_ROWS } from '../lib/export/aggregations';

const CENTRAL = '__central__';

// Band-tagged practitioner roles, in the shared STAFF_ROWS order so this
// page and the Staff detail page always name roles identically.
const DIRECT_ROLES = STAFF_ROWS.filter(r => r.group === 'direct');

// Central cost lines. `key` is the state/storage identity — keep stable.
const CENTRAL_LINES = [
  { key: 'siteMgmt',     label: 'Site management (setting + assistant managers)' },
  { key: 'cook',         label: 'Cook / kitchen' },
  { key: 'centralStaff', label: 'Central staff (exec / senior mgr / admin)' },
  // Kept separate: netting a firm-wide NI credit into a small central
  // salary line can flip it to income and reads as nonsense.
  { key: 'niRelief',     label: 'Employment allowance (NI relief)' },
  { key: 'premises',     label: 'Premises (rent / SC / NDR / maintenance)' },
  { key: 'utilities',    label: 'Utilities' },
  { key: 'consumables',  label: 'Consumables & food' },
  { key: 'otherOh',      label: 'Other overheads' },
  { key: 'centralAdmin', label: 'Central admin' },
  { key: 'preOpening',   label: 'Pre-opening' },
];

const BASES = [
  { key: 'none',         label: 'Leave in Central' },
  { key: 'kids_max',     label: 'Child count — max' },
  { key: 'kids_actual',  label: 'Child count — actual' },
  { key: 'direct_staff', label: 'Direct staff cost' },
  { key: 'revenue',      label: 'Revenue' },
  { key: 'manual',       label: 'Manual %' },
];
const basisLabel = (k) => BASES.find(b => b.key === k)?.label || k;

const money = (p) => {
  if (p == null) return '—';
  const gbp = p / 100 || 0;
  const abs = Math.abs(gbp);
  // Format the magnitude only — the sign is carried by the prefix, so
  // toLocaleString must never see a negative or you get "−£-18,125".
  const s = abs >= 1000 ? Math.round(abs).toLocaleString('en-GB') : abs.toFixed(0);
  return (gbp < 0 ? '−£' : '£') + s;
};
const pct = (x) => (x == null || !isFinite(x)) ? '—' : `${x.toFixed(1)}%`;

// Normalise a weight map to shares summing to 1. Returns null when there's
// nothing to go on, which means "leave this line in Central".
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

  // Allocation choices are a presentation lens rather than a modelled
  // assumption, so they live in the browser per forecast.
  const lsKey = `fc.pnlByBand.v2.${forecast?.id || 'none'}`;
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
      localStorage.setItem(lsKey, JSON.stringify({
        defaultBasis, basisByLine, manualByLine, ...next,
      }));
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
        case 'staff_cost': {
          const amt = Number(r.amount_p) * fc;
          if (r.module_key === 'pre_opening') { central.preOpening += amt; break; }
          const role = r.tags?.role;
          if (band && roomStaff[band] != null) {
            roomStaff[band] += amt;
            (roomByRole[role] ||= zero())[band] += amt;
            break;
          }
          if (role === 'cook') central.cook += amt;
          else if (role === 'setting_manager' || role === 'assistant_manager') central.siteMgmt += amt;
          else if (role === 'employment_allowance') central.niRelief += amt;
          else central.centralStaff += amt;
          break;
        }
        case 'overhead': {
          const amt = Number(r.amount_p) * fc;
          const lbl = r.line_label || '';
          // Mirrors financial_core's bucketing so the totals tie.
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

    // ── Share maps, one per basis, computed once ────────────────────
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

    // ── Per-line allocation ─────────────────────────────────────────
    const cols = [...activeBands, CENTRAL];
    const allocated = Object.fromEntries(cols.map(c => [c, 0]));
    const lineRows = [];
    let centralTotal = 0, unallocated = 0;

    for (const line of CENTRAL_LINES) {
      const amt = central[line.key];
      if (amt === 0) continue;
      centralTotal += amt;
      const effBasis = basisByLine[line.key] ?? defaultBasis;
      const share = effBasis === 'manual'
        ? normalise(Object.fromEntries(activeBands.map(b => [b, Math.max(0, Number(manualByLine[line.key]?.[b]) || 0)])))
        : (effBasis === 'none' ? null : shareByBasis[effBasis]);

      const spread = { [CENTRAL]: 0 };
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
      lineRows.push({ ...line, amt, effBasis, explicit: basisByLine[line.key] != null, allocatedOut: !!share, spread });
    }

    const revenue = {}, contribution = {}, ebitda = {};
    for (const c of cols) {
      revenue[c] = (revPrivate[c] || 0) + (revFunded[c] || 0);
      contribution[c] = revenue[c] - (roomStaff[c] || 0);
      ebitda[c] = contribution[c] - (allocated[c] || 0);
    }

    const pnl = (nt) => outputs.filter(o => o.nominal_type === nt && setP.has(o.period)
      && (!entityIds || o.entity_id == null || entityIds.has(o.entity_id)))
      .reduce((s, o) => s + Number(o.amount_p), 0);
    const revCheck = Object.values(revenue).reduce((s, v) => s + v, 0) - pnl('pnl.revenue_total');
    const ebitdaCheck = Object.values(ebitda).reduce((s, v) => s + v, 0) - pnl('pnl.ebitda');

    return {
      cols, activeBands, revPrivate, revFunded, roomStaff, roomByRole,
      lineRows, centralTotal, unallocated, allocated,
      revenue, contribution, ebitda, revCheck, ebitdaCheck,
    };
  }, [outputs, yearPeriods, entityIds, scopedEntities, defaultBasis, basisByLine, manualByLine]);

  const { cols, activeBands, revPrivate, revFunded, roomStaff, roomByRole,
          lineRows, centralTotal, unallocated, allocated,
          revenue, contribution, ebitda, revCheck, ebitdaCheck } = model;

  const colLabel = (c) => c === CENTRAL ? 'Central' : AGE_BAND_LABELS[c] || c;
  const total = (m) => cols.reduce((s, c) => s + (m[c] || 0), 0);
  const nCols = cols.length + 3;   // label + basis + bands/central + total

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
      <p style={{ fontSize: 12, color: colors.muted, margin: '0 0 10px' }}>
        Revenue and room staff attribute by age band — the only figures the model drives per band.
        Everything else is indirect and starts in <strong>Central</strong>; set an allocation basis
        per line in the <em>Allocate by</em> column, since the right driver differs by cost.
        Contribution is revenue less room staff only.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <span style={{ fontSize: 11, color: colors.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }}>
          Default basis
        </span>
        <select value={defaultBasis} onChange={(e) => setDefault(e.target.value)} style={{ ...selectStyle, minWidth: 200 }}>
          {BASES.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
        </select>
        <span style={{ fontSize: 11, color: colors.muted }}>
          applies to any line left on <em>default</em>
        </span>
        {Object.keys(basisByLine).length > 0 && (
          <button
            onClick={() => { setBasisByLine({}); persist({ basisByLine: {} }); }}
            style={{ background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6,
                     padding: '4px 10px', fontSize: 11, color: colors.muted, cursor: 'pointer', fontFamily: fontStack }}
          >reset {Object.keys(basisByLine).length} override{Object.keys(basisByLine).length !== 1 ? 's' : ''}</button>
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: fontStack }}>
          <thead>
            <tr>
              <th style={th}>&nbsp;</th>
              <th style={{ ...th, minWidth: 150 }}>Allocate by</th>
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
              <React.Fragment key={line.key}>
                <Row
                  label={line.label}
                  m={line.spread}
                  cols={cols}
                  total={total}
                  negate
                  basisCell={
                    <select
                      value={line.explicit ? line.effBasis : '__default__'}
                      onChange={(e) => setLineBasis(line.key, e.target.value)}
                      style={{
                        padding: '3px 5px', fontSize: 11, fontFamily: fontStack, borderRadius: 6,
                        border: `1px solid ${line.explicit ? colors.accent : colors.border}`,
                        background: '#fff', maxWidth: 148,
                      }}
                    >
                      <option value="__default__">default · {basisLabel(defaultBasis)}</option>
                      {BASES.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
                    </select>
                  }
                />
                {line.effBasis === 'manual' && (
                  <tr>
                    <td style={{ ...td, paddingLeft: 20, fontSize: 11, color: colors.muted, fontStyle: 'italic' }}>
                      ↳ manual split
                    </td>
                    <td style={td}></td>
                    {cols.map(c => (
                      <td key={c} style={{ ...tdR, borderLeft: c === CENTRAL ? `1px solid ${colors.border}` : undefined }}>
                        {c === CENTRAL ? (
                          <span style={{ fontSize: 10, color: colors.muted }}>
                            {line.allocatedOut ? '' : 'set a %'}
                          </span>
                        ) : (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                            <input
                              value={manualByLine[line.key]?.[c] ?? ''}
                              onChange={(e) => setLineManual(line.key, c, e.target.value)}
                              placeholder="0"
                              inputMode="decimal"
                              style={{ width: 48, padding: '2px 5px', textAlign: 'right', borderRadius: 5,
                                       border: `1px solid ${colors.border}`, fontSize: 11, fontFamily: fontStack }}
                            />
                            <span style={{ fontSize: 10, color: colors.muted }}>%</span>
                          </span>
                        )}
                      </td>
                    ))}
                    <td style={{ ...tdR, borderLeft: `1px solid ${colors.border}` }}>
                      <Pill color={line.allocatedOut ? colors.green : colors.amber}>
                        {activeBands.reduce((s, b) => s + (Number(manualByLine[line.key]?.[b]) || 0), 0).toFixed(0)}%
                      </Pill>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            <Row label="Total central costs" m={allocated} cols={cols} total={total} negate strong />
            {unallocated !== 0 && (
              <PlainRow nCols={nCols} text={`${money(unallocated)} of central cost left in Central — set a basis on those lines to push it out to the bands.`} />
            )}

            <SectionRow label="Result" nCols={nCols} />
            <Row label="EBITDA" m={ebitda} cols={cols} total={total} strong />
            <PctRow label="EBITDA margin" num={ebitda} den={revenue} cols={cols} total={total} />
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: colors.muted, marginTop: 10 }}>
        {Math.abs(revCheck) < 100 && Math.abs(ebitdaCheck) < 100
          ? '✓ Ties to the P&L: revenue and EBITDA agree with the Profit & Loss tab for this scope and period.'
          : `⚠ Tie-out variance vs P&L — revenue ${money(revCheck)}, EBITDA ${money(ebitdaCheck)}.`}
        {' '}EBITDA excludes depreciation, interest and tax. Manual splits are scaled pro-rata if they don't total 100%.
      </p>
    </Section>
  );
}

function Row({ label, m, cols, total, strong, negate, indent, basisCell }) {
  const v = (c) => {
    const raw = m[c];
    if (raw == null) return null;
    return negate ? -raw : raw;
  };
  const tot = negate ? -total(m) : total(m);
  return (
    <tr style={{ borderBottom: `1px dotted ${colors.borderSoft}`, background: strong ? colors.bgSoft : '#fff' }}>
      <td style={{ ...td, fontWeight: strong ? 700 : 400, paddingLeft: indent ? 20 : 8 }}>{label}</td>
      <td style={td}>{basisCell || null}</td>
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

function PctRow({ label, num, den, cols, total }) {
  const calc = (n, d) => (d > 0 ? n / d * 100 : null);
  return (
    <tr style={{ borderBottom: `1px dotted ${colors.borderSoft}` }}>
      <td style={{ ...td, color: colors.muted }}>{label}</td>
      <td style={td}></td>
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
