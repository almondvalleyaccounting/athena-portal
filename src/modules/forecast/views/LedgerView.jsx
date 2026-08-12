// Line-level P&L and Cashflow for the GENERAL CASHFLOW lens.
//
// Two things the summary StatementView cannot do:
//
//  1. Show the SAME lines the user maintains on the Lines tab — "Sales",
//     "Developers", "Accountancy fees" — rather than four category totals.
//  2. Let a number be edited where it is read. Clicking a forecast cell writes
//     a per-month override on that line and recomputes; the cell is then
//     marked, and one click puts it back on the projection.
//
// Actual months sit to the LEFT of the forecast, shaded and labelled, so it is
// never ambiguous which figures are history and which are a projection. The
// P&L can show actuals because the seed stores them per line; the cashflow
// cannot (we import no historic cash movements), so it says so rather than
// showing a plausible-looking blank.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { listPlLines, upsertPlLine } from '../lib/queries';
import { CATEGORIES } from '../lib/modules/pl_lines';
import { colors, fmtP, fontStack, periodLabel, serifStack } from '../components/ui';

const CATEGORY_ORDER = ['income', 'cost_of_sales', 'payroll', 'overheads', 'capex'];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));

/** 'YYYY-MM' → 'Sep 25' */
function monthLabel(key) {
  const [y, m] = String(key).split('-').map(Number);
  if (!y || !m) return String(key);
  return new Date(Date.UTC(y, m - 1, 1))
    .toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

/** First forecast month as 'YYYY-MM', so actuals can be cut off cleanly. */
function openingKey(openingPeriod) {
  const d = openingPeriod ? new Date(openingPeriod) : new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export default function LedgerView({
  forecast, scenario, outputs, periods, variant = 'pnl', onChanged,
}) {
  const [lines, setLines] = useState([]);
  const [showActuals, setShowActuals] = useState(true);
  const [editing, setEditing] = useState(null);      // { lineId, period }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    listPlLines(scenario.id)
      .then(ls => { if (!cancelled) setLines(ls); })
      .catch(e => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [scenario.id, outputs]);

  const isPnl = variant === 'pnl';

  // ── Actual columns (P&L only) ───────────────────────────────────
  const actualMonths = useMemo(() => {
    if (!isPnl) return [];
    const cutoff = openingKey(forecast.opening_period);
    const set = new Set();
    for (const l of lines) for (const m of (l.actuals?.months || [])) {
      if (String(m) < cutoff) set.add(String(m));
    }
    return Array.from(set).sort();
  }, [lines, isPnl, forecast.opening_period]);

  const shownActuals = showActuals ? actualMonths : [];

  // Per line: actual amount by month key.
  const actualByLine = useMemo(() => {
    const map = new Map();
    for (const l of lines) {
      const months = l.actuals?.months || [];
      const amounts = l.actuals?.amounts_p || [];
      const m = {};
      for (let i = 0; i < months.length; i++) m[String(months[i])] = Number(amounts[i]) || 0;
      map.set(l.id, m);
    }
    return map;
  }, [lines]);

  // ── Forecast values from the engine's own output ────────────────
  // Read what the engine produced rather than re-deriving it here: if the two
  // ever disagree, the statement should show the truth, not a second opinion.
  const forecastByLine = useMemo(() => {
    const map = new Map();
    const want = isPnl
      ? new Set(['revenue', 'cost_of_sales', 'staff_cost', 'overhead', 'capex'])
      : new Set(['cf.line']);
    for (const o of outputs) {
      if (!want.has(o.nominal_type)) continue;
      const id = o.tags?.line_id;
      if (!id) continue;
      let byPeriod = map.get(id);
      if (!byPeriod) { byPeriod = {}; map.set(id, byPeriod); }
      byPeriod[o.period] = (byPeriod[o.period] || 0) + Number(o.amount_p || 0);
    }
    return map;
  }, [outputs, isPnl]);

  const summary = useMemo(() => {
    const m = {};
    for (const o of outputs) {
      if (!o.nominal_type.startsWith('pnl.') && !o.nominal_type.startsWith('cf.')) continue;
      if (o.nominal_type === 'cf.line') continue;
      (m[o.nominal_type] ||= {})[o.period] = (m[o.nominal_type]?.[o.period] || 0) + Number(o.amount_p || 0);
    }
    return m;
  }, [outputs]);

  const sumRow = (nominal, t) => summary[nominal]?.[t] ?? 0;

  // ── Editing ─────────────────────────────────────────────────────
  const saveOverride = async (line, period, valuePounds) => {
    setBusy(true); setErr(null);
    try {
      const overrides = { ...(line.overrides || {}) };
      if (valuePounds === null) delete overrides[String(period)];
      else overrides[String(period)] = Math.round(valuePounds * 100);
      await upsertPlLine({ ...line, overrides });
      const fresh = await listPlLines(scenario.id);
      setLines(fresh);
      onChanged?.();
    } catch (e) { setErr(e.message); }
    setBusy(false);
    setEditing(null);
  };

  const categories = CATEGORY_ORDER
    .map(key => ({ key, label: CATEGORY_LABEL[key], rows: lines.filter(l => l.category === key) }))
    .filter(c => c.rows.length > 0);

  const colCount = 1 + shownActuals.length + periods.length + 1;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 10, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ fontFamily: serifStack, fontSize: 22, fontWeight: 500, color: colors.ink, margin: 0 }}>
            {isPnl ? 'Profit & Loss' : 'Cashflow'}
          </h2>
          <p style={{ fontSize: 11, color: colors.muted, margin: '4px 0 0' }}>
            {isPnl
              ? 'Click any forecast figure to override that month. Actual months are shaded and cannot be edited.'
              : `Forecast only — historic cash movements are not imported. The opening bank balance comes from the actual balance sheet before ${periodLabel(0, forecast.opening_period)}.`}
          </p>
        </div>
        {isPnl && actualMonths.length > 0 && (
          <button onClick={() => setShowActuals(s => !s)}
            style={{
              padding: '5px 10px', fontSize: 11, fontFamily: fontStack, cursor: 'pointer',
              border: `1px solid ${colors.border}`, borderRadius: 6,
              background: showActuals ? colors.ink : '#fff',
              color: showActuals ? '#fff' : colors.inkSoft,
            }}>
            {showActuals ? `▾ ${actualMonths.length} actual months shown` : `▸ ${actualMonths.length} actual months hidden`}
          </button>
        )}
      </div>

      {err && (
        <div style={{ padding: 10, background: '#fef2f2', border: `1px solid ${colors.red}`,
          borderRadius: 8, color: colors.red, fontSize: 12, marginBottom: 10 }}>{err}</div>
      )}

      <div style={{ overflowX: 'auto', border: `1px solid ${colors.border}`, borderRadius: 8, background: '#fff' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 11, fontFamily: fontStack, minWidth: '100%' }}>
          <thead>
            {/* Band row — the actuals/forecast boundary, stated once and plainly. */}
            <tr>
              <th style={{ ...thBase, position: 'sticky', left: 0, zIndex: 3, background: '#fff', minWidth: 240 }} />
              {shownActuals.length > 0 && (
                <th colSpan={shownActuals.length} style={{ ...bandTh, background: '#eef2f7', color: colors.inkSoft }}>
                  Actual
                </th>
              )}
              <th colSpan={periods.length} style={{ ...bandTh, background: '#eff6ff', color: colors.accent }}>
                Forecast
              </th>
              <th style={{ ...bandTh, background: '#fff' }} />
            </tr>
            <tr style={{ background: colors.bgSoft }}>
              <th style={{ ...thBase, position: 'sticky', left: 0, zIndex: 3, background: colors.bgSoft, minWidth: 240 }}>
                Line
              </th>
              {shownActuals.map(m => (
                <th key={m} style={{ ...thBase, ...numTh, background: '#f4f6f9' }}>{monthLabel(m)}</th>
              ))}
              {periods.map(t => (
                <th key={t} style={{
                  ...thBase, ...numTh,
                  borderLeft: t === 0 && shownActuals.length ? `2px solid ${colors.accent}` : undefined,
                }}>{periodLabel(t, forecast.opening_period)}</th>
              ))}
              <th style={{ ...thBase, ...numTh, borderLeft: `1px solid ${colors.border}` }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {!isPnl && (
              <SummaryRow label="Opening bank" nominal="cf.opening_cash" bold
                actuals={shownActuals} periods={periods} sumRow={sumRow} noTotal />
            )}

            {categories.map(cat => (
              <React.Fragment key={cat.key}>
                <tr>
                  <td colSpan={colCount} style={sectionTd}>{cat.label}</td>
                </tr>
                {cat.rows.map(line => (
                  <LineRow
                    key={line.id}
                    line={line}
                    actuals={shownActuals}
                    actualValues={actualByLine.get(line.id) || {}}
                    periods={periods}
                    values={forecastByLine.get(line.id) || {}}
                    isPnl={isPnl}
                    editing={editing && editing.lineId === line.id ? editing.period : null}
                    onStartEdit={(t) => setEditing({ lineId: line.id, period: t })}
                    onCancel={() => setEditing(null)}
                    onSave={(t, v) => saveOverride(line, t, v)}
                    busy={busy}
                  />
                ))}
                <SubtotalRow
                  label={`Total ${cat.label.toLowerCase()}`}
                  rows={cat.rows}
                  actuals={shownActuals}
                  actualByLine={actualByLine}
                  periods={periods}
                  forecastByLine={forecastByLine}
                />
              </React.Fragment>
            ))}

            {isPnl ? (
              <>
                <SummaryRow label="Gross profit" nominal="pnl.gross_profit" bold {...{ actuals: shownActuals, periods, sumRow }} />
                <SummaryRow label="EBITDA" nominal="pnl.ebitda" bold {...{ actuals: shownActuals, periods, sumRow }} />
                <SummaryRow label="Interest" nominal="pnl.interest_total" {...{ actuals: shownActuals, periods, sumRow }} />
                <SummaryRow label="Profit before tax" nominal="pnl.pbt" bold {...{ actuals: shownActuals, periods, sumRow }} />
                <SummaryRow label="Company tax" nominal="pnl.tax_total" {...{ actuals: shownActuals, periods, sumRow }} />
                <SummaryRow label="Profit after tax" nominal="pnl.npat" bold {...{ actuals: shownActuals, periods, sumRow }} />
                <SummaryRow label="Dividends / drawings" nominal="pnl.dividends" {...{ actuals: shownActuals, periods, sumRow }} />
              </>
            ) : (
              <>
                <tr><td colSpan={colCount} style={sectionTd}>Tax &amp; financing</td></tr>
                <SummaryRow label="VAT paid" nominal="cf.out.vat" {...{ actuals: shownActuals, periods, sumRow }} />
                <SummaryRow label="VAT refunds" nominal="cf.in.vat_refund" {...{ actuals: shownActuals, periods, sumRow }} />
                <SummaryRow label="Company tax paid" nominal="cf.out.corp_tax" {...{ actuals: shownActuals, periods, sumRow }} />
                <SummaryRow label="Loan drawdown" nominal="cf.in.debt_drawdown" {...{ actuals: shownActuals, periods, sumRow }} />
                <SummaryRow label="Loan interest" nominal="cf.out.interest" {...{ actuals: shownActuals, periods, sumRow }} />
                <SummaryRow label="Loan repayments" nominal="cf.out.debt_principal" {...{ actuals: shownActuals, periods, sumRow }} />
                <SummaryRow label="Dividends / drawings" nominal="cf.out.dividends" {...{ actuals: shownActuals, periods, sumRow }} />
                <SummaryRow label="Net cash movement" nominal="cf.net_movement" bold {...{ actuals: shownActuals, periods, sumRow }} />
                <SummaryRow label="Closing bank" nominal="cf.closing_cash" bold highlight
                  {...{ actuals: shownActuals, periods, sumRow }} noTotal />
              </>
            )}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: colors.muted, marginTop: 8 }}>
        {isPnl
          ? 'Overridden months show a dot; click the dot to put the month back on its projection.'
          : 'Each line is the cash effect of the matching P&L line after its payment lag — receipts include VAT, and payroll splits into net pay and PAYE.'}
      </p>
    </div>
  );
}

