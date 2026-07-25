// P&L by age band — where the money is actually made.
//
// Revenue and room (ratio-driven) staff are the only things the engine tags
// by age band, so those attribute directly. Everything else — site
// management, cook, premises, utilities, consumables, overheads, pre-opening
// — is genuinely indirect and lands in a CENTRAL column, which can then be
// allocated out to the bands on a basis of your choosing.
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

const CENTRAL = '__central__';

// Allocation bases. weight(ctx) returns { band: weight } — normalised later.
const BASES = [
  { key: 'none',         label: 'Do not allocate (leave in Central)' },
  { key: 'kids_max',     label: 'Child count — max (registered places)' },
  { key: 'kids_actual',  label: 'Child count — actual (average FTE)' },
  { key: 'direct_staff', label: 'Direct staff cost (room staff)' },
  { key: 'revenue',      label: 'Revenue' },
  { key: 'manual',       label: 'Manual — enter % per band' },
];

const money = (p) => {
  if (p == null) return '—';
  const gbp = p / 100 || 0;
  const s = Math.abs(gbp) >= 1000
    ? Math.round(gbp).toLocaleString('en-GB')
    : gbp.toFixed(0);
  return (gbp < 0 ? '−£' : '£') + s.replace('-', '');
};
const pct = (x) => (x == null || !isFinite(x)) ? '—' : `${x.toFixed(1)}%`;

