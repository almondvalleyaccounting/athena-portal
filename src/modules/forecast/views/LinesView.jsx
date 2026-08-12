// Lines & assumptions — the input surface for the GENERAL CASHFLOW lens.
//
// Three blocks:
//   1. Seed from QuickBooks — pick the client's QBO file and a window of
//      actuals; every nominal account becomes an editable line.
//   2. Assumptions — the handful of scalar drivers general_core reads
//      (opening bank, debtor/creditor days, PAYE split, VAT, CT, dividends).
//   3. The lines themselves, grouped by generic category, each with its own
//      projection method and % / £ adjustment.
//
// Edits save on blur and trigger a recompute, matching the childcare inputs.

import React, { useEffect, useMemo, useState } from 'react';
import {
  listPlLines, upsertPlLine, deletePlLine, applyQboSeed,
  loadScenarioDrivers, setDriverValue, seedPackDefaults,
} from '../lib/queries';
import { seedLinesFromQbo, listQboConnections, qboConnectionForEntity } from '../lib/qboSeed';
import { modulesFor } from '../lib/packs';
import { CATEGORIES, amountForPeriod } from '../lib/modules/pl_lines';
import { currencySymbol } from '../lib/currency';
import {
  btnDark, btnGhost, btnOutline, colors, fmtP, fontStack, inputStyle, periodLabel,
  selectStyle, Section, Pill, serifStack,
} from '../components/ui';

const METHODS = [
  { key: 'average', label: 'Average of window' },
  { key: 'last',    label: 'Last month' },
  { key: 'shape',   label: 'Repeat monthly shape' },
  { key: 'manual',  label: 'Manual amount' },
  { key: 'zero',    label: 'Stop (zero)' },
];

const VAT_TREATMENTS = [
  { key: 'standard', label: 'Standard' },
  { key: 'zero',     label: 'Zero-rated' },
  { key: 'exempt',   label: 'Exempt' },
  { key: 'outside',  label: 'Outside scope' },
];

// Assumption drivers, grouped for display. Keys match general_core.
const ASSUMPTION_GROUPS = [
  {
    title: 'Opening position',
    keys: ['cash.opening_balance_p', 'bs.opening_debtors_p', 'bs.opening_creditors_p',
           'bs.opening_fixed_assets_p', 'bs.opening_other_liabilities_p'],
  },
  {
    title: 'Working capital',
    keys: ['wc.debtor_days', 'wc.creditor_days', 'payroll.paye_share_pct'],
  },
  {
    title: 'VAT / sales tax',
    keys: ['vat.registered', 'vat.rate_pct', 'vat.flat_rate_pct', 'vat.stagger',
           'vat.payment_lag_months', 'vat.opening_liability_p', 'vat.opening_due_month'],
  },
  {
    title: 'Company tax',
    keys: ['tax.ct_rate_pct', 'tax.year_end_month', 'tax.payment_pattern',
           'tax.ct_payment_lag_months', 'tax.ct_opening_liability_p', 'tax.ct_opening_due_month'],
  },
  {
    title: 'Distributions',
    keys: ['div.monthly_p'],
  },
];

const formatDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

// Local date → YYYY-MM-DD. NOT toISOString(): that converts local midnight to
// UTC, so through BST "1 Feb" came back as "31 Jan" and every seed window
// started a day early.
const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const monthsAgoISO = (n) => {
  const d = new Date();
  d.setMonth(d.getMonth() - n, 1);
  return isoDate(d);
};
const endOfLastMonthISO = () => {
  const d = new Date();
  d.setDate(0);            // day 0 of this month = last day of the previous one
  return isoDate(d);
};

const WINDOW_PRESETS = [6, 12, 24];

const CADENCES = [
  { key: 'monthly',   label: 'Every month' },
  { key: 'quarterly', label: 'Every 3 months' },
  { key: 'annual',    label: 'Once a year' },
];