/* ── Rows ───────────────────────────────────────────────────────── */

function LineRow({ line, actuals, actualValues, periods, values, isPnl, editing, onStartEdit, onCancel, onSave, busy }) {
  const overrides = line.overrides || {};
  const inactive = line.is_active === false;
  const total = periods.reduce((s, t) => s + (values[t] || 0), 0);

  return (
    <tr style={{ opacity: inactive ? 0.45 : 1 }}>
      <td style={{ ...tdBase, position: 'sticky', left: 0, zIndex: 2, background: '#fff', paddingLeft: 20 }}>
        {line.label}
        {inactive && <span style={{ color: colors.amber, marginLeft: 6, fontSize: 10 }}>excluded</span>}
      </td>
      {actuals.map(m => (
        <td key={m} style={{ ...tdBase, ...numTd, background: '#f8fafc', color: colors.inkSoft }}>
          {actualValues[m] != null ? fmtP(actualValues[m]) : ''}
        </td>
      ))}
      {periods.map(t => {
        const overridden = overrides[String(t)] != null;
        const value = values[t] || 0;
        if (editing === t) {
          return (
            <td key={t} style={{ ...tdBase, ...numTd, padding: 0 }}>
              <CellEditor
                initial={(overridden ? Number(overrides[String(t)]) : value) / 100}
                onCancel={onCancel}
                onCommit={(v) => onSave(t, v)}
              />
            </td>
          );
        }
        return (
          <td key={t}
            onClick={() => !busy && !inactive && onStartEdit(t)}
            title={inactive ? 'This line is excluded' : 'Click to set this month'}
            style={{
              ...tdBase, ...numTd, cursor: inactive ? 'default' : 'text',
              borderLeft: t === 0 && actuals.length ? `2px solid ${colors.accent}` : undefined,
              background: overridden ? '#eff6ff' : undefined,
              fontWeight: overridden ? 600 : 400,
            }}>
            {fmtP(value)}
            {overridden && (
              <span
                onClick={(e) => { e.stopPropagation(); onSave(t, null); }}
                title="Put this month back on its projection"
                style={{
                  display: 'inline-block', width: 6, height: 6, borderRadius: 3,
                  background: colors.accent, marginLeft: 5, verticalAlign: 'middle', cursor: 'pointer',
                }} />
            )}
          </td>
        );
      })}
      <td style={{ ...tdBase, ...numTd, borderLeft: `1px solid ${colors.border}`, fontWeight: 600 }}>
        {fmtP(total)}
      </td>
    </tr>
  );
}