export default function PnlByBandView({
  outputs = [], forecast, periods = [],
  entities = [], groups = [], assignments = [],
  filter, onFilterChange,
}) {
  const horizonYears = Math.max(1, Math.ceil((forecast?.horizon_months || 60) / 12));
  const [year, setYear] = useState('1');
  const [basis, setBasis] = useState('none');
  const [manual, setManual] = useState({});

  // Manual splits are per-forecast and worth keeping between visits, but
  // they're a presentation choice — not a modelled assumption — so they
  // live in the browser rather than becoming drivers.
  const lsKey = `fc.pnlByBand.manual.${forecast?.id || 'none'}`;
  useEffect(() => {
    try {
      const raw = localStorage.getItem(lsKey);
      if (raw) setManual(JSON.parse(raw));
    } catch { /* ignore */ }
  }, [lsKey]);
  const setManualBand = (band, v) => {
    setManual(prev => {
      const next = { ...prev, [band]: v };
      try { localStorage.setItem(lsKey, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
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
    const acc = {
      revPrivate: zero(), revFunded: zero(), roomStaff: zero(),
      siteMgmt: zero(), centralStaff: zero(), premises: zero(), utilities: zero(),
      consumables: zero(), otherOh: zero(), centralAdmin: zero(), preOpening: zero(),
    };

    for (const r of outputs) {
      if (!setP.has(r.period) || !inScope(r)) continue;
      const band = r.tags?.age_band;
      const fc = costFactor(r.period);
      const fi = incomeFactor(r.period);

      switch (r.nominal_type) {
        case 'revenue': {
          const target = band && acc.revPrivate[band] != null ? band : CENTRAL;
          const amt = Number(r.amount_p) * fi;
          if (r.tags?.revenue_kind === 'funded') acc.revFunded[target] += amt;
          else acc.revPrivate[target] += amt;
          break;
        }
        case 'staff_cost': {
          const amt = Number(r.amount_p) * fc;
          if (r.module_key === 'pre_opening') { acc.preOpening[CENTRAL] += amt; break; }
          if (band && acc.roomStaff[band] != null) { acc.roomStaff[band] += amt; break; }
          const role = r.tags?.role;
          // Site-level management sits with the setting; exec/admin and the
          // employer NI credit are group-level.
          if (role === 'setting_manager' || role === 'assistant_manager' || role === 'cook') {
            acc.siteMgmt[CENTRAL] += amt;
          } else {
            acc.centralStaff[CENTRAL] += amt;
          }
          break;
        }
        case 'overhead': {
          const amt = Number(r.amount_p) * fc;
          const lbl = r.line_label || '';
          // Mirrors financial_core's bucketing so the totals tie.
          if (r.module_key === 'pre_opening') acc.preOpening[CENTRAL] += amt;
          else if (lbl === 'Rent' || lbl === 'Service charge' || lbl === 'NDR' || lbl === 'Maintenance') acc.premises[CENTRAL] += amt;
          else if (/utilit/i.test(lbl)) acc.utilities[CENTRAL] += amt;
          else if (/consumable|food/i.test(lbl)) acc.consumables[CENTRAL] += amt;
          else if (lbl === 'Central admin') acc.centralAdmin[CENTRAL] += amt;
          else acc.otherOh[CENTRAL] += amt;
          break;
        }
        case 'cost_of_sales':
          acc.otherOh[CENTRAL] += Number(r.amount_p) * fc;
          break;
        default: break;
      }
    }

    // Bands that actually exist in scope (capacity > 0 anywhere).
    const activeBands = AGE_BANDS_LIST.filter(b =>
      scopedEntities.some(e => (e.config?.capacity_by_age_band?.[b] || 0) > 0)
      || acc.revPrivate[b] || acc.revFunded[b] || acc.roomStaff[b]);

    // ── Allocation weights ──────────────────────────────────────────
    const occIdx = buildOccupancyIndex(outputs);
    const weightsRaw = {};
    for (const b of activeBands) {
      if (basis === 'kids_max') {
        weightsRaw[b] = scopedEntities.reduce((s, e) => s + (e.config?.capacity_by_age_band?.[b] || 0), 0);
      } else if (basis === 'kids_actual') {
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
        weightsRaw[b] = n ? sum / n : 0;
      } else if (basis === 'direct_staff') {
        weightsRaw[b] = acc.roomStaff[b];
      } else if (basis === 'revenue') {
        weightsRaw[b] = acc.revPrivate[b] + acc.revFunded[b];
      } else if (basis === 'manual') {
        weightsRaw[b] = Math.max(0, Number(manual[b]) || 0);
      } else {
        weightsRaw[b] = 0;
      }
    }
    const weightTotal = Object.values(weightsRaw).reduce((s, v) => s + v, 0);
    const share = {};
    for (const b of activeBands) share[b] = weightTotal > 0 ? weightsRaw[b] / weightTotal : 0;
    const allocating = basis !== 'none' && weightTotal > 0;

    // ── Rows ────────────────────────────────────────────────────────
    const centralLines = [
      ['Site management & cook', acc.siteMgmt],
      ['Central staff (exec / admin / NI relief)', acc.centralStaff],
      ['Premises (rent / SC / NDR / maintenance)', acc.premises],
      ['Utilities', acc.utilities],
      ['Consumables & food', acc.consumables],
      ['Other overheads', acc.otherOh],
      ['Central admin', acc.centralAdmin],
      ['Pre-opening', acc.preOpening],
    ].filter(([, m]) => m[CENTRAL] !== 0);

    const centralTotal = centralLines.reduce((s, [, m]) => s + m[CENTRAL], 0);

    const cols = [...activeBands, CENTRAL];
    const colVal = (m) => Object.fromEntries(cols.map(c => [c, m[c] || 0]));

    const revenue = {};
    const contribution = {};
    const allocated = {};
    const ebitda = {};
    for (const c of cols) {
      revenue[c] = (acc.revPrivate[c] || 0) + (acc.revFunded[c] || 0);
      contribution[c] = revenue[c] - (acc.roomStaff[c] || 0);
      allocated[c] = c === CENTRAL
        ? (allocating ? 0 : centralTotal)
        : (allocating ? centralTotal * (share[c] || 0) : 0);
      ebitda[c] = contribution[c] - allocated[c];
    }

    // Tie-out against the engine's own P&L lines.
    const pnl = (nt) => outputs.filter(o => o.nominal_type === nt && setP.has(o.period)
      && (!entityIds || o.entity_id == null || entityIds.has(o.entity_id)))
      .reduce((s, o) => s + Number(o.amount_p), 0);
    const revCheck = Object.values(revenue).reduce((s, v) => s + v, 0) - pnl('pnl.revenue_total');
    const ebitdaCheck = Object.values(ebitda).reduce((s, v) => s + v, 0) - pnl('pnl.ebitda');

    // When allocating, spread each central line by the same shares so the
    // Central column genuinely clears to zero and every row stays additive.
    const centralLinesDisplay = allocating
      ? centralLines.map(([label, m]) => {
          const spread = { [CENTRAL]: 0 };
          for (const b of activeBands) spread[b] = m[CENTRAL] * (share[b] || 0);
          return [label, spread];
        })
      : centralLines;

    return {
      cols, activeBands, acc, centralLines: centralLinesDisplay, centralTotal, allocating, share,
      revenue, contribution, allocated, ebitda,
      revCheck, ebitdaCheck,
    };
  }, [outputs, yearPeriods, entityIds, scopedEntities, basis, manual]);

  const { cols, activeBands, acc, centralLines, centralTotal, allocating,
          revenue, contribution, allocated, ebitda, revCheck, ebitdaCheck } = model;

  const colLabel = (c) => c === CENTRAL ? 'Central' : AGE_BAND_LABELS[c] || c;
  const total = (m) => cols.reduce((s, c) => s + (m[c] || 0), 0);
  const manualSum = activeBands.reduce((s, b) => s + (Number(manual[b]) || 0), 0);

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
        Revenue and room staff are attributed by age band — they're the only figures the model
        drives per band. Site management, premises, overheads and pre-opening are genuinely
        indirect and start in <strong>Central</strong>; choose a basis below to push them out to
        the bands. Contribution is revenue less room staff only.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <span style={{ fontSize: 11, color: colors.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }}>
          Allocate central costs by
        </span>
        <select value={basis} onChange={(e) => setBasis(e.target.value)} style={{ ...selectStyle, minWidth: 280 }}>
          {BASES.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
        </select>
        {basis === 'manual' && (
          <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {activeBands.map(b => (
              <label key={b} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                <span style={{ color: colors.muted }}>{AGE_BAND_LABELS[b]}</span>
                <input
                  value={manual[b] ?? ''}
                  onChange={(e) => setManualBand(b, e.target.value)}
                  placeholder="0"
                  inputMode="decimal"
                  style={{ width: 56, padding: '4px 6px', textAlign: 'right', borderRadius: 6,
                           border: `1px solid ${colors.border}`, fontSize: 12, fontFamily: fontStack }}
                />
                <span style={{ color: colors.muted }}>%</span>
              </label>
            ))}
            <Pill color={Math.abs(manualSum - 100) < 0.5 ? colors.green : colors.amber}>
              {manualSum.toFixed(0)}%
            </Pill>
            {Math.abs(manualSum - 100) >= 0.5 && manualSum > 0 && (
              <span style={{ fontSize: 11, color: colors.muted }}>
                (scaled pro-rata to 100%)
              </span>
            )}
          </span>
        )}
      </div>

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
            <SectionRow label="Income" cols={cols} />
            <Row label="Private fees" m={acc.revPrivate} cols={cols} total={total} />
            <Row label="LA funded" m={acc.revFunded} cols={cols} total={total} />
            <Row label="Revenue" m={revenue} cols={cols} total={total} strong />

            <SectionRow label="Direct cost of delivery" cols={cols} />
            <Row label="Room staff (ratio-driven)" m={acc.roomStaff} cols={cols} total={total} negate />
            <Row label="Contribution" m={contribution} cols={cols} total={total} strong />
            <PctRow label="Contribution margin" num={contribution} den={revenue} cols={cols} total={total} />

            <SectionRow label={allocating ? 'Central costs (allocated out)' : 'Central costs (unallocated)'} cols={cols} />
            {centralLines.map(([label, m]) => (
              <Row key={label} label={label} m={m} cols={cols} total={total} negate />
            ))}
            <Row label="Total central costs" m={allocating ? allocated : { [CENTRAL]: centralTotal }}
              cols={cols} total={total} negate strong />

            <SectionRow label="Result" cols={cols} />
            <Row label="EBITDA" m={ebitda} cols={cols} total={total} strong />
            <PctRow label="EBITDA margin" num={ebitda} den={revenue} cols={cols} total={total} />
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: colors.muted, marginTop: 10 }}>
        {Math.abs(revCheck) < 100 && Math.abs(ebitdaCheck) < 100
          ? '✓ Ties to the P&L: revenue and EBITDA agree with the Profit & Loss tab for this scope and period.'
          : `⚠ Tie-out variance vs P&L — revenue ${money(revCheck)}, EBITDA ${money(ebitdaCheck)}. ` +
            'Depreciation, interest and tax sit below EBITDA and are not shown here.'}
        {' '}EBITDA excludes depreciation, interest and tax.
      </p>
    </Section>
  );
}

function Row({ label, m, cols, total, strong, negate, subtle }) {
  const v = (c) => {
    const raw = m[c] || 0;
    return negate ? -raw : raw;
  };
  return (
    <tr style={{ borderBottom: `1px dotted ${colors.borderSoft}`, background: strong ? colors.bgSoft : '#fff' }}>
      <td style={{ ...td, fontWeight: strong ? 700 : 400, fontStyle: subtle ? 'italic' : 'normal',
                   paddingLeft: subtle ? 20 : 8, color: subtle ? colors.muted : colors.ink }}>{label}</td>
      {cols.map(c => (
        <td key={c} style={{ ...tdR, fontWeight: strong ? 600 : 400,
                             borderLeft: c === CENTRAL ? `1px solid ${colors.border}` : undefined,
                             color: v(c) < 0 ? colors.red : colors.ink }}>
          {m[c] == null && c !== CENTRAL ? '—' : money(v(c))}
        </td>
      ))}
      <td style={{ ...tdR, fontWeight: 700, borderLeft: `1px solid ${colors.border}`,
                   color: (negate ? -total(m) : total(m)) < 0 ? colors.red : colors.ink }}>
        {money(negate ? -total(m) : total(m))}
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

function SectionRow({ label, cols }) {
  return (
    <tr>
      <td colSpan={cols.length + 2} style={{
        padding: '14px 8px 4px', fontSize: 10, fontWeight: 700, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: `1px solid ${colors.border}`,
      }}>{label}</td>
    </tr>
  );
}

const th = { padding: '6px 8px', textAlign: 'left', fontWeight: 600, color: colors.muted,
             borderBottom: `1px solid ${colors.border}`, background: colors.bgSoft, fontSize: 10,
             textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap' };
const td = { padding: '6px 8px', color: colors.ink, verticalAlign: 'middle' };
const tdR = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