/** Has this line been moved off plain "settle on the default terms"? */
function hasCustomTiming(line) {
  return line.cash_lag_days != null
    || (line.pay_cadence && line.pay_cadence !== 'monthly')
    || line.collect_cap_p != null
    || line.collect_pct != null
    || line.arrears_settle_month != null;
}

/** Short human description of a line's cash timing, for the grid cell. */
function timingSummary(line, openingPeriod, { long = false } = {}) {
  if (line.category === 'payroll') return long ? 'Payroll follows the wages / PAYE split in Assumptions' : 'wages + PAYE';
  const bits = [];
  if (line.cash_lag_days != null) bits.push(`${line.cash_lag_days}d`);
  if (line.pay_cadence === 'quarterly') bits.push('quarterly');
  if (line.pay_cadence === 'annual') bits.push('yearly');
  if (line.collect_cap_p != null) bits.push(`≤ ${fmtP(line.collect_cap_p)}/mo`);
  else if (line.collect_pct != null) bits.push(`${line.collect_pct}% a month`);
  if (line.arrears_settle_month != null) {
    bits.push(`→ ${periodLabel(Number(line.arrears_settle_month), openingPeriod)}`);
  }
  if (bits.length === 0) return long ? 'Settles on the default terms' : 'default';
  return bits.join(' · ');
}

