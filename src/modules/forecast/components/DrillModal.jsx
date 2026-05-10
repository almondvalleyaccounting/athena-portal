// Click-to-drill modal. Given a clicked cell (line + period range), shows
// (a) for "aggregate-upstream" lines: the contributing fc_output rows
//     grouped by source module / entity / line label
// (b) for "formula" lines: the formula and the values of components
// (c) for "running" lines: the formula and the contributing rows
//
// Inputs:
//   line          — { nominal_type, label, drill }
//   periods       — array of period indices included in the cell's range
//   periodsLabel  — eg "Y3" or "Q2 2026" for the modal title
//   outputs       — full fc_output array (already filtered by entity if applicable)
//   entityIds     — Set<id>|null — used to filter contributors
//   entitiesById  — { [id]: entity } for label resolution
//   total_p       — the cell's total (for header)
//   onClose

import React, { useEffect, useMemo, useState } from 'react';
import { colors, fmtP, fontStack, serifStack } from './ui';
import { loadDriversForContext } from '../lib/queries';
import { trace as traceLine } from '../lib/explainers';

export const DRILL_MAP = {
  // ─── P&L lines ─────────────────────────────────────────────
  'pnl.revenue_total':           { kind: 'upstream', upstream_nts: ['revenue'] },
  'pnl.revenue_private':         { kind: 'upstream', upstream_nts: ['revenue'], filter: r => r.tags?.revenue_kind !== 'funded' },
  'pnl.revenue_la_funded':       { kind: 'upstream', upstream_nts: ['revenue'], filter: r => r.tags?.revenue_kind === 'funded' },
  'pnl.income_inflation_uplift': { kind: 'formula', formula: 'Revenue × (income_inflation_factor − 1)' },
  'pnl.cost_total':              { kind: 'upstream', upstream_nts: ['staff_cost', 'overhead', 'cost_of_sales'] },
  'pnl.cost_inflation_uplift':   { kind: 'formula', formula: 'Operating costs × (cost_inflation_factor − 1)' },

  // Direct (site-level) costs
  'pnl.cost_staff_direct':       { kind: 'upstream', upstream_nts: ['staff_cost'], filter: r =>
    r.module_key !== 'pre_opening' && ['setting_manager','assistant_manager','senior_qualified','qualified','apprentice','practitioner'].includes(r.tags?.role)
  },
  'pnl.cost_direct_costs':       { kind: 'upstream', upstream_nts: ['overhead', 'cost_of_sales'], filter: r =>
    r.module_key !== 'pre_opening' && /consumable|food/i.test(r.line_label || '')
  },

  // Overheads
  'pnl.cost_staff_overhead':     { kind: 'upstream', upstream_nts: ['staff_cost'], filter: r =>
    r.module_key !== 'pre_opening' && !['setting_manager','assistant_manager','senior_qualified','qualified','apprentice','practitioner'].includes(r.tags?.role)
  },
  'pnl.cost_premises':           { kind: 'upstream', upstream_nts: ['overhead'], filter: r =>
    r.module_key !== 'pre_opening' && ['Rent','Service charge','NDR','Maintenance'].includes(r.line_label || '')
  },
  'pnl.cost_utilities':          { kind: 'upstream', upstream_nts: ['overhead'], filter: r =>
    r.module_key !== 'pre_opening' && /utilit/i.test(r.line_label || '')
  },
  'pnl.cost_other_overhead':     { kind: 'upstream', upstream_nts: ['overhead', 'cost_of_sales'], filter: r => {
    const lbl = r.line_label || '';
    if (r.module_key === 'pre_opening' || /^Pre-opening/i.test(lbl)) return false;
    if (['Rent','Service charge','NDR','Maintenance'].includes(lbl)) return false;
    if (/utilit/i.test(lbl)) return false;
    if (/consumable|food/i.test(lbl)) return false;
    if (lbl === 'Central admin') return false;
    return true;
  }},
  'pnl.cost_admin':              { kind: 'upstream', upstream_nts: ['overhead'], filter: r =>
    r.module_key !== 'pre_opening' && (r.line_label || '') === 'Central admin'
  },
  'pnl.cost_pre_opening':        { kind: 'upstream', upstream_nts: ['staff_cost', 'overhead'], filter: r =>
    r.module_key === 'pre_opening' || /^Pre-opening/i.test(r.line_label || '')
  },

  'pnl.depreciation_total':      { kind: 'upstream', upstream_nts: ['depreciation'] },
  'pnl.interest_total':          { kind: 'upstream', upstream_nts: ['debt_interest'] },
  'pnl.tax_total':               { kind: 'upstream', upstream_nts: ['tax'] },
  'pnl.dividends':               { kind: 'formula', formula: 'YTD NPAT × payout_ratio (paid at year-end)' },

  'pnl.ebitda':  { kind: 'formula', formula: 'Revenue − Operating costs', components: ['pnl.revenue_total', 'pnl.cost_total'] },
  'pnl.ebit':    { kind: 'formula', formula: 'EBITDA − Depreciation', components: ['pnl.ebitda', 'pnl.depreciation_total'] },
  'pnl.pbt':     { kind: 'formula', formula: 'EBIT + Interest', components: ['pnl.ebit', 'pnl.interest_total'] },
  'pnl.npat':    { kind: 'formula', formula: 'PBT + Tax', components: ['pnl.pbt', 'pnl.tax_total'] },

  // ─── BS lines ──────────────────────────────────────────────
  'bs.fixed_assets_gross':        { kind: 'running', formula: 'Σ capex (cumulative)', upstream_nts: ['capex'] },
  'bs.accumulated_depreciation':  { kind: 'running', formula: 'Σ depreciation (cumulative)', upstream_nts: ['depreciation'] },
  'bs.fixed_assets_net':          { kind: 'formula', formula: 'Fixed assets gross − Accumulated depreciation', components: ['bs.fixed_assets_gross', 'bs.accumulated_depreciation'] },
  'bs.cash':                      { kind: 'formula', formula: 'Opening cash + Σ net cash movement' },
  'bs.debt':                      { kind: 'upstream', upstream_nts: ['debt_balance'], aggregate: 'last' },
  'bs.equity':                    { kind: 'formula', formula: 'Opening equity + Σ NPAT − Σ dividends' },
  'bs.tax_payable':               { kind: 'formula', formula: 'Σ tax accrued − Σ tax paid (lagged)' },
  'bs.net_wc':                    { kind: 'wc_balance' },

  // ─── CF lines ──────────────────────────────────────────────
  'cf.opening_cash':     { kind: 'formula', formula: 'Closing cash from prior period' },
  'cf.in.private':       { kind: 'upstream', upstream_nts: ['revenue'], filter: r => r.tags?.revenue_kind !== 'funded' },
  'cf.in.la_funded':     { kind: 'upstream', upstream_nts: ['revenue'], filter: r => r.tags?.revenue_kind === 'funded' },
  'cf.in.debt_drawdown': { kind: 'formula', formula: 'Increases in mortgage outstanding' },
  'cf.out.staff':        { kind: 'upstream', upstream_nts: ['staff_cost'], filter: r => r.module_key !== 'pre_opening' },
  'cf.out.premises':     { kind: 'upstream', upstream_nts: ['overhead'], filter: r => ['Rent','Service charge','NDR','Maintenance'].includes(r.line_label || '') },
  'cf.out.utilities':    { kind: 'upstream', upstream_nts: ['overhead'], filter: r => /utilit/i.test(r.line_label || '') },
  'cf.out.other_overhead': { kind: 'upstream', upstream_nts: ['overhead', 'cost_of_sales'], filter: r =>
    !['Rent','Service charge','NDR','Maintenance'].includes(r.line_label || '')
    && !/utilit/i.test(r.line_label || '')
    && r.module_key !== 'pre_opening'
    && !/^Pre-opening/i.test(r.line_label || '')
  },
  'cf.out.pre_opening':  { kind: 'upstream', upstream_nts: ['staff_cost', 'overhead'], filter: r =>
    r.module_key === 'pre_opening' || /^Pre-opening/i.test(r.line_label || '')
  },
  'cf.out.pre_opening_overhead': { kind: 'upstream', upstream_nts: ['overhead'], filter: r =>
    (r.module_key === 'pre_opening' || /^Pre-opening/i.test(r.line_label || '')) &&
    !/marketing/i.test(r.line_label || '')
  },
  'cf.out.pre_opening_marketing':{ kind: 'upstream', upstream_nts: ['overhead'], filter: r =>
    (r.module_key === 'pre_opening' || /^Pre-opening/i.test(r.line_label || '')) &&
    /marketing/i.test(r.line_label || '')
  },
  'cf.out.pre_opening_staffing': { kind: 'upstream', upstream_nts: ['staff_cost'], filter: r =>
    r.module_key === 'pre_opening'
  },
  'cf.out.one_off_total':   { kind: 'formula', formula: 'Capex + Pre-opening (overhead + marketing + staffing)', components: ['cf.out.capex', 'cf.out.pre_opening_overhead', 'cf.out.pre_opening_marketing', 'cf.out.pre_opening_staffing'] },
  'cf.out.recurring_total': { kind: 'formula', formula: 'Staff + Premises + Utilities + Other overheads', components: ['cf.out.staff', 'cf.out.premises', 'cf.out.utilities', 'cf.out.other_overhead'] },
  'cf.out.fin_tax_total':   { kind: 'formula', formula: 'Interest + Principal + Tax + Dividends', components: ['cf.out.interest', 'cf.out.principal', 'cf.out.tax', 'cf.out.dividends'] },
  'cf.out.capex':        { kind: 'upstream', upstream_nts: ['capex'] },
  'cf.out.interest':     { kind: 'upstream', upstream_nts: ['debt_interest'] },
  'cf.out.principal':    { kind: 'upstream', upstream_nts: ['debt_principal'] },
  'cf.out.tax':          { kind: 'formula', formula: 'Tax accrued 9 months ago (cash settlement of CT)' },
  'cf.out.dividends':    { kind: 'formula', formula: 'Year-end dividend = YTD NPAT × payout ratio' },
  'cf.wc_movement':      { kind: 'upstream', upstream_nts: ['working_capital_movement'] },
};

