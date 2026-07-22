import React, { useMemo, useState } from 'react';
import { colors, fmtP, fontStack, KPI, serifStack, H2 } from '../components/ui';
import LocationFilter, { resolveFilterToEntityIds, filterLabel } from '../components/LocationFilter';
import { scopedAggregate } from '../lib/aggregator';

export default function DealView({
  outputs, forecast, periods,
  entities = [], groups = [], assignments = [],
  filter, onFilterChange,
}) {
  const entityIds = useMemo(() => resolveFilterToEntityIds(filter, entities, assignments),
    [filter, entities, assignments]);
  const usingScoped = !!entityIds;
  const [explainKey, setExplainKey] = useState(null);

  // Scoped EBITDA at exit: re-derive from upstream when filtered.
  const scopedMap = useMemo(() => {
    if (!usingScoped) return null;
    return scopedAggregate({
      outputs, periods, entityIds,
      // 'derive' inherits the scenario's inflation + dividend policy and
      // starts cash from the capital attributed to the in-scope locations
      // (central/unallocated pot excluded — see aggregator.js).
      inflationPct: 'derive',
      openingCash: 'derive', openingEquity: 'derive', taxLagMonths: 9,
    });
  }, [usingScoped, outputs, periods, entityIds]);

  const exit = pickExit(outputs);
  if (!exit) return (
    <div>
      <FilterBar entities={entities} groups={groups} assignments={assignments} filter={filter} onFilterChange={onFilterChange} />
      <p style={{ color: colors.muted }}>No deal outputs yet — recompute the forecast.</p>
    </div>
  );

  const ev = exit['deal.enterprise_value'] || 0;
  const eb = exit['deal.ebitda_at_exit'] || 0;
  const nd = exit['deal.net_debt_at_exit'] || 0;
  const tx = exit['deal.transaction_costs'] || 0;
  const xtax = exit['deal.exit_tax'] || 0;
  const eq = exit['deal.equity_proceeds'] || 0;
  const irr = (exit['deal.investor_irr_bps'] || 0) / 10000;
  const moic = (exit['deal.moic_x10000'] || 0) / 10000;

  // Football field: extract from outputs at exit period
  const exitPeriod = exit._period;
  const ff = outputs.filter(o => o.nominal_type === 'deal.football_field' && o.period === exitPeriod);
  const multiples = [...new Set(ff.map(o => o.tags?.multiple))].sort((a, b) => a - b);
  const ebitdaPcts = [...new Set(ff.map(o => o.tags?.ebitda_pct))].sort((a, b) => a - b);
  const valueOf = (m, e) => ff.find(o => o.tags?.multiple === m && o.tags?.ebitda_pct === e)?.amount_p ?? 0;

  // For colour scaling
  const cellMin = Math.min(...ff.map(o => o.amount_p));
  const cellMax = Math.max(...ff.map(o => o.amount_p));

  // Scoped LTM EBITDA at exit (informational when filter is on)
  let scopedLtmEbitda = null;
  if (usingScoped && scopedMap && exitPeriod != null) {
    let s = 0;
    for (let i = Math.max(0, exitPeriod - 11); i <= exitPeriod; i++) {
      const v = scopedMap.get(`pnl.ebitda::${i}`);
      if (v != null) s += v;
    }
    scopedLtmEbitda = s;
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
        <H2>Exit valuation <span style={{ fontSize: 13, fontWeight: 400, color: colors.muted, marginLeft: 8 }}>· {filterLabel(filter, entities, groups)}</span></H2>
        <FilterBar entities={entities} groups={groups} assignments={assignments} filter={filter} onFilterChange={onFilterChange} />
      </div>

      {usingScoped && (
        <div style={{ padding: '8px 12px', fontSize: 12, color: '#7c2d12', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 6, marginBottom: 12 }}>
          Filter active. EV / IRR / MOIC below are <strong>group-level</strong> (exit deal mechanics live at the group). Scoped LTM EBITDA shown for reference.
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
        <ClickableKPI onClick={() => setExplainKey('ev')} label="Enterprise value" value={fmtP(ev, { compact: true })} hint="EBITDA × multiple" />
        <ClickableKPI onClick={() => setExplainKey('ebitda')} label="EBITDA at exit (LTM)" value={fmtP(eb, { compact: true })} hint={usingScoped ? 'group' : 'click to drill'} />
        {usingScoped && scopedLtmEbitda != null && (
          <KPI label={`LTM EBITDA · ${filterLabel(filter, entities, groups)}`} value={fmtP(scopedLtmEbitda, { compact: true })} color={colors.accent} />
        )}
        <ClickableKPI onClick={() => setExplainKey('netdebt')} label="Net debt" value={fmtP(nd, { compact: true })} hint={nd < 0 ? 'net cash position' : 'click to drill'} />
        <ClickableKPI onClick={() => setExplainKey('equity')} label="Equity proceeds (net)" value={fmtP(eq, { compact: true })} hint="click to drill" />
        <ClickableKPI onClick={() => setExplainKey('irr')} label="Investor IRR" value={`${(irr * 100).toFixed(1)}%`} color={irr > 0.15 ? colors.green : colors.amber} hint="click to drill" />
        <ClickableKPI onClick={() => setExplainKey('moic')} label="Money multiple" value={`${moic.toFixed(2)}×`} color={moic > 2 ? colors.green : colors.amber} hint="click to drill" />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 12 }}>
        <H2>Football field — equity proceeds (net)</H2>
        <p style={{ fontSize: 11, color: colors.muted, margin: 0 }}>
          Multiples range and column count are <strong>editable</strong> in <em>Inputs → Drivers → exit_valuation</em>.
        </p>
      </div>
      <div style={{ overflowX: 'auto', border: `1px solid ${colors.border}`, borderRadius: 8, background: '#fff' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 12, fontFamily: fontStack, width: '100%' }}>
          <thead>
            <tr style={{ background: colors.bgSoft }}>
              <th style={{ ...th, position: 'sticky', left: 0, background: colors.bgSoft }}>EBITDA \ Multiple</th>
              {multiples.map(m => <th key={m} style={{ ...th, textAlign: 'center' }}>{m.toFixed(2)}×</th>)}
            </tr>
          </thead>
          <tbody>
            {ebitdaPcts.map(e => (
              <tr key={e} style={{ borderBottom: `1px solid ${colors.borderSoft}` }}>
                <td style={{ ...td, fontWeight: 600, position: 'sticky', left: 0, background: '#fff' }}>{(e * 100).toFixed(0)}%</td>
                {multiples.map(m => {
                  const v = valueOf(m, e);
                  const t = (v - cellMin) / Math.max(1, (cellMax - cellMin));
                  const bg = `rgba(14, 127, 224, ${0.05 + t * 0.4})`;
                  return (
                    <td key={m} style={{ ...td, textAlign: 'center', fontFamily: 'ui-monospace, monospace', background: bg }}>
                      {fmtP(v, { compact: true })}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: colors.muted, marginTop: 8 }}>
        Net of net debt ({fmtP(nd, { compact: true })}), transaction costs ({fmtP(tx, { compact: true })}) and exit tax ({fmtP(xtax, { compact: true })}).
        Sector context: UK childcare groups have historically traded at 1–6× EBITDA depending on scale and quality.
      </p>

      {explainKey && (
        <DealExplainModal
          kpiKey={explainKey}
          exit={exit}
          outputs={outputs}
          forecast={forecast}
          onClose={() => setExplainKey(null)}
        />
      )}
    </div>
  );
}

function ClickableKPI({ label, value, hint, color, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: 16, background: '#fff', border: `1px solid ${colors.border}`,
        borderRadius: 12, minWidth: 180, cursor: 'pointer', userSelect: 'none',
        transition: 'border-color 0.1s, box-shadow 0.1s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = colors.accent; e.currentTarget.style.boxShadow = '0 1px 4px rgba(14,127,224,0.15)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.boxShadow = 'none'; }}
    >
      <div style={{ fontSize: 11, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>{label}</div>
      <div style={{ fontFamily: serifStack, fontSize: 24, fontWeight: 500, color: color || colors.ink, marginTop: 4 }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: colors.muted, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function DealExplainModal({ kpiKey, exit, outputs, forecast, onClose }) {
  const exitPeriod = exit._period;
  const periodAt = (t) => {
    const d = forecast?.opening_period ? new Date(forecast.opening_period) : null;
    if (!d) return `month ${t}`;
    const m = new Date(d.getFullYear(), d.getMonth() + t, 1);
    return m.toLocaleString('en-GB', { month: 'short', year: 'numeric' });
  };

  const ev = exit['deal.enterprise_value'] || 0;
  const ebitda = exit['deal.ebitda_at_exit'] || 0;
  const netDebt = exit['deal.net_debt_at_exit'] || 0;
  const txnCosts = exit['deal.transaction_costs'] || 0;
  const exitTax = exit['deal.exit_tax'] || 0;
  const equity = exit['deal.equity_proceeds'] || 0;
  const irr = (exit['deal.investor_irr_bps'] || 0) / 10000;
  const moic = (exit['deal.moic_x10000'] || 0) / 10000;

  const debtAtExit = outputs.find(o => o.nominal_type === 'bs.debt' && o.period === exitPeriod)?.amount_p ?? 0;
  const cashAtExit = outputs.find(o => o.nominal_type === 'bs.cash' && o.period === exitPeriod)?.amount_p ?? 0;
  const equityOpening = outputs.find(o => o.nominal_type === 'pnl.npat' && o.period === 0)?.amount_p ?? null;   // not exact
  // Pull opening equity from financial_core driver if persisted
  const openingEquityRow = outputs.find(o => o.nominal_type === 'bs.equity' && o.period === 0);
  const openingEquity = openingEquityRow?.amount_p ?? 0;

  // Compute LTM EBITDA: months exitPeriod-11 .. exitPeriod
  const ltmStart = Math.max(0, exitPeriod - 11);
  const monthlyEbitda = [];
  for (let t = ltmStart; t <= exitPeriod; t++) {
    const row = outputs.find(o => o.nominal_type === 'pnl.ebitda' && o.period === t);
    monthlyEbitda.push({ t, amount: row?.amount_p ?? 0 });
  }
  const ltmTotal = monthlyEbitda.reduce((s, r) => s + r.amount, 0);

  const debtRows = outputs.filter(o => o.nominal_type === 'debt_balance' && o.period === exitPeriod);

  // Configs
  const configs = {
    ev: {
      title: 'Enterprise value',
      formula: 'EBITDA at exit × multiple',
      steps: [
        { label: 'EBITDA at exit (basis)', value: fmtP(ebitda, { compact: true }), kind: 'derived' },
        { label: 'EV/EBITDA multiple', value: ev > 0 && ebitda > 0 ? `${(ev / ebitda).toFixed(2)}×` : '—', kind: 'input' },
        { label: 'Enterprise value', expr: `${fmtP(ebitda, { compact: true })} × ${ev > 0 && ebitda > 0 ? (ev / ebitda).toFixed(2) : '?'}×`, value: fmtP(ev, { compact: true }), kind: 'result' },
      ],
    },
    ebitda: {
      title: `EBITDA at exit · ${periodAt(exitPeriod)}`,
      formula: 'Sum of monthly EBITDA over the trailing 12 months (LTM)',
      steps: [
        { label: 'Last-twelve-months window', value: `${periodAt(ltmStart)} – ${periodAt(exitPeriod)}`, kind: 'note' },
        ...monthlyEbitda.map(r => ({
          label: `  ${periodAt(r.t)}`,
          value: fmtP(r.amount, { compact: true }),
          kind: 'derived',
        })),
        { label: 'LTM EBITDA', value: fmtP(ltmTotal, { compact: true }), kind: 'result' },
      ],
    },
    netdebt: {
      title: `Net debt at exit · ${periodAt(exitPeriod)}`,
      formula: 'Total debt − cash. Negative result means net cash (cash exceeds debt).',
      steps: [
        ...debtRows.map(r => ({
          label: `  Debt: ${r.line_label || 'unknown'}${r.tags?.loan_kind ? ` (${r.tags.loan_kind})` : ''}`,
          value: fmtP(r.amount_p, { compact: true }),
          kind: 'input',
        })),
        { label: 'Total debt', value: fmtP(debtAtExit, { compact: true }), kind: 'derived' },
        { label: 'Less: Cash at exit', value: `(${fmtP(cashAtExit, { compact: true })})`, kind: 'derived' },
        { label: 'Net debt', expr: `${fmtP(debtAtExit, { compact: true })} − ${fmtP(cashAtExit, { compact: true })}`, value: fmtP(netDebt, { compact: true }), kind: 'result' },
        netDebt < 0 ? { label: 'Net cash position — cash exceeds outstanding debt at exit. This is added back to equity proceeds (sale closes with surplus cash).', kind: 'note' } : null,
      ].filter(Boolean),
    },
    equity: {
      title: 'Equity proceeds (net)',
      formula: 'EV − net debt − transaction costs − exit tax',
      steps: [
        { label: 'Enterprise value', value: fmtP(ev, { compact: true }), kind: 'derived' },
        { label: 'Less: net debt', value: `(${fmtP(netDebt, { compact: true })})`, kind: 'derived' },
        { label: 'Less: transaction costs (% of EV)', value: `(${fmtP(txnCosts, { compact: true })})`, kind: 'derived' },
        { label: 'Gross equity', value: fmtP(ev - netDebt - txnCosts, { compact: true }), kind: 'derived' },
        { label: 'Less: exit tax (on gain)', value: `(${fmtP(exitTax, { compact: true })})`, kind: 'derived' },
        { label: 'Net equity proceeds', value: fmtP(equity, { compact: true }), kind: 'result' },
      ],
    },
    irr: {
      title: 'Investor IRR',
      formula: 'Annualised rate where NPV(equity in @ t=0, equity out @ exit) = 0',
      steps: [
        { label: 'Equity invested at t=0', value: `(${fmtP(openingEquity, { compact: true })})`, kind: 'input' },
        { label: 'Net equity proceeds at exit', value: fmtP(equity, { compact: true }), kind: 'derived' },
        { label: `Hold period: ${(exitPeriod / 12).toFixed(1)} years (${exitPeriod} months)`, kind: 'note' },
        { label: 'No interim distributions modelled (dividends affect IRR if added)', kind: 'note' },
        { label: 'Annualised IRR', value: `${(irr * 100).toFixed(2)}%`, kind: 'result' },
      ],
    },
    moic: {
      title: 'Money multiple (MOIC)',
      formula: 'Net equity proceeds ÷ equity invested',
      steps: [
        { label: 'Equity invested at t=0', value: fmtP(openingEquity, { compact: true }), kind: 'input' },
        { label: 'Net equity proceeds at exit', value: fmtP(equity, { compact: true }), kind: 'derived' },
        { label: 'Money multiple', expr: `${fmtP(equity, { compact: true })} ÷ ${fmtP(openingEquity, { compact: true })}`, value: `${moic.toFixed(2)}×`, kind: 'result' },
      ],
    },
  };

  const cfg = configs[kpiKey];
  if (!cfg) return null;

  return (
    <div onClick={onClose} style={modalBackdrop}>
      <div onClick={(e) => e.stopPropagation()} style={modalCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>
              Deal explainer
            </div>
            <h2 style={{ fontFamily: serifStack, fontSize: 22, fontWeight: 500, color: colors.ink, margin: '4px 0 0' }}>
              {cfg.title}
            </h2>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 28, color: colors.muted, cursor: 'pointer', lineHeight: 1, fontFamily: fontStack }}>×</button>
        </div>

        <div style={{ padding: '8px 12px', background: colors.bgSoft, borderRadius: 6, fontFamily: 'ui-monospace, monospace', fontSize: 12, color: colors.ink, marginTop: 14 }}>
          {cfg.formula}
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: fontStack, marginTop: 14 }}>
          <tbody>
            {cfg.steps.map((s, i) => (
              <tr key={i} style={{
                borderTop: i > 0 ? `1px solid ${colors.borderSoft}` : 'none',
                background: s.kind === 'result' ? '#fef3c7' : (s.kind === 'note' ? '#f8fafc' : '#fff'),
              }}>
                <td style={{ padding: '6px 10px', color: s.kind === 'note' ? colors.muted : colors.ink, fontStyle: s.kind === 'note' ? 'italic' : 'normal' }}>
                  {s.label}
                </td>
                <td style={{ padding: '6px 10px', color: colors.muted, fontFamily: 'ui-monospace, monospace' }}>
                  {s.expr || ''}
                </td>
                <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: 'ui-monospace, monospace', fontWeight: s.kind === 'result' ? 700 : 400 }}>
                  {s.value || ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const modalBackdrop = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: fontStack };
const modalCard = { background: '#fff', borderRadius: 16, padding: 28, maxWidth: 720, width: '100%', maxHeight: '85vh', overflowY: 'auto' };

function FilterBar({ entities, groups, assignments, filter, onFilterChange }) {
  if (!onFilterChange) return null;
  return (
    <LocationFilter entities={entities} groups={groups} assignments={assignments}
      value={filter} onChange={onFilterChange} />
  );
}

function pickExit(outputs) {
  const dealRows = outputs.filter(o => o.module_key === 'exit_valuation' && o.nominal_type !== 'deal.football_field');
  if (dealRows.length === 0) return null;
  const period = dealRows[0].period;
  const m = { _period: period };
  for (const r of dealRows) m[r.nominal_type] = r.amount_p;
  return m;
}

const th = { padding: '10px 12px', fontWeight: 600, color: colors.muted, borderBottom: `1px solid ${colors.border}` };
const td = { padding: '8px 12px', color: colors.ink };