export default function LinesView({ forecast, scenario, onChanged }) {
  const [lines, setLines] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [values, setValues] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);

  // Seed controls
  const [timingLine, setTimingLine] = useState(null);

  const [conns, setConns] = useState([]);
  const [realmId, setRealmId] = useState('');
  const [seedStart, setSeedStart] = useState(monthsAgoISO(12));
  const [seedEnd, setSeedEnd] = useState(endOfLastMonthISO());
  const [seedMethod, setSeedMethod] = useState('average');
  const [lastPull, setLastPull] = useState(null);

  const reload = async () => {
    const [ls, dv] = await Promise.all([
      listPlLines(scenario.id),
      loadScenarioDrivers(scenario.id),
    ]);
    setLines(ls);
    setDrivers(dv.drivers.filter(d => d.module_key === 'general_core'));
    setValues(dv.values);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setErr(null);
      try {
        let dv = await loadScenarioDrivers(scenario.id);
        // Seed the assumption drivers on first visit — and again whenever the
        // module spec has gained one. Driver rows carry their own label, so a
        // scenario created before a driver existed would never see it, and
        // relabelled drivers would keep the old wording forever. seedPackDefaults
        // upserts the rows and only fills values that are missing, so existing
        // answers are safe.
        const mods = modulesFor(forecast.vertical_pack);
        const specKeys = mods.flatMap(m => (m.drivers || []).map(d => d.key));
        const haveKeys = new Set(dv.drivers.map(d => d.driver_key));
        if (specKeys.some(k => !haveKeys.has(k))) {
          await seedPackDefaults({
            scenario_id: scenario.id,
            modules: mods,
            entities: [],
            vertical_pack: forecast.vertical_pack,
          });
          dv = await loadScenarioDrivers(scenario.id);
        }
        const ls = await listPlLines(scenario.id);
        if (cancelled) return;
        setLines(ls);
        setDrivers(dv.drivers.filter(d => d.module_key === 'general_core'));
        setValues(dv.values);

        const [all, own] = await Promise.all([
          listQboConnections(),
          qboConnectionForEntity(forecast.client_entity_id),
        ]);
        if (cancelled) return;
        setConns(all);
        // ONLY auto-select the file linked to this forecast's client. Never
        // guess by name: companies in the same group have near-identical names
        // ("Foursite Inc" and "Foursite Inc Ltd" are different businesses), and
        // silently seeding from the wrong set of books is unrecoverable trust
        // damage. No link ⇒ the user picks.
        setRealmId(own?.realm_id || '');
      } catch (e) {
        if (!cancelled) setErr(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [scenario.id, forecast.vertical_pack, forecast.client_entity_id, forecast.client_name]);

  // ── Driver helpers ──────────────────────────────────────────────
  const valueByDriverId = useMemo(() => {
    const m = new Map();
    for (const v of values) if (v.period === -1) m.set(v.driver_id, v.value);
    return m;
  }, [values]);

  const driverByKey = useMemo(
    () => new Map(drivers.map(d => [d.driver_key, d])), [drivers]);

  const saveDriver = async (key, raw) => {
    const d = driverByKey.get(key);
    if (!d) return;
    setBusy(true); setErr(null);
    try {
      await setDriverValue(d.id, -1, Number(raw) || 0);
      await reload();
      onChanged?.();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  // ── Line helpers ────────────────────────────────────────────────
  const saveLine = async (line, patch) => {
    setBusy(true); setErr(null);
    try {
      await upsertPlLine({ ...line, ...patch });
      await reload();
      onChanged?.();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const addLine = async (category) => {
    setBusy(true); setErr(null);
    try {
      await upsertPlLine({
        scenario_id: scenario.id, category, label: 'New line',
        method: 'manual', base_amount_p: 0,
        vat_treatment: category === 'payroll' ? 'outside' : 'standard',
        sort_order: 1000,
      });
      await reload();
      onChanged?.();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const removeLine = async (line) => {
    if (!window.confirm(`Delete "${line.label}"?`)) return;
    setBusy(true); setErr(null);
    try {
      await deletePlLine(line.id);
      await reload();
      onChanged?.();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  // ── Seeding ─────────────────────────────────────────────────────
  const runSeed = async () => {
    if (!realmId) { setErr('Pick a QuickBooks file first.'); return; }
    setBusy(true); setErr(null); setNote(null);
    try {
      const res = await seedLinesFromQbo({
        realmId, start: seedStart, end: seedEnd, defaultMethod: seedMethod,
        openingPeriod: forecast.opening_period,
      });
      const applied = await applyQboSeed(scenario.id, res.lines);
      setLastPull(res);
      setNote(`Seeded ${res.lines.length} account(s) over ${res.months.length} month(s) — ${applied.inserted} new, ${applied.updated} refreshed${applied.zeroed ? `, ${applied.zeroed} with no activity zeroed` : ''}.`);
      await reload();
      onChanged?.();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  // The forecast should start where the real accounts finished: month 0's
  // opening balances come from the balance sheet at the end of the last
  // ACTUAL month, not from an arbitrary date.
  const useOpeningPosition = async () => {
    const op = lastPull?.opening;
    if (!op) return;
    setBusy(true); setErr(null);
    try {
      const pairs = [
        ['cash.opening_balance_p', op.cash_p],
        ['bs.opening_debtors_p', op.debtors_p],
        ['bs.opening_creditors_p', op.creditors_p],
        ['bs.opening_fixed_assets_p', op.fixed_assets_p],
        ['bs.opening_other_liabilities_p', op.other_liabilities_p],
      ].filter(([, v]) => v != null);
      for (const [key, value] of pairs) {
        const d = driverByKey.get(key);
        if (d) await setDriverValue(d.id, -1, value);
      }
      await reload();
      onChanged?.();
      const warn = (op.warnings || []).length ? ` ${op.warnings.join(' ')}` : '';
      setNote(`Opening position set from the balance sheet at ${formatDate(op.as_at)} — bank ${fmtP(op.cash_p)}, debtors ${fmtP(op.debtors_p)}, creditors ${fmtP(op.creditors_p)}.${warn}`);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  // ── Projection preview ──────────────────────────────────────────
  const horizon = forecast.horizon_months || 24;
  const year1 = useMemo(() => {
    const cache = new Map();
    const totals = {};
    for (const line of lines) {
      if (line.is_active === false) continue;
      let sum = 0;
      for (let t = 0; t < Math.min(12, horizon); t++) {
        sum += amountForPeriod(line, t, forecast.opening_period, cache);
      }
      totals[line.id] = sum;
    }
    return totals;
  }, [lines, horizon, forecast.opening_period]);

  const sym = currencySymbol(forecast.currency);

  const categoryTotal = (cat) => lines
    .filter(l => l.category === cat && l.is_active !== false)
    .reduce((s, l) => s + (year1[l.id] || 0), 0);

  return (
    <div>
      {timingLine && (
        <TimingModal
          line={timingLine}
          forecast={forecast}
          busy={busy}
          onClose={() => setTimingLine(null)}
          onSave={async (patch) => { await saveLine(timingLine, patch); setTimingLine(null); }}
        />
      )}
      {err && (
        <div style={{ padding: 12, background: '#fef2f2', border: `1px solid ${colors.red}`,
          borderRadius: 8, color: colors.red, fontSize: 13, marginBottom: 16 }}>{err}</div>
      )}
      {note && (
        <div style={{ padding: 12, background: '#f0fdf4', border: `1px solid ${colors.green}`,
          borderRadius: 8, color: colors.green, fontSize: 13, marginBottom: 16 }}>{note}</div>
      )}

      {/* ── 1. Seed ─────────────────────────────────────────────── */}
      <Section title="Seed from QuickBooks">
        <div style={{ background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 12, padding: 16 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="QuickBooks file">
              <select value={realmId} onChange={e => setRealmId(e.target.value)} style={selectStyle}>
                <option value="">— pick a file —</option>
                {conns.map(c => (
                  <option key={c.realm_id} value={c.realm_id}>{c.company_name}</option>
                ))}
              </select>
              {!realmId && (
                <div style={{ fontSize: 11, color: colors.amber, marginTop: 4, maxWidth: 260 }}>
                  {forecast.client_name || 'This client'} has no QuickBooks file linked — choose the right
                  company yourself.
                </div>
              )}
            </Field>
            <Field label="Window">
              <div style={{ display: 'flex', gap: 4 }}>
                {WINDOW_PRESETS.map(n => {
                  const active = seedStart === monthsAgoISO(n) && seedEnd === endOfLastMonthISO();
                  return (
                    <button key={n} disabled={busy}
                      onClick={() => { setSeedStart(monthsAgoISO(n)); setSeedEnd(endOfLastMonthISO()); }}
                      style={{
                        padding: '7px 12px', fontSize: 12, fontFamily: fontStack, cursor: 'pointer',
                        borderRadius: 6, border: `1px solid ${active ? colors.ink : colors.border}`,
                        background: active ? colors.ink : '#fff',
                        color: active ? '#fff' : colors.inkSoft, fontWeight: active ? 600 : 400,
                      }}>{n}m</button>
                  );
                })}
              </div>
            </Field>
            <Field label="From">
              <input type="date" value={seedStart} onChange={e => setSeedStart(e.target.value)}
                style={{ ...inputStyle, width: 150 }} />
            </Field>
            <Field label="To">
              <input type="date" value={seedEnd} onChange={e => setSeedEnd(e.target.value)}
                style={{ ...inputStyle, width: 150 }} />
            </Field>
            <Field label="Default basis">
              <select value={seedMethod} onChange={e => setSeedMethod(e.target.value)} style={{ ...selectStyle, minWidth: 180 }}>
                {METHODS.filter(m => ['average', 'last', 'shape'].includes(m.key))
                  .map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
              </select>
            </Field>
            <button onClick={runSeed} disabled={busy} style={btnDark}>
              {busy ? 'Pulling…' : 'Pull from QuickBooks'}
            </button>
          </div>
          <p style={{ fontSize: 12, color: colors.muted, margin: '10px 0 0' }}>
            Every nominal account with activity becomes a line. Re-seeding refreshes the actuals and the
            basis but keeps your renames, categories and adjustments; hand-added lines are never touched.
          </p>
          {lastPull?.opening && (
            <div style={{ marginTop: 10 }}>
              <button style={btnOutline} onClick={useOpeningPosition} disabled={busy}>
                Start from the actuals at {formatDate(lastPull.opening.as_at)} — bank {fmtP(lastPull.opening.cash_p)},
                debtors {fmtP(lastPull.opening.debtors_p)}, creditors {fmtP(lastPull.opening.creditors_p)}
              </button>
              {(lastPull.opening.warnings || []).map((w, i) => (
                <div key={i} style={{ fontSize: 11, color: colors.amber, marginTop: 6, maxWidth: 720 }}>{w}</div>
              ))}
            </div>
          )}
        </div>
      </Section>

      {/* ── 2. Assumptions ──────────────────────────────────────── */}
      <Section title="Assumptions">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
          {ASSUMPTION_GROUPS.map(g => (
            <div key={g.title} style={{ background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 12, padding: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: colors.inkSoft, marginBottom: 10,
                textTransform: 'uppercase', letterSpacing: 0.4 }}>{g.title}</div>
              {g.keys.map(key => {
                const d = driverByKey.get(key);
                if (!d) return null;
                return (
                  <DriverRow key={key} driver={d}
                    value={valueByDriverId.get(d.id)}
                    onSave={(v) => saveDriver(key, v)} disabled={busy} />
                );
              })}
            </div>
          ))}
        </div>
      </Section>

      {/* ── 3. Lines ────────────────────────────────────────────── */}
      {CATEGORIES.map(cat => {
        const rows = lines.filter(l => l.category === cat.key);
        return (
          <Section key={cat.key}
            title={cat.label}
            right={
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Pill>{`Year 1: ${fmtP(categoryTotal(cat.key))}`}</Pill>
                <button style={btnGhost} onClick={() => addLine(cat.key)} disabled={busy}>+ Add line</button>
              </div>
            }>
            {rows.length === 0 ? (
              <div style={{ fontSize: 13, color: colors.muted, padding: '8px 0' }}>
                No {cat.label.toLowerCase()} lines yet.
              </div>
            ) : (
              <div style={{ overflowX: 'auto', background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 12 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: colors.bgSoft }}>
                      <Th style={{ minWidth: 200 }}>Line</Th>
                      <Th>Actuals</Th>
                      <Th>Basis</Th>
                      <Th align="right">{`Monthly ${sym}`}</Th>
                      <Th align="right">Uplift %</Th>
                      <Th align="right">{`± ${sym}/mo`}</Th>
                      <Th align="right">Growth %/yr</Th>
                      <Th>VAT</Th>
                      <Th>Cash timing</Th>
                      <Th align="right">Year 1</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(line => (
                      <LineRow key={line.id} line={line} year1={year1[line.id] || 0}
                        openingPeriod={forecast.opening_period}
                        onSave={(patch) => saveLine(line, patch)}
                        onEditTiming={() => setTimingLine(line)}
                        onDelete={() => removeLine(line)} disabled={busy} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        );
      })}
    </div>
  );
}

/**
 * Cash timing for one line: when the money moves, how often, and how much of
 * it. Kept in a dialog rather than four more grid columns — most lines never
 * need it, and the ones that do deserve the room to explain themselves.
 */
function TimingModal({ line, forecast, onClose, onSave, busy }) {
  const horizon = forecast.horizon_months || 24;
  const [form, setForm] = useState({
    cash_lag_days: line.cash_lag_days == null ? '' : String(line.cash_lag_days),
    pay_cadence: line.pay_cadence || 'monthly',
    cadence_offset: String(line.cadence_offset ?? 0),
    collect_cap_p: line.collect_cap_p == null ? '' : String(Number(line.collect_cap_p) / 100),
    collect_pct: line.collect_pct == null ? '' : String(line.collect_pct),
    arrears_settle_month: line.arrears_settle_month == null ? '' : String(line.arrears_settle_month),
  });
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  const capSet = form.collect_cap_p !== '' && Number(form.collect_cap_p) > 0;
  const months = Array.from({ length: horizon }, (_, t) => t);
  const cycle = form.pay_cadence === 'annual' ? 12 : 3;

  const submit = () => {
    const num = (v) => (v === '' ? null : Number(v));
    onSave({
      cash_lag_days: num(form.cash_lag_days),
      pay_cadence: form.pay_cadence,
      cadence_offset: Number(form.cadence_offset) || 0,
      collect_cap_p: form.collect_cap_p === '' ? null : Math.round(Number(form.collect_cap_p) * 100),
      // A cap wins, so don't store a percentage that could never apply.
      collect_pct: capSet ? null : num(form.collect_pct),
      arrears_settle_month: num(form.arrears_settle_month),
    });
  };

  const isIncome = line.category === 'income';
  const party = isIncome ? 'customer' : 'supplier';

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 60,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#fff', borderRadius: 14, padding: 22, width: 520, maxWidth: '100%',
        maxHeight: '90vh', overflowY: 'auto', fontFamily: fontStack,
      }}>
        <h2 style={{ fontFamily: serifStack, fontSize: 20, fontWeight: 500, color: colors.ink, margin: '0 0 4px' }}>
          Cash timing
        </h2>
        <p style={{ fontSize: 12, color: colors.muted, margin: '0 0 18px' }}>
          {line.label} — when the cash moves. The P&amp;L is unaffected: this changes
          payment, not the invoice.
        </p>

        {line.category === 'payroll' ? (
          <p style={{ fontSize: 13, color: colors.inkSoft, background: colors.bgSoft, padding: 12, borderRadius: 8 }}>
            Payroll cash follows the wages / PAYE split set in Assumptions — net pay in the
            month, PAYE and NI a month behind. Nothing to set per line.
          </p>
        ) : (
          <>
            <Labelled label="Payment terms"
              hint={`Days before the ${party} settles. Blank uses the ${isIncome ? 'debtor' : 'creditor'} days in Assumptions.`}>
              <input value={form.cash_lag_days} onChange={set('cash_lag_days')} placeholder="default"
                inputMode="decimal" style={{ ...inputStyle, width: 120 }} />
            </Labelled>

            <Labelled label="Pays" hint={`How often the money actually moves. The cost or sale still lands every month.`}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={form.pay_cadence} onChange={set('pay_cadence')} style={{ ...selectStyle, minWidth: 150 }}>
                  {CADENCES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
                {form.pay_cadence !== 'monthly' && (
                  <>
                    <span style={{ fontSize: 12, color: colors.muted }}>first in</span>
                    <select value={form.cadence_offset} onChange={set('cadence_offset')} style={{ ...selectStyle, minWidth: 120 }}>
                      {Array.from({ length: cycle }, (_, i) => (
                        <option key={i} value={i}>{periodLabel(i, forecast.opening_period)}</option>
                      ))}
                    </select>
                  </>
                )}
              </div>
            </Labelled>

            <div style={{ borderTop: `1px solid ${colors.border}`, margin: '18px 0 14px' }} />
            <div style={{ fontSize: 12, fontWeight: 700, color: colors.inkSoft, marginBottom: 10,
              textTransform: 'uppercase', letterSpacing: 0.4 }}>
              Part payment
            </div>

            <Labelled label="Most per month"
              hint={`The ${party} settles at most this much a month; the rest builds up.`}>
              <input value={form.collect_cap_p} onChange={set('collect_cap_p')} placeholder="no limit"
                inputMode="decimal" style={{ ...inputStyle, width: 140 }} />
            </Labelled>

            <Labelled label="or share per month"
              hint={capSet ? 'Ignored while a monthly limit is set.' : 'Share of each invoice settled on time, e.g. 70.'}>
              <input value={form.collect_pct} onChange={set('collect_pct')} placeholder="100"
                disabled={capSet} inputMode="decimal"
                style={{ ...inputStyle, width: 100, background: capSet ? colors.bgSoft : '#fff' }} />
            </Labelled>

            <Labelled label="Balance settles"
              hint="Everything outstanding arrives in this month, and the line settles in full from then on.">
              <select value={form.arrears_settle_month} onChange={set('arrears_settle_month')}
                style={{ ...selectStyle, minWidth: 190 }}>
                <option value="">keep building</option>
                {months.map(t => (
                  <option key={t} value={t}>{periodLabel(t, forecast.opening_period)}</option>
                ))}
              </select>
            </Labelled>
          </>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
          <button onClick={onClose} style={{ ...btnOutline, flex: 1, justifyContent: 'center' }}>Cancel</button>
          {line.category !== 'payroll' && (
            <button onClick={submit} disabled={busy} style={{ ...btnDark, flex: 1, justifyContent: 'center' }}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Labelled({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: colors.ink, marginBottom: 4 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: colors.muted, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

/* ── Small pieces ───────────────────────────────────────────────── */

function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: colors.muted, marginBottom: 4, fontWeight: 600 }}>{label}</div>
      {children}
    </div>
  );
}

function Th({ children, align = 'left', style }) {
  return (
    <th style={{ textAlign: align, padding: '8px 10px', fontSize: 11, fontWeight: 700,
      color: colors.muted, borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap', ...style }}>
      {children}
    </th>
  );
}

function Td({ children, align = 'left', style }) {
  return (
    <td style={{ textAlign: align, padding: '5px 10px', borderBottom: `1px solid ${colors.borderSoft}`, ...style }}>
      {children}
    </td>
  );
}

/** One assumption driver — unit decides how it is shown and stored. */
function DriverRow({ driver, value, onSave, disabled }) {
  const isMoney = driver.unit === 'gbp_p';
  const isFlag = driver.unit === 'flag';
  const display = value == null ? '' : (isMoney ? Number(value) / 100 : Number(value));
  const [local, setLocal] = useState(String(display ?? ''));

  useEffect(() => { setLocal(String(display ?? '')); }, [String(display)]);

  const commit = () => {
    if (String(local) === String(display ?? '')) return;
    const n = Number(local);
    if (isNaN(n)) { setLocal(String(display ?? '')); return; }
    onSave(isMoney ? Math.round(n * 100) : n);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <div style={{ flex: 1, fontSize: 12, color: colors.inkSoft, lineHeight: 1.3 }}>{driver.label}</div>
      {isFlag ? (
        <select value={String(display ?? '0')} onChange={e => onSave(Number(e.target.value))}
          disabled={disabled} style={{ ...inputStyle, width: 80 }}>
          <option value="1">Yes</option>
          <option value="0">No</option>
        </select>
      ) : (
        <input value={local} onChange={e => setLocal(e.target.value)} onBlur={commit}
          disabled={disabled} inputMode="decimal"
          style={{ ...inputStyle, width: 90, textAlign: 'right' }} />
      )}
    </div>
  );
}

function LineRow({ line, year1, openingPeriod, onSave, onEditTiming, onDelete, disabled }) {
  const actuals = line.actuals?.amounts_p || [];
  const seedMonths = line.actuals?.months || [];
  const inactive = line.is_active === false;

  return (
    <tr style={{ opacity: inactive ? 0.45 : 1 }}>
      <Td>
        <TextCell value={line.label} onSave={v => onSave({ label: v })} disabled={disabled} />
        {line.notes && (
          <div style={{ fontSize: 10, color: colors.amber, marginTop: 2 }}>{line.notes}</div>
        )}
      </Td>
      <Td>
        {actuals.length > 0 ? (
          <span title={`${seedMonths[0]} → ${seedMonths[seedMonths.length - 1]}`} style={{ color: colors.muted }}>
            <Sparkline values={actuals} /> {seedMonths.length}m
          </span>
        ) : (
          <span style={{ color: colors.muted }}>—</span>
        )}
      </Td>
      <Td>
        <select value={line.method} onChange={e => onSave({ method: e.target.value })}
          disabled={disabled} style={{ ...inputStyle, width: 150 }}>
          {METHODS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      </Td>
      <Td align="right">
        <NumCell value={Number(line.base_amount_p) / 100} onSave={v => onSave({ base_amount_p: Math.round(v * 100) })}
          disabled={disabled || line.method === 'shape' || line.method === 'zero'} />
      </Td>
      <Td align="right">
        <NumCell value={Number(line.uplift_pct)} onSave={v => onSave({ uplift_pct: v })} disabled={disabled} width={60} />
      </Td>
      <Td align="right">
        <NumCell value={Number(line.delta_p) / 100} onSave={v => onSave({ delta_p: Math.round(v * 100) })} disabled={disabled} width={80} />
      </Td>
      <Td align="right">
        <NumCell value={Number(line.growth_pct_pa)} onSave={v => onSave({ growth_pct_pa: v })} disabled={disabled} width={60} />
      </Td>
      <Td>
        <select value={line.vat_treatment} onChange={e => onSave({ vat_treatment: e.target.value })}
          disabled={disabled} style={{ ...inputStyle, width: 110 }}>
          {VAT_TREATMENTS.map(v => <option key={v.key} value={v.key}>{v.label}</option>)}
        </select>
      </Td>
      <Td>
        <button onClick={onEditTiming} disabled={disabled}
          title={timingSummary(line, openingPeriod, { long: true })}
          style={{
            ...btnGhost, padding: '3px 8px', fontSize: 11, maxWidth: 190,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            color: hasCustomTiming(line) ? colors.accent : colors.muted,
            borderColor: hasCustomTiming(line) ? colors.accent : colors.border,
          }}>
          {timingSummary(line, openingPeriod)}
        </button>
      </Td>
      <Td align="right" style={{ fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>
        {fmtP(year1)}
      </Td>
      <Td align="right">
        <button onClick={() => onSave({ is_active: inactive })} disabled={disabled}
          title={inactive ? 'Include this line' : 'Exclude this line'}
          style={{ ...btnGhost, padding: '2px 6px' }}>{inactive ? '👁' : '—'}</button>
        <button onClick={onDelete} disabled={disabled} title="Delete line"
          style={{ ...btnGhost, padding: '2px 6px', color: colors.red }}>🗑</button>
      </Td>
    </tr>
  );
}

function TextCell({ value, onSave, disabled }) {
  const [local, setLocal] = useState(value ?? '');
  useEffect(() => { setLocal(value ?? ''); }, [value]);
  return (
    <input value={local} onChange={e => setLocal(e.target.value)}
      onBlur={() => { if (local !== value) onSave(local); }}
      disabled={disabled} style={{ ...inputStyle, fontFamily: 'inherit' }} />
  );
}

function NumCell({ value, onSave, disabled, width = 100, placeholder, allowBlank }) {
  const shown = value === '' || value == null ? '' : String(value);
  const [local, setLocal] = useState(shown);
  useEffect(() => { setLocal(shown); }, [shown]);
  const commit = () => {
    if (local === shown) return;
    if (local === '' && allowBlank) { onSave(''); return; }
    const n = Number(local);
    if (isNaN(n)) { setLocal(shown); return; }
    onSave(n);
  };
  return (
    <input value={local} onChange={e => setLocal(e.target.value)} onBlur={commit}
      placeholder={placeholder} disabled={disabled} inputMode="decimal"
      style={{ ...inputStyle, width, textAlign: 'right' }} />
  );
}

/** Tiny inline bar chart of the seeded months — shape at a glance. */
function Sparkline({ values }) {
  const max = Math.max(...values.map(v => Math.abs(v)), 1);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 1, height: 14, verticalAlign: 'middle' }}>
      {values.map((v, i) => (
        <span key={i} style={{
          width: 3, height: Math.max(1, (Math.abs(v) / max) * 14),
          background: v < 0 ? colors.red : colors.accent, opacity: 0.7, display: 'inline-block',
        }} />
      ))}
    </span>
  );
}