export default function DrillModal({ line, periods, periodsLabel, outputs, entityIds, entitiesById, total_p, onClose, scopedMap, scenarioId }) {
  // Caller can supply a custom drill spec via line.drill — used by the
  // Premises & Overheads view for ad-hoc cost-line drills.
  const drill = line.drill || DRILL_MAP[line.nominal_type] || { kind: 'unsupported' };
  const periodSet = useMemo(() => new Set(periods), [periods]);

  const inScope = (r) => !entityIds || r.entity_id == null || entityIds.has(r.entity_id);

  const contributors = useMemo(() => {
    if (drill.kind !== 'upstream' && drill.kind !== 'running' && drill.kind !== 'wc_balance') return null;
    const wantedNts = drill.upstream_nts || [];
    const filterFn = drill.filter || (() => true);
    const list = [];
    for (const r of outputs) {
      if (!periodSet.has(r.period)) continue;
      if (drill.kind !== 'wc_balance' && !wantedNts.includes(r.nominal_type)) continue;
      if (drill.kind === 'wc_balance' && !String(r.nominal_type).startsWith('wc_balance.')) continue;
      if (!inScope(r)) continue;
      if (!filterFn(r)) continue;
      list.push(r);
    }
    // Group by entity → module → line_label, but also keep entity_id alongside the label
    const grouped = {};
    for (const r of list) {
      const entKey = r.entity_id || '__group__';
      const entLabel = r.entity_id ? (entitiesById?.[r.entity_id]?.label || 'Location') : 'Group';
      const mod = r.module_key;
      const lbl = r.line_label || '(no label)';
      grouped[entKey] ||= { label: entLabel, entity_id: r.entity_id || null, modules: {} };
      grouped[entKey].modules[mod] ||= {};
      grouped[entKey].modules[mod][lbl] ||= 0;
      grouped[entKey].modules[mod][lbl] += r.amount_p;
    }
    return grouped;
  }, [drill, outputs, periodSet, entityIds, entitiesById]);

  return (
    <div onClick={onClose} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>
              {line.nominal_type} · {periodsLabel}
            </div>
            <h2 style={{ fontFamily: serifStack, fontSize: 24, fontWeight: 500, color: colors.ink, margin: '4px 0 0' }}>
              {line.label}
            </h2>
            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 18, fontWeight: 600, color: colors.ink, marginTop: 6 }}>
              {fmtP(total_p, { compact: true })}
            </div>
          </div>
          <button onClick={onClose} style={closeBtn}>×</button>
        </div>

        <div style={{ marginTop: 18 }}>
          {drill.kind === 'formula' && (
            <FormulaSection drill={drill} line={line} periods={periods} scopedMap={scopedMap} />
          )}
          {(drill.kind === 'upstream' || drill.kind === 'running' || drill.kind === 'wc_balance') && (
            <ContributorsSection contributors={contributors} scenarioId={scenarioId} periods={periods} entitiesById={entitiesById} />
          )}
          {drill.kind === 'unsupported' && (
            <p style={{ color: colors.muted, fontSize: 13 }}>No drill view configured for this line.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function FormulaSection({ drill, periods, scopedMap }) {
  return (
    <>
      <div style={{ padding: 12, background: colors.bgSoft, borderRadius: 8, fontFamily: 'ui-monospace, monospace', fontSize: 13, color: colors.ink }}>
        {drill.formula}
      </div>
      {drill.components && (
        <table style={tableStyle}>
          <thead><tr><th style={th}>Component</th><th style={{ ...th, textAlign: 'right' }}>Amount</th></tr></thead>
          <tbody>
            {drill.components.map(c => {
              let total = 0;
              for (const t of periods) {
                const v = scopedMap?.get(`${c}::${t}`);
                if (v != null) total += v;
              }
              return (
                <tr key={c} style={{ borderBottom: `1px solid ${colors.borderSoft}` }}>
                  <td style={td}><code style={{ fontSize: 11 }}>{c}</code></td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>{fmtP(total, { compact: true })}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

function ContributorsSection({ contributors, scenarioId, periods, entitiesById }) {
  const [expanded, setExpanded] = useState(null);   // `${entKey}|${mod}|${lbl}` when expanded
  if (!contributors) return null;
  const entries = Object.entries(contributors);
  if (entries.length === 0) {
    return <p style={{ color: colors.muted, fontSize: 13 }}>No contributing rows in scope for this period.</p>;
  }
  const toggle = (key) => setExpanded(prev => prev === key ? null : key);
  return (
    <div>
      <p style={{ fontSize: 11, color: colors.muted, margin: '0 0 6px' }}>
        Click a module row to drill into its driver assumptions.
      </p>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={th}>Source</th>
            <th style={th}>Line</th>
            <th style={{ ...th, textAlign: 'right' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([entKey, ent]) => (
            <React.Fragment key={entKey}>
              <tr style={{ background: colors.bgSoft }}>
                <td colSpan={3} style={{ ...td, fontWeight: 700 }}>{ent.label}</td>
              </tr>
              {Object.entries(ent.modules).flatMap(([mod, lines]) => (
                Object.entries(lines).map(([lbl, amt]) => {
                  const rowKey = `${entKey}|${mod}|${lbl}`;
                  const isExpanded = expanded === rowKey;
                  return (
                    <React.Fragment key={rowKey}>
                      <tr
                        onClick={() => toggle(rowKey)}
                        style={{
                          borderBottom: `1px solid ${colors.borderSoft}`,
                          cursor: 'pointer',
                          background: isExpanded ? '#f0f9ff' : 'transparent',
                        }}
                      >
                        <td style={{ ...td, color: colors.muted, fontSize: 11 }}>
                          <span style={{ marginRight: 4, color: colors.accent, fontFamily: 'ui-monospace, monospace' }}>
                            {isExpanded ? '▾' : '▸'}
                          </span>
                          {mod}
                        </td>
                        <td style={td}>{lbl}</td>
                        <td style={{ ...td, textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>
                          {fmtP(amt, { compact: true })}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={3} style={{ padding: 0, background: '#f8fafc' }}>
                            <DriversPanel
                              scenarioId={scenarioId}
                              moduleKey={mod}
                              entityId={ent.entity_id}
                              entity={ent.entity_id ? entitiesById?.[ent.entity_id] : null}
                              periods={periods}
                              lineLabel={lbl}
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DriversPanel({ scenarioId, moduleKey, entityId, entity, periods, lineLabel }) {
  const [state, setState] = useState({ loading: true, drivers: [], values: [], err: null });
  const [tracePeriod, setTracePeriod] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!scenarioId) { setState({ loading: false, drivers: [], values: [], err: 'No scenario context' }); return; }
    setState(s => ({ ...s, loading: true, err: null }));
    (async () => {
      try {
        const r = await loadDriversForContext({ scenario_id: scenarioId, module_key: moduleKey, entity_id: entityId });
        if (!cancelled) setState({ loading: false, drivers: r.drivers, values: r.values, err: null });
      } catch (e) {
        if (!cancelled) setState({ loading: false, drivers: [], values: [], err: e.message });
      }
    })();
    return () => { cancelled = true; };
  }, [scenarioId, moduleKey, entityId]);

  useEffect(() => {
    // Default trace period to the LAST period in the drilled range
    if (periods && periods.length > 0) setTracePeriod(Math.max(...periods));
  }, [periods]);

  if (state.loading) return <div style={{ padding: 12, fontSize: 12, color: colors.muted }}>Loading drivers…</div>;
  if (state.err) return <div style={{ padding: 12, fontSize: 12, color: colors.red }}>{state.err}</div>;
  if (state.drivers.length === 0) {
    return <div style={{ padding: 12, fontSize: 12, color: colors.muted }}>No drivers stored for this module / entity.</div>;
  }

  // Try to produce a calc trace for this line at the chosen period
  const traceResult = tracePeriod != null ? traceLine({
    moduleKey, lineLabel, period: tracePeriod, entity, drivers: state.drivers, values: state.values,
  }) : null;

  const valueOf = (driverId, period = -1) => {
    const v = state.values.find(v => v.driver_id === driverId && v.period === period);
    return v?.value;
  };

  const fmtVal = (d) => {
    if (d.kind === 'linked') return <code style={{ fontSize: 11, color: colors.muted }}>{d.expression || '—'}</code>;
    if (d.kind === 'scalar') {
      const v = valueOf(d.id, -1);
      if (v == null) return <span style={{ color: colors.muted }}>—</span>;
      return formatDriverValue(v, d.unit);
    }
    if (d.kind === 'timeseries') {
      // Show value at first period in the drilled range, plus min/max if differ
      const minP = Math.min(...periods);
      const maxP = Math.max(...periods);
      const samples = state.values.filter(v => v.driver_id === d.id && v.period >= minP && v.period <= maxP);
      if (samples.length === 0) return <span style={{ color: colors.muted }}>—</span>;
      const vals = samples.map(s => Number(s.value));
      const lo = Math.min(...vals), hi = Math.max(...vals);
      if (lo === hi) return formatDriverValue(lo, d.unit);
      return (
        <span>
          {formatDriverValue(lo, d.unit)} – {formatDriverValue(hi, d.unit)}
          <span style={{ color: colors.muted, fontSize: 10, marginLeft: 4 }}>(over period range)</span>
        </span>
      );
    }
    return null;
  };

  return (
    <div style={{ padding: 10, borderLeft: `3px solid ${colors.accent}` }}>
      {traceResult && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div style={{ fontSize: 10, color: colors.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Calculation — {lineLabel} · t={tracePeriod}
            </div>
            {periods.length > 1 && (
              <div style={{ display: 'flex', gap: 2, alignItems: 'center', fontSize: 11 }}>
                <span style={{ color: colors.muted, marginRight: 4 }}>Period:</span>
                <select value={tracePeriod} onChange={(e) => setTracePeriod(Number(e.target.value))} style={{ padding: '3px 6px', fontSize: 11, border: `1px solid ${colors.border}`, borderRadius: 4, fontFamily: fontStack, background: '#fff' }}>
                  {periods.map(p => <option key={p} value={p}>t={p}</option>)}
                </select>
              </div>
            )}
          </div>
          {traceResult.formula && (
            <div style={{ padding: '6px 10px', background: colors.bgSoft, borderRadius: 6, fontFamily: 'ui-monospace, monospace', fontSize: 11, color: colors.inkSoft, marginBottom: 8 }}>
              {traceResult.formula}
            </div>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: fontStack, background: '#fff', border: `1px solid ${colors.borderSoft}`, borderRadius: 6 }}>
            <tbody>
              {traceResult.steps.map((s, i) => (
                <tr key={i} style={{
                  borderTop: i > 0 ? `1px solid ${colors.borderSoft}` : 'none',
                  background: s.kind === 'result' ? '#fef3c7' : (s.kind === 'note' ? '#f8fafc' : '#fff'),
                }}>
                  <td style={{ padding: '5px 8px', color: s.kind === 'note' ? colors.muted : colors.ink, fontStyle: s.kind === 'note' ? 'italic' : 'normal' }}>
                    {s.label}
                  </td>
                  <td style={{ padding: '5px 8px', color: colors.muted, fontFamily: 'ui-monospace, monospace' }}>
                    {s.expr || ''}
                  </td>
                  <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'ui-monospace, monospace', fontWeight: s.kind === 'result' ? 700 : 400 }}>
                    {s.value || ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!traceResult && tracePeriod != null && (
        <div style={{ padding: '6px 10px', background: colors.bgSoft, borderRadius: 6, fontSize: 11, color: colors.muted, marginBottom: 10 }}>
          No detailed calculation trace yet for this line. Drivers below.
        </div>
      )}
      <div style={{ fontSize: 10, color: colors.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
        Drivers — {moduleKey} {entityId ? '· entity-scoped' : '· group'}
        <span style={{ marginLeft: 8, color: colors.muted, fontWeight: 400 }}>({state.drivers.length})</span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: fontStack }}>
        <thead>
          <tr>
            <th style={driverTh}>Driver</th>
            <th style={driverTh}>Scope</th>
            <th style={driverTh}>Kind</th>
            <th style={{ ...driverTh, textAlign: 'right' }}>Value</th>
          </tr>
        </thead>
        <tbody>
          {state.drivers.map(d => (
            <tr key={d.id} style={{ borderTop: `1px solid ${colors.borderSoft}` }}>
              <td style={driverTd}>
                <strong>{d.label}</strong>
                <div style={{ fontSize: 9, color: colors.muted, fontFamily: 'ui-monospace, monospace' }}>{d.driver_key}</div>
              </td>
              <td style={driverTd}>
                <span style={{ fontSize: 10, color: colors.muted }}>{d.entity_id ? 'entity' : 'group'}</span>
              </td>
              <td style={driverTd}>
                <span style={{ fontSize: 10, color: colors.muted }}>{d.kind}</span>
              </td>
              <td style={{ ...driverTd, textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>
                {fmtVal(d)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatDriverValue(v, unit) {
  if (v == null) return '—';
  if (unit === 'gbp_p') return '£' + (Number(v) / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 });
  if (unit === 'pct') return Number(v).toFixed(2) + '%';
  if (unit === 'count' || unit === 'hours' || unit === 'sqft' || unit === 'ratio') return Number(v).toLocaleString('en-GB');
  return String(v);
}

const backdrop = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: fontStack };
const card = { background: '#fff', borderRadius: 16, padding: 28, maxWidth: 720, width: '100%', maxHeight: '85vh', overflowY: 'auto' };
const closeBtn = { background: 'transparent', border: 'none', fontSize: 28, color: colors.muted, cursor: 'pointer', padding: 0, lineHeight: 1, fontFamily: fontStack };
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: fontStack, marginTop: 12 };
const th = { padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: colors.muted, borderBottom: `1px solid ${colors.border}` };
const td = { padding: '8px 10px', color: colors.ink };
const driverTh = { padding: '4px 8px', textAlign: 'left', fontWeight: 600, color: colors.muted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 };
const driverTd = { padding: '6px 8px', color: colors.ink };