function SubtotalRow({ label, rows, actuals, actualByLine, periods, forecastByLine }) {
  const actualTotal = (m) => rows.reduce((s, l) => s + ((actualByLine.get(l.id) || {})[m] || 0), 0);
  const fcTotal = (t) => rows.reduce((s, l) => s + ((forecastByLine.get(l.id) || {})[t] || 0), 0);
  const total = periods.reduce((s, t) => s + fcTotal(t), 0);
  return (
    <tr style={{ background: '#fbfcfd' }}>
      <td style={{ ...tdBase, position: 'sticky', left: 0, zIndex: 2, background: '#fbfcfd', fontWeight: 600 }}>
        {label}
      </td>
      {actuals.map(m => (
        <td key={m} style={{ ...tdBase, ...numTd, background: '#f1f5f9', fontWeight: 600, color: colors.inkSoft }}>
          {fmtP(actualTotal(m))}
        </td>
      ))}
      {periods.map(t => (
        <td key={t} style={{
          ...tdBase, ...numTd, fontWeight: 600,
          borderLeft: t === 0 && actuals.length ? `2px solid ${colors.accent}` : undefined,
        }}>{fmtP(fcTotal(t))}</td>
      ))}
      <td style={{ ...tdBase, ...numTd, borderLeft: `1px solid ${colors.border}`, fontWeight: 700 }}>{fmtP(total)}</td>
    </tr>
  );
}

