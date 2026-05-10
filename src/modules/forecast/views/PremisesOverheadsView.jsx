// Detailed cost view: every cost line broken out per period, organised by
// the same categories used on the P&L:
//   - Direct costs (consumables / food)
//   - Premises (rent / service charge / NDR / maintenance / depreciation)
//   - Overheads (utilities / insurance / software / marketing / professional fees / central admin)
//   - Pre-opening (registration overhead / pre-opening marketing / staffing)
//   - Financing (mortgage interest / bank loan interest / director loan interest)
//
// Every cell is clickable — opens the DrillModal with a custom spec
// scoped to that line label so you can see the contributing entity rows.

import React, { useMemo, useState } from 'react';
import { colors, fmtP, fontStack, H2 } from '../components/ui';
import LocationFilter, { resolveFilterToEntityIds, filterLabel } from '../components/LocationFilter';
import DrillModal from '../components/DrillModal';

export default function PremisesOverheadsView({
  outputs, forecast, periods, scenarioId,
  entities = [], groups = [], assignments = [],
  filter, onFilterChange,
}) {
  const [granularity, setGranularity] = useState('annual');
  const [drillCell, setDrillCell] = useState(null);

  const entityIds = useMemo(() => resolveFilterToEntityIds(filter, entities, assignments),
    [filter, entities, assignments]);
  const grouped = groupPeriods(periods, granularity);
  const entitiesById = useMemo(() => Object.fromEntries(entities.map(e => [e.id, e])), [entities]);
  const inScope = (r) => !entityIds || r.entity_id == null || entityIds.has(r.entity_id);

  const sections = useMemo(() => buildSections(outputs, inScope), [outputs, entityIds]);

  const sumOver = (byPeriod, periods) => {
    if (!byPeriod) return 0;
    let s = 0;
    for (const p of periods) s += (byPeriod[p] || 0);
    return s;
  };

  const renderSection = (title, byLabel, color, drillSpecBuilder) => {
    const labels = Object.keys(byLabel).sort();
    if (labels.length === 0) return null;

    const groupTotals = grouped.map(g =>
      labels.reduce((s, l) => s + sumOver(byLabel[l], g.periods), 0)
    );

    return (
      <React.Fragment key={title}>
        <SectionRow label={title} colSpan={1 + grouped.length} color={color} />
        {labels.map(lbl => (
          <tr key={lbl} style={tr}>
            <td style={{ ...td, paddingLeft: 22 }}>{lbl}</td>
            {grouped.map((g, i) => {
              const v = sumOver(byLabel[lbl], g.periods);
              return (
                <td
                  key={i}
                  onClick={() => setDrillCell({
                    line: { nominal_type: 'detail', label: lbl, drill: drillSpecBuilder(lbl) },
                    periods: g.periods, periodsLabel: g.label, total_p: v,
                  })}
                  style={{ ...tdR, cursor: 'pointer', userSelect: 'none' }}
                  onMouseEnter={(e) => e.currentTarget.style.background = '#f0f9ff'}
                  onMouseLeave={(e) => e.currentTarget.style.background = ''}
                >
                  {fmtP(v, { compact: true })}
                </td>
              );
            })}
          </tr>
        ))}
        <tr style={{ ...tr, fontWeight: 700, background: colors.bgSoft }}>
          <td style={td}>{title} subtotal</td>
          {groupTotals.map((v, i) => <td key={i} style={tdR}>{fmtP(v, { compact: true })}</td>)}
        </tr>
      </React.Fragment>
    );
  };

  // Drill spec builders — each section's predicate identifies the right rows
  const drillBuilders = {
    direct: (lbl) => ({
      kind: 'upstream',
      upstream_nts: ['overhead'],
      filter: (r) => (r.line_label || '') === lbl && /consumable|food/i.test(r.line_label || ''),
    }),
    premises: (lbl) => ({
      kind: 'upstream',
      upstream_nts: ['overhead', 'depreciation'],
      filter: (r) => (r.line_label || '') === lbl,
    }),
    overheads: (lbl) => ({
      kind: 'upstream',
      upstream_nts: ['overhead'],
      filter: (r) => (r.line_label || '') === lbl,
    }),
    preOpening: (lbl) => ({
      kind: 'upstream',
      upstream_nts: ['overhead', 'staff_cost'],
      filter: (r) => r.module_key === 'pre_opening' && (r.line_label || '') === lbl,
    }),
    financing: (lbl) => ({
      kind: 'upstream',
      upstream_nts: ['debt_interest'],
      filter: (r) => (r.line_label || '') === lbl,
    }),
  };

  // Grand total across all sections
  const grandTotals = grouped.map(g => {
    let s = 0;
    for (const sec of [sections.direct, sections.premises, sections.overheads, sections.preOpening, sections.financing]) {
      for (const lbl of Object.keys(sec)) s += sumOver(sec[lbl], g.periods);
    }
    return s;
  });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
        <H2>
          Premises & overheads <span style={{ fontSize: 13, fontWeight: 400, color: colors.muted, marginLeft: 8 }}>· {filterLabel(filter, entities, groups)}</span>
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

      <p style={{ fontSize: 11, color: colors.muted, margin: '0 0 10px' }}>
        Direct costs are tied to attendance (consumables / food). Premises = operating costs of holding the property
        plus depreciation. Overheads are general site / group costs. Financing costs (interest) sit below EBITDA on the P&L.
        Click any cell to drill into the contributing rows.
      </p>

      <div style={{ overflowX: 'auto', border: `1px solid ${colors.border}`, borderRadius: 8, background: '#fff' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: fontStack }}>
          <thead>
            <tr style={{ background: colors.bgSoft }}>
              <th style={{ ...th, position: 'sticky', left: 0, background: colors.bgSoft, minWidth: 220 }}>Line</th>
              {grouped.map(g => <th key={g.label} style={{ ...th, textAlign: 'right', minWidth: 80 }}>{g.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {renderSection('Direct costs',  sections.direct,    '#16a34a', drillBuilders.direct)}
            {renderSection('Premises',      sections.premises,  '#1e3a8a', drillBuilders.premises)}
            {renderSection('Overheads',     sections.overheads, '#475569', drillBuilders.overheads)}
            {renderSection('Pre-opening',   sections.preOpening,'#7c3aed', drillBuilders.preOpening)}
            {renderSection('Financing costs', sections.financing, '#b91c1c', drillBuilders.financing)}
            <tr style={{ ...tr, fontWeight: 700, background: '#0f172a', color: '#fff' }}>
              <td style={{ ...td, color: '#fff' }}>Grand total</td>
              {grandTotals.map((v, i) => <td key={i} style={{ ...tdR, color: '#fff' }}>{fmtP(v, { compact: true })}</td>)}
            </tr>
          </tbody>
        </table>
      </div>

      {drillCell && (
        <DrillModal
          line={drillCell.line}
          periods={drillCell.periods}
          periodsLabel={drillCell.periodsLabel}
          outputs={outputs}
          entityIds={entityIds}
          entitiesById={entitiesById}
          total_p={drillCell.total_p}
          scenarioId={scenarioId}
          onClose={() => setDrillCell(null)}
        />
      )}
    </div>
  );
}

function buildSections(outputs, inScope) {
  const PREMISES_LBLS = ['Rent', 'Service charge', 'NDR', 'Maintenance'];
  const PREMISES_DEP_LBL = 'Property + fit-out';
  const OVERHEAD_LBLS = ['Utilities', 'Insurance', 'Software / IT', 'Marketing', 'Professional fees', 'Central admin'];
  const PREOPENING_LBLS = ['Pre-opening overhead', 'Pre-opening marketing', 'Pre-opening staffing'];

  const collect = (matchFn) => {
    const byLabel = {};
    for (const r of outputs) {
      if (!inScope(r)) continue;
      if (!matchFn(r)) continue;
      const lbl = r.line_label || '(unlabelled)';
      byLabel[lbl] ||= {};
      byLabel[lbl][r.period] = (byLabel[lbl][r.period] || 0) + r.amount_p;
    }
    return byLabel;
  };

  return {
    direct: collect((r) =>
      r.nominal_type === 'overhead' && /consumable|food/i.test(r.line_label || '')
    ),
    premises: collect((r) =>
      (r.nominal_type === 'overhead' && PREMISES_LBLS.includes(r.line_label)) ||
      (r.nominal_type === 'depreciation' && r.module_key === 'premises' && (r.line_label || '') === PREMISES_DEP_LBL)
    ),
    overheads: collect((r) =>
      r.nominal_type === 'overhead' && OVERHEAD_LBLS.includes(r.line_label)
    ),
    preOpening: collect((r) =>
      r.module_key === 'pre_opening' &&
      (r.nominal_type === 'overhead' || r.nominal_type === 'staff_cost' || PREOPENING_LBLS.includes(r.line_label))
    ),
    financing: collect((r) => r.nominal_type === 'debt_interest'),
  };
}

function SectionRow({ label, colSpan, color }) {
  return (
    <tr style={{ background: '#f1f5f9' }}>
      <td colSpan={colSpan} style={{
        padding: '6px 10px', fontWeight: 700, fontSize: 10, textTransform: 'uppercase',
        letterSpacing: 0.5, color: color || colors.muted,
      }}>{label}</td>
    </tr>
  );
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
