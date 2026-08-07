import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, Info } from 'lucide-react';
import { usePlanning } from '../PlanningModule';
import { loadBsCache, pullQboBalanceSheet, loadBaselineHealth } from '../lib/queries';
import { buildCashForecast, classifyBalanceSheet } from '../lib/cashflow';
import { fmtGBP } from '../lib/projection';

// Cash & Owner — Phase 3 of the overhaul. The question this page answers is
// the one every owner actually asks: "what can I safely take out?"
// Bobby's rule (2026-08-07): ring-fence VAT and CT provisions right up to
// the report date, then keep six months of payroll. The headline safe-draw
// is the MINIMUM headroom across the next year, so a draw today can't
// breach the floor when the VAT quarter or CT bill lands.

const GREEN = '#059669', AMBER = '#d97706', RED = '#dc2626', GREY = '#94a3b8';
const font = "'Outfit', sans-serif";

export default function CashView() {
  const { scenario, staffLines, ownerCompLines, overheadLines, monthlyActuals, updateScenario } = usePlanning();
  const [bsRows, setBsRows] = useState(null);
  const [health, setHealth] = useState(null);
  const [pulling, setPulling] = useState(false);
  const [err, setErr] = useState(null);
  const [edit, setEdit] = useState(null); // local assumptions edit buffer

  async function refreshBs() {
    setPulling(true); setErr(null);
    try {
      const r = await pullQboBalanceSheet();
      if (r?.success === false) throw new Error(r.error || 'balance sheet pull failed');
      setBsRows(await loadBsCache());
    } catch (e) { setErr(e.message); }
    setPulling(false);
  }

  useEffect(() => {
    (async () => {
      try {
        const [rows, h] = await Promise.all([loadBsCache(), loadBaselineHealth()]);
        setHealth(h);
        const today = new Date().toISOString().slice(0, 10);
        if (!rows.length || rows[0].snapshot_date < today) {
          setBsRows(rows);          // show what we have while refreshing
          await refreshBs();        // then pull today's snapshot
        } else {
          setBsRows(rows);
        }
      } catch (e) { setErr(e.message); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bs = useMemo(() => classifyBalanceSheet(bsRows || []), [bsRows]);

  // ── Model inputs ──
  const contractedNetMonthly = Number(health?.contracted_monthly) || 0;

  // Other (non-contracted) net income: average of the last 3 closed months'
  // P&L income minus the contracted base — annual work, one-offs, interest.
  const otherNetMonthly = useMemo(() => {
    const byMonth = new Map();
    for (const a of monthlyActuals || []) {
      if (a.account_type !== 'Income') continue;
      const s = String(a.period_start).slice(0, 10), e = String(a.period_end).slice(0, 10);
      if (s.slice(0, 7) !== e.slice(0, 7)) continue;
      byMonth.set(s.slice(0, 7), (byMonth.get(s.slice(0, 7)) || 0) + (Number(a.amount) || 0));
    }
    const thisMonth = new Date().toISOString().slice(0, 7);
    const keys = [...byMonth.keys()].filter((k) => k < thisMonth).sort().slice(-3);
    if (!keys.length) return 0;
    const avg = keys.reduce((s, k) => s + byMonth.get(k), 0) / keys.length;
    return Math.max(0, avg - contractedNetMonthly);
  }, [monthlyActuals, contractedNetMonthly]);

  const grossPayrollMonthly = useMemo(() => {
    const onDefault = Number(scenario?.default_on_costs_pct) || 15.05;
    let m = 0;
    for (const s of staffLines || []) {
      const on = s.on_costs_pct == null ? onDefault : Number(s.on_costs_pct);
      m += ((Number(s.annual_salary) || 0) * (1 + on / 100)) / 12;
    }
    for (const o of ownerCompLines || []) {
      if (o.comp_type !== 'salary') continue;
      const on = o.on_costs_pct == null ? onDefault : Number(o.on_costs_pct);
      m += (Number(o.amount_monthly) || 0) * (1 + on / 100);
    }
    return m;
  }, [staffLines, ownerCompLines, scenario]);

  const dividendsMonthly = useMemo(() => (ownerCompLines || [])
    .filter((o) => o.comp_type !== 'salary')
    .reduce((s, o) => s + (o.amount_annual != null ? Number(o.amount_annual) / 12 : (Number(o.amount_monthly) || 0)), 0),
  [ownerCompLines]);

  const overheadNetMonthly = useMemo(
    () => (overheadLines || []).reduce((s, o) => s + (Number(o.monthly_amount) || 0), 0),
    [overheadLines]
  );

  const fc = useMemo(() => buildCashForecast({
    scenario, contractedNetMonthly, otherNetMonthly, grossPayrollMonthly, dividendsMonthly, overheadNetMonthly, bs,
  }), [scenario, contractedNetMonthly, otherNetMonthly, grossPayrollMonthly, dividendsMonthly, overheadNetMonthly, bs]);

  const modelFed = grossPayrollMonthly > 0 && overheadNetMonthly > 0;
  const safe = fc.safeDraw;
  const safeColour = safe > 0 ? GREEN : RED;

  if (err && !bsRows?.length) return <div style={{ color: RED, fontSize: 13 }}>Cash page failed to load: {err}</div>;
  if (bsRows === null) return <div style={{ color: GREY, fontSize: 13 }}>Fetching the balance sheet from QuickBooks…</div>;

  return (
    <div>
      {!modelFed && (
        <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10, padding: '12px 16px', marginBottom: 14, fontSize: 12.5, color: '#92400e', lineHeight: 1.6 }}>
          <b>The cash model is missing costs:</b> {grossPayrollMonthly === 0 ? 'no staff salaries are entered (Staff tab)' : ''}
          {grossPayrollMonthly === 0 && overheadNetMonthly === 0 ? ' and ' : ''}
          {overheadNetMonthly === 0 ? 'no overhead lines exist (Overheads tab — seed them from QBO)' : ''}.
          Until they're in, the payroll floor and outgoings below are understated and the safe-draw figure is meaningless.
        </div>
      )}
      {err && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, color: '#991b1b', marginBottom: 12 }}>{err}</div>}

      {/* Headline */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 8 }}>
        <Kpi label="Cash today" value={fmtGBP(fc.cashNow)} sub={`Balance sheet ${bs.snapshotDate || '—'} · ${bs.cashAccounts.length} account${bs.cashAccounts.length !== 1 ? 's' : ''}`} />
        <Kpi label="VAT ring-fenced" value={fmtGBP(fc.provisionsNow.vat)} sub="Provision to the report date" colour={AMBER} />
        <Kpi label="CT ring-fenced" value={fmtGBP(fc.provisionsNow.ct)} sub={`incl. in-year accrual at ${(fc.assumptions.effCtRate * 100).toFixed(1)}%`} colour={AMBER} />
        <Kpi label={`Payroll floor (${fc.assumptions.floorMonths} mo)`} value={fmtGBP(fc.floor)} sub={`${fmtGBP(grossPayrollMonthly)}/mo fully-loaded`} />
        <div style={{ background: safe > 0 ? '#f0fdf4' : '#fef2f2', border: `1px solid ${safe > 0 ? '#bbf7d0' : '#fecaca'}`, borderRadius: 12, padding: '14px 16px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: safeColour, textTransform: 'uppercase', letterSpacing: 0.5 }}>Safe to draw</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: safeColour, marginTop: 2 }}>{fmtGBP(Math.max(0, safe))}</div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
            {safe > 0
              ? `Worst headroom ${fmtGBP(fc.headroomMin)} on ${fc.headroomMinDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
              : `Short of the floor by ${fmtGBP(Math.abs(safe))} at the worst point (${fc.headroomMinDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })})`}
          </div>
        </div>
      </div>
      <p style={{ fontSize: 11.5, color: GREY, margin: '0 0 16px', lineHeight: 1.6 }}>
        Safe-to-draw = the minimum, across the next 12 months, of projected cash less unpaid VAT and CT provisions less the
        payroll floor — so taking it today still leaves the floor intact when the VAT quarter and the CT bill land.
      </p>

      {/* 13-week chart */}
      <div style={card}>
        <h3 style={h3}>Next 13 weeks</h3>
        <p style={sub}>
          Projected bank balance week by week. The shaded line is the ring-fence (VAT + CT provisions + payroll floor) —
          the balance dipping toward it is what limits drawings, not the balance itself.
        </p>
        <WeeklyChart weeks={fc.weeks} floor={fc.floor} />
      </div>

      {/* 12-month table */}
      <div style={{ ...card, marginTop: 16, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #e5e7eb', fontFamily: "'Playfair Display', serif", fontSize: 16, color: '#0f172a' }}>
          Month by month
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse', minWidth: 640 }}>
            <thead>
              <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                <th style={{ ...th, textAlign: 'left' }}>Month</th>
                <th style={th}>Receipts</th>
                <th style={th}>Payments</th>
                <th style={th}>Closing cash</th>
                <th style={th}>Headroom over ring-fence</th>
              </tr>
            </thead>
            <tbody>
              {fc.months.map((m) => (
                <tr key={m.key} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={{ ...td, textAlign: 'left', color: '#64748b' }}>{m.key}</td>
                  <td style={{ ...td, color: GREEN }}>{fmtGBP(m.in)}</td>
                  <td style={{ ...td, color: '#b91c1c' }}>{fmtGBP(m.out)}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{fmtGBP(m.closing)}</td>
                  <td style={{ ...td, fontWeight: 700, color: m.headroom >= 0 ? GREEN : RED }}>{fmtGBP(m.headroom)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Upcoming big hits */}
      <div style={{ ...card, marginTop: 16 }}>
        <h3 style={h3}>The big hits ahead</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          {fc.events.filter((e) => (e.label.startsWith('VAT') || e.label.startsWith('CT'))).slice(0, 6).map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center', background: '#f8fafc', borderRadius: 8, padding: '8px 12px', fontSize: 12.5 }}>
              <AlertTriangle size={14} style={{ color: AMBER }} />
              <span style={{ color: '#334155', flex: 1 }}>{e.label}</span>
              <span style={{ color: '#64748b' }}>{e.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
              <b style={{ color: '#b91c1c' }}>{fmtGBP(-e.amount)}</b>
            </div>
          ))}
          {fc.events.filter((e) => e.label.startsWith('VAT') || e.label.startsWith('CT')).length === 0 && (
            <div style={{ fontSize: 12.5, color: GREY }}>No VAT or CT payments scheduled inside the horizon.</div>
          )}
        </div>
      </div>

      {/* Assumptions + BS transparency */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginTop: 16 }}>
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <h3 style={h3}>Assumptions</h3>
            {edit == null
              ? <button style={btnOutline} onClick={() => setEdit({
                  cash_debtor_days: scenario?.cash_debtor_days ?? 30,
                  cash_floor_months: scenario?.cash_floor_months ?? 6,
                  cash_paye_pct: scenario?.cash_paye_pct ?? 30,
                  cash_overhead_vatable_pct: scenario?.cash_overhead_vatable_pct ?? 70,
                  fiscal_year_end_month: scenario?.fiscal_year_end_month ?? 9,
                })}>Edit</button>
              : <div style={{ display: 'flex', gap: 6 }}>
                  <button style={btnOutline} onClick={() => setEdit(null)}>Cancel</button>
                  <button style={btnDark} onClick={async () => { await updateScenario(edit); setEdit(null); }}>Save</button>
                </div>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10, fontSize: 12.5 }}>
            <AssumptionRow label="Debtor days on non-DD fees" value={edit ? edit.cash_debtor_days : fc.assumptions.debtorDays}
              edit={edit && ((v) => setEdit({ ...edit, cash_debtor_days: Number(v) }))} suffix="days" />
            <AssumptionRow label="Payroll floor" value={edit ? edit.cash_floor_months : fc.assumptions.floorMonths}
              edit={edit && ((v) => setEdit({ ...edit, cash_floor_months: Number(v) }))} suffix="months" />
            <AssumptionRow label="PAYE/NI share of gross payroll" value={edit ? edit.cash_paye_pct : fc.assumptions.payePct * 100}
              edit={edit && ((v) => setEdit({ ...edit, cash_paye_pct: Number(v) }))} suffix="%" />
            <AssumptionRow label="Overheads VATable" value={edit ? edit.cash_overhead_vatable_pct : fc.assumptions.vatablePct * 100}
              edit={edit && ((v) => setEdit({ ...edit, cash_overhead_vatable_pct: Number(v) }))} suffix="%" />
            <AssumptionRow label="Firm year-end month (1–12)" value={edit ? edit.fiscal_year_end_month : fc.assumptions.yeMonth}
              edit={edit && ((v) => setEdit({ ...edit, fiscal_year_end_month: Number(v) }))} suffix="" />
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 10, fontSize: 11.5, color: GREY }}>
            <Info size={13} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              VAT quarters Mar/Jun/Sep/Dec, paid a month and 7 days later. Net VAT ≈ {fmtGBP(fc.assumptions.monthlyNetVat)}/mo.
              Year-end is September (confirmed 2026-08-07; edit here if it ever changes). CT pays 9 months and a day after year-end.
            </span>
          </div>
        </div>

        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <h3 style={h3}>What the balance sheet said</h3>
            <button style={btnOutline} onClick={refreshBs} disabled={pulling}>
              <RefreshCw size={12} style={pulling ? { animation: 'spin 1s linear infinite' } : undefined} /> {pulling ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          <div style={{ fontSize: 12.5, color: '#475569', marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
            {bs.cashAccounts.map((a, i) => (
              <Row key={i} label={a.name} value={fmtGBP(a.amount)} icon={<CheckCircle2 size={13} style={{ color: GREEN }} />} />
            ))}
            {bs.provisionAccounts.map((a, i) => (
              <Row key={`p${i}`} label={`${a.name} (${a.kind})`} value={fmtGBP(a.amount)} icon={<AlertTriangle size={13} style={{ color: AMBER }} />} />
            ))}
            {bs.clientMoneyAccounts.map((a, i) => (
              <Row key={`cm${i}`} label={`${a.name} — client money, excluded`} value={fmtGBP(a.amount)} icon={<Info size={13} style={{ color: GREY }} />} />
            ))}
            {bs.debtors !== 0 && <Row label="Trade debtors" value={fmtGBP(bs.debtors)} icon={<Info size={13} style={{ color: GREY }} />} />}
            {bs.unclassified.length > 0 && (
              <div style={{ fontSize: 11.5, color: AMBER, marginTop: 6 }}>
                Unclassified liabilities (not in the model): {bs.unclassified.map((u) => `${u.name} ${fmtGBP(u.amount)}`).join(' · ')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, colour }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 16px', borderLeft: colour ? `3px solid ${colour}` : undefined }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 21, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Row({ label, value, icon }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {icon}<span style={{ flex: 1 }}>{label}</span><b style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</b>
    </div>
  );
}

function AssumptionRow({ label, value, edit, suffix }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ flex: 1, color: '#475569' }}>{label}</span>
      {edit
        ? <input type="number" value={value} onChange={(e) => edit(e.target.value)}
            style={{ width: 70, padding: '4px 8px', fontSize: 12.5, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, textAlign: 'right' }} />
        : <b style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.round(Number(value) * 100) / 100}</b>}
      <span style={{ color: '#94a3b8', fontSize: 11, width: 44 }}>{suffix}</span>
    </div>
  );
}

function WeeklyChart({ weeks, floor }) {
  if (!weeks.length) return null;
  const maxVal = Math.max(...weeks.map((w) => w.closing), floor) * 1.1 || 1;
  const minVal = Math.min(0, ...weeks.map((w) => w.closing));
  const span = maxVal - minVal || 1;
  const H = 150;
  const y = (v) => H - ((v - minVal) / span) * H;
  // Ring-fence per week = closing − headroom (provisions move as they pay/accrue)
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ position: 'relative', height: H, borderBottom: '1px solid #e5e7eb' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${weeks.length}, 1fr)`, gap: 4, alignItems: 'end', height: '100%' }}>
          {weeks.map((w) => {
            const ringfence = w.closing - w.headroom;
            return (
              <div key={w.index} title={`w/c ${w.start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}\nIn ${fmtGBP(w.in)} · Out ${fmtGBP(w.out)}\nClosing ${fmtGBP(w.closing)}\nRing-fence ${fmtGBP(ringfence)}\nHeadroom ${fmtGBP(w.headroom)}`}
                style={{ position: 'relative', height: '100%' }}>
                <div style={{ position: 'absolute', bottom: 0, left: '12%', right: '12%', height: Math.max(2, H - y(w.closing)), background: w.headroom >= 0 ? '#0e7fe0' : '#dc2626', borderRadius: '3px 3px 0 0', opacity: 0.85 }} />
                <div style={{ position: 'absolute', left: 0, right: 0, top: y(ringfence), borderTop: '2px dashed #d97706' }} />
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${weeks.length}, 1fr)`, gap: 4, marginTop: 4 }}>
        {weeks.map((w) => (
          <div key={w.index} style={{ fontSize: 9, color: '#94a3b8', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden' }}>
            {w.start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 11.5, color: '#64748b' }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#0e7fe0', borderRadius: 2, marginRight: 5 }} />Closing cash</span>
        <span><span style={{ display: 'inline-block', width: 14, borderTop: '2px dashed #d97706', marginRight: 5, verticalAlign: 'middle' }} />Ring-fence (VAT + CT + floor)</span>
      </div>
    </div>
  );
}

const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 };
const h3 = { fontFamily: "'Playfair Display', serif", fontSize: 16, fontWeight: 500, color: '#0f172a', margin: 0 };
const sub = { fontSize: 12, color: '#64748b', margin: '6px 0 0', lineHeight: 1.6 };
const th = { padding: '9px 12px', textAlign: 'right', fontWeight: 600 };
const td = { padding: '7px 12px', textAlign: 'right', color: '#0f172a', fontVariantNumeric: 'tabular-nums' };
const btnDark = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', fontSize: 12, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontFamily: font };
const btnOutline = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', fontSize: 12, fontWeight: 600, background: '#fff', color: '#0f172a', border: '1px solid #e5e7eb', borderRadius: 7, cursor: 'pointer', fontFamily: font };