function SummaryRow({ label, nominal, actuals, periods, sumRow, bold, highlight, noTotal }) {
  const total = periods.reduce((s, t) => s + sumRow(nominal, t), 0);
  return (
    <tr style={{ background: highlight ? '#f0f9ff' : undefined }}>
      <td style={{
        ...tdBase, position: 'sticky', left: 0, zIndex: 2,
        background: highlight ? '#f0f9ff' : '#fff', fontWeight: bold ? 700 : 400,
      }}>{label}</td>
      {actuals.map(m => (
        <td key={m} style={{ ...tdBase, ...numTd, background: '#f8fafc', color: colors.muted }}>—</td>
      ))}
      {periods.map(t => {
        const v = sumRow(nominal, t);
        return (
          <td key={t} style={{
            ...tdBase, ...numTd, fontWeight: bold ? 700 : 400,
            color: v < 0 ? colors.red : colors.ink,
            borderLeft: t === 0 && actuals.length ? `2px solid ${colors.accent}` : undefined,
          }}>{fmtP(v)}</td>
        );
      })}
      <td style={{ ...tdBase, ...numTd, borderLeft: `1px solid ${colors.border}`, fontWeight: 700 }}>
        {noTotal ? '' : fmtP(total)}
      </td>
    </tr>
  );
}

/** In-place editor: Enter commits, Escape abandons, blur commits. */
function CellEditor({ initial, onCommit, onCancel }) {
  const [value, setValue] = useState(String(Math.round(initial * 100) / 100));
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const commit = () => {
    const n = Number(value);
    if (isNaN(n)) { onCancel(); return; }
    onCommit(n);
  };
  return (
    <input
      ref={ref}
      value={value}
      onChange={e => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      }}
      inputMode="decimal"
      style={{
        width: '100%', boxSizing: 'border-box', padding: '4px 6px', textAlign: 'right',
        border: `2px solid ${colors.accent}`, borderRadius: 4, outline: 'none',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11,
      }}
    />
  );
}

/* ── Cell styles ────────────────────────────────────────────────── */

const thBase = {
  padding: '7px 10px', fontSize: 10, fontWeight: 700, color: colors.muted,
  borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap', textAlign: 'left',
};
const bandTh = {
  padding: '4px 10px', fontSize: 10, fontWeight: 700, textAlign: 'center',
  textTransform: 'uppercase', letterSpacing: 0.6, borderBottom: `1px solid ${colors.border}`,
};
const numTh = { textAlign: 'right', minWidth: 84 };
const tdBase = {
  padding: '4px 10px', borderBottom: `1px solid ${colors.borderSoft}`, whiteSpace: 'nowrap',
};
const numTd = {
  textAlign: 'right',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};
const sectionTd = {
  padding: '6px 10px', background: '#0f172a', color: '#e2e8f0', fontSize: 10,
  fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
};
