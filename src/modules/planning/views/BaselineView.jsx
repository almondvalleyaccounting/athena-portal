import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, XCircle, RefreshCw, Clock, Info } from 'lucide-react';
import { usePlanning } from '../PlanningModule';
import { loadBaselineHealth, loadPlCacheFreshness, loadOneOffsByMonth } from '../lib/queries';
import { fmtGBP } from '../lib/projection';

// Baseline — the trust layer. Every projection in this module inherits from
// the recurring base, so this page PROVES the base before anything is
// forecast from it:
//   1. Composition — contracted (QBO templates, fact) vs inferred
//      (invoice-inference, estimate). Never blended silently.
//   2. Reconciliation — does the run-rate tie to what the QBO P&L says
//      actually landed as income?
//   3. Data health — sync freshness, stale rows, duplicate template sets
//      (the corruption class that overstated this module by 50% until
//      2026-08-06, sql/188).
// If this page isn't green, every other tab says so implicitly.

const GREEN = '#059669', AMBER = '#d97706', RED = '#dc2626', GREY = '#94a3b8';

function hoursSince(ts) {
  if (!ts) return Infinity;
  return (Date.now() - new Date(ts).getTime()) / 36e5;
}

function fmtWhen(ts) {
  if (!ts) return 'never';
  const d = new Date(ts);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function BaselineView() {
  const { monthlyActuals, pullQboMonthly } = usePlanning();
  const [health, setHealth] = useState(null);
  const [plFreshness, setPlFreshness] = useState(null);
  const [oneOffs, setOneOffs] = useState(null); // Map | null = unknown (RLS)
  const [err, setErr] = useState(null);
  const [pulling, setPulling] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [h, f] = await Promise.all([loadBaselineHealth(), loadPlCacheFreshness()]);
        setHealth(h); setPlFreshness(f);
      } catch (e) { setErr(e.message); }
      try { setOneOffs(await loadOneOffsByMonth()); } catch { setOneOffs(null); }
    })();
  }, []);

  // ── P&L income by calendar month, from the QBO cache ──
  const incomeByMonth = useMemo(() => {
    const m = new Map();
    for (const a of monthlyActuals || []) {
      if (a.account_type !== 'Income') continue;
      // LTM summary rows span a whole year — only count true month rows.
      const start = String(a.period_start).slice(0, 10);
      const end = String(a.period_end).slice(0, 10);
      if (start.slice(0, 7) !== end.slice(0, 7)) continue;
      const key = start.slice(0, 7);
      m.set(key, (m.get(key) || 0) + (Number(a.amount) || 0));
    }
    return m;
  }, [monthlyActuals]);

  const thisMonth = new Date().toISOString().slice(0, 7);
  const closedMonths = useMemo(
    () => [...incomeByMonth.keys()].filter((k) => k < thisMonth).sort(),
    [incomeByMonth, thisMonth]
  );
  const last3 = closedMonths.slice(-3);
  const ltmIncome = closedMonths.slice(-12).reduce((s, k) => s + incomeByMonth.get(k), 0);

  // ── Reconciliation on the latest closed month ──
  const totalMonthly = Number(health?.total_monthly) || 0;
  const contractedMonthly = Number(health?.contracted_monthly) || 0;
  const inferredMonthly = Number(health?.inferred_monthly_amount) || 0;
  const inferredAnnual = Number(health?.inferred_annual_amount) || 0;

  const lastClosed = last3[last3.length - 1] || null;
  const lastClosedIncome = lastClosed ? incomeByMonth.get(lastClosed) : null;
  const lastClosedOneOffs = lastClosed && oneOffs ? (oneOffs.get(lastClosed) || 0) : null;
  // Implied recurring+annual = what landed as income minus known Athena
  // one-offs. Two DIFFERENT comparisons, deliberately:
  //   floor check (monthly)  — implied vs the CONTRACTED base only. Annual
  //     work lands lumpy, so a single month can never be fairly compared
  //     against a run-rate that smooths "annual ÷ 12"; but income should
  //     never fall below what the templates alone generate.
  //   book check (LTM)       — trailing-12 income vs the annualised
  //     run-rate. Fair at year scale, though today's run-rate reflects a
  //     book that grew/uplifted through the year, so a modest shortfall
  //     is expected in a growing firm.
  const impliedRecurring = lastClosedIncome != null && lastClosedOneOffs != null
    ? lastClosedIncome - lastClosedOneOffs : null;
  const floorDrift = impliedRecurring != null && contractedMonthly > 0
    ? (impliedRecurring - contractedMonthly) / contractedMonthly : null;
  const bookDrift = closedMonths.length >= 12 && totalMonthly > 0
    ? (ltmIncome - totalMonthly * 12) / (totalMonthly * 12) : null;

  // ── Status logic ──
  const statuses = useMemo(() => {
    if (!health) return [];
    const qboAgeH = hoursSince(health.newest_sync);
    const plAgeH = hoursSince(plFreshness);
    const s = [];

    s.push({
      key: 'duplicates',
      label: 'Duplicate template rows',
      level: health.duplicate_template_sets > 0 ? 'red' : 'green',
      text: health.duplicate_template_sets > 0
        ? `${health.duplicate_template_sets} template${health.duplicate_template_sets !== 1 ? 's' : ''} with duplicate active rows — totals are inflated. This should be impossible (unique index, sql/188); investigate before trusting anything here.`
        : 'One active row per QBO template — the duplicate-minting bug class is guarded by a unique index.',
    });
    s.push({
      key: 'qbo',
      label: 'Billing sync (qbo-pull)',
      level: qboAgeH <= 36 ? 'green' : qboAgeH <= 24 * 7 ? 'amber' : 'red',
      text: `Last pull ${fmtWhen(health.newest_sync)} · ${health.stale_rows} row${health.stale_rows !== 1 ? 's' : ''} not refreshed in 3+ days${health.stale_rows > 0 ? ' (unlinked invoice-inferred rows only refresh when the client is invoiced)' : ''}.`,
      action: { label: 'Full pull on Billing Review →', href: '/manage/billing' },
    });
    s.push({
      key: 'pl',
      label: 'P&L actuals cache',
      level: plAgeH <= 72 ? 'green' : plAgeH <= 24 * 14 ? 'amber' : 'red',
      text: `Monthly P&L last fetched from QBO ${fmtWhen(plFreshness)}. Actuals overlay and this page's reconciliation read from it.`,
      action: { label: pulling ? 'Refreshing…' : 'Refresh P&L now', onClick: refreshPl },
    });
    if (floorDrift != null) {
      // Income should never fall below what the templates alone generate;
      // a POSITIVE number is normal (annual work landing on top).
      s.push({
        key: 'floor',
        label: 'Contracted floor check',
        level: floorDrift >= -0.05 ? 'green' : floorDrift >= -0.15 ? 'amber' : 'red',
        text: `${lastClosed}: income net of Athena one-offs was ${fmtGBP(impliedRecurring)} vs the contracted base of ${fmtGBP(contractedMonthly)} (${floorDrift >= 0 ? '+' : ''}${(floorDrift * 100).toFixed(1)}%). ${floorDrift >= 0 ? 'The templates are collecting; the surplus is annual and other work.' : 'Income came in BELOW what the templates alone should generate — check failed direct debits or paused templates.'}`,
      });
    } else {
      s.push({
        key: 'floor',
        label: 'Contracted floor check',
        level: 'amber',
        text: oneOffs === null
          ? 'One-off invoice data not readable from this account — the floor check needs it, so treat this page with caution.'
          : 'No closed-month P&L data cached yet — refresh the P&L to enable reconciliation.',
      });
    }
    if (bookDrift != null) {
      const abs = Math.abs(bookDrift);
      s.push({
        key: 'book',
        label: 'Whole-book check (LTM)',
        level: abs <= 0.10 ? 'green' : abs <= 0.20 ? 'amber' : 'red',
        text: `Last 12 months' income ${fmtGBP(ltmIncome)} vs the annualised run-rate ${fmtGBP(totalMonthly * 12)} (${bookDrift >= 0 ? '+' : ''}${(bookDrift * 100).toFixed(1)}%). Today's run-rate reflects a book that grew and took uplifts through the year, so a modest shortfall is expected in a growing firm.`,
      });
    }
    return s;
  }, [health, plFreshness, floorDrift, bookDrift, impliedRecurring, lastClosed, contractedMonthly, totalMonthly, ltmIncome, oneOffs, pulling]);

  const worst = statuses.some((s) => s.level === 'red') ? 'red'
    : statuses.some((s) => s.level === 'amber') ? 'amber' : 'green';

  async function refreshPl() {
    setPulling(true);
    try { await pullQboMonthly(12); setPlFreshness(new Date().toISOString()); }
    catch (e) { setErr(e.message); }
    setPulling(false);
  }

  if (err) return <div style={{ color: RED, fontSize: 13 }}>Baseline failed to load: {err}</div>;
  if (!health) return <div style={{ color: GREY, fontSize: 13 }}>Checking the baseline…</div>;

  const verdict = {
    green: { colour: GREEN, bg: '#f0fdf4', border: '#bbf7d0', icon: CheckCircle2, title: 'The base is sound', sub: 'Recurring base reconciles to the QBO P&L and the data is fresh. The projections on the other tabs stand on this.' },
    amber: { colour: AMBER, bg: '#fffbeb', border: '#fcd34d', icon: AlertTriangle, title: 'Usable, with caveats', sub: 'The base is broadly trustworthy but at least one check below needs attention before leaning hard on the numbers.' },
    red:   { colour: RED, bg: '#fef2f2', border: '#fecaca', icon: XCircle, title: 'Do not trust the projections yet', sub: 'A structural problem in the base data means every downstream number inherits it. Fix the red items below first.' },
  }[worst];
  const VerdictIcon = verdict.icon;

  return (
    <div>
      {/* Verdict */}
      <div style={{ background: verdict.bg, border: `1px solid ${verdict.border}`, borderRadius: 12, padding: '16px 20px', marginBottom: 16, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <VerdictIcon size={22} style={{ color: verdict.colour, flexShrink: 0, marginTop: 2 }} />
        <div>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 17, fontWeight: 500, color: '#0f172a' }}>{verdict.title}</div>
          <div style={{ fontSize: 12.5, color: '#475569', marginTop: 2, lineHeight: 1.55 }}>{verdict.sub}</div>
        </div>
      </div>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
        <Kpi label="Contracted recurring" tag="FACT" tagColour={GREEN}
          value={`${fmtGBP(contractedMonthly)}/mo`}
          sub={`${health.contracted_rows} QBO templates · ${health.contracted_clients} clients`} />
        <Kpi label="Estimated recurring" tag="ESTIMATE" tagColour={AMBER}
          value={`${fmtGBP(inferredMonthly + inferredAnnual)}/mo`}
          sub={`${fmtGBP(inferredMonthly)} inferred monthly · ${fmtGBP(inferredAnnual)} annual work ÷ 12`} />
        <Kpi label="Total run-rate"
          value={`${fmtGBP(totalMonthly)}/mo`}
          sub={`${fmtGBP(totalMonthly * 12)} annualised · ${health.active_clients} clients`} />
        <Kpi label="LTM P&L income" tag="QBO" tagColour="#0e7fe0"
          value={fmtGBP(ltmIncome)}
          sub={lastClosed ? `${lastClosed}: ${fmtGBP(lastClosedIncome)}` : 'no monthly cache yet'} />
      </div>

      {/* Composition */}
      <div style={card}>
        <h3 style={h3}>What the recurring base is made of</h3>
        <p style={sub}>
          <b>Contracted</b> fees are QBO recurring templates — signed instructions QBO will invoice without anyone touching them.
          <b> Estimated</b> fees are rebuilt nightly from invoice history: "inferred monthly" appeared in consecutive months;
          "annual ÷ 12" appeared once in twelve months and is spread — including genuinely one-off work that may never repeat.
          Decisions about guaranteed income should lean on the contracted figure.
        </p>
        <CompositionBar contracted={contractedMonthly} inferredMonthly={inferredMonthly} inferredAnnual={inferredAnnual} />
      </div>

      {/* Reconciliation */}
      <div style={{ ...card, marginTop: 16 }}>
        <h3 style={h3}>Does the book tie to the P&L?</h3>
        <p style={sub}>
          Each closed month: QBO's accrual P&L income, minus one-off invoices pushed from Athena, should never fall
          below the <b>contracted base</b> — what the templates alone generate. Anything above the floor is annual
          and other work, which lands lumpy (year-end season, SA rush), so big positive months are normal and the
          smoothed run-rate is only compared at whole-year scale (see the data-health checks below).
        </p>
        {last3.length === 0 ? (
          <div style={{ fontSize: 12.5, color: GREY }}>No closed-month P&L data cached — use "Refresh P&L now" below.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  <th style={{ ...th, textAlign: 'left' }}>Month</th>
                  <th style={th}>P&L income</th>
                  <th style={th}>Athena one-offs</th>
                  <th style={th}>Recurring + annual</th>
                  <th style={th}>Contracted base</th>
                  <th style={th}>vs floor</th>
                </tr>
              </thead>
              <tbody>
                {last3.map((k) => {
                  const inc = incomeByMonth.get(k) || 0;
                  const oo = oneOffs ? (oneOffs.get(k) || 0) : null;
                  const implied = oo != null ? inc - oo : null;
                  const drift = implied != null && contractedMonthly > 0 ? (implied - contractedMonthly) / contractedMonthly : null;
                  // Positive = annual work landing on top of the floor: healthy.
                  // Negative beyond tolerance = the templates aren't collecting.
                  const driftColour = drift == null ? GREY : drift >= -0.05 ? GREEN : drift >= -0.15 ? AMBER : RED;
                  return (
                    <tr key={k} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={{ ...td, textAlign: 'left', color: '#64748b' }}>{k}</td>
                      <td style={td}>{fmtGBP(inc)}</td>
                      <td style={td}>{oo == null ? '—' : fmtGBP(oo)}</td>
                      <td style={{ ...td, fontWeight: 600 }}>{implied == null ? '—' : fmtGBP(implied)}</td>
                      <td style={td}>{fmtGBP(contractedMonthly)}</td>
                      <td style={{ ...td, color: driftColour, fontWeight: 700 }}>
                        {drift == null ? '—' : `${drift >= 0 ? '+' : ''}${(drift * 100).toFixed(1)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <IncomeChart incomeByMonth={incomeByMonth} closedMonths={closedMonths} runRate={totalMonthly} contracted={contractedMonthly} />
      </div>

      {/* Data health */}
      <div style={{ ...card, marginTop: 16 }}>
        <h3 style={h3}>Data health</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          {statuses.map((s) => {
            const colour = { green: GREEN, amber: AMBER, red: RED }[s.level];
            const Icon = { green: CheckCircle2, amber: Clock, red: XCircle }[s.level];
            return (
              <div key={s.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: '#f8fafc', borderRadius: 8, padding: '10px 12px' }}>
                <Icon size={16} style={{ color: colour, flexShrink: 0, marginTop: 1 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: 0.4 }}>{s.label}</div>
                  <div style={{ fontSize: 12.5, color: '#475569', lineHeight: 1.5, marginTop: 2 }}>{s.text}</div>
                </div>
                {s.action && (s.action.href ? (
                  <a href={s.action.href} style={{ fontSize: 12, fontWeight: 600, color: '#0e7fe0', textDecoration: 'none', whiteSpace: 'nowrap' }}>{s.action.label}</a>
                ) : (
                  <button onClick={s.action.onClick} disabled={pulling}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: '#0e7fe0', background: 'none', border: '1px solid #bfdbfe', borderRadius: 7, padding: '5px 10px', cursor: pulling ? 'default' : 'pointer', whiteSpace: 'nowrap', fontFamily: "'Outfit', sans-serif" }}>
                    <RefreshCw size={12} style={pulling ? { animation: 'spin 1s linear infinite' } : undefined} />{s.action.label}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 12, fontSize: 11.5, color: GREY }}>
          <Info size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            Oldest row last synced {fmtWhen(health.oldest_sync)}. {health.active_rows} active billing rows across {health.active_clients} clients.
            The billing sync runs nightly; the P&L cache refreshes nightly at 03:00.
          </span>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, tag, tagColour }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
        {tag && <span style={{ fontSize: 8.5, fontWeight: 800, color: '#fff', background: tagColour, padding: '1px 6px', borderRadius: 4, letterSpacing: 0.5 }}>{tag}</span>}
      </div>
      <div style={{ fontSize: 21, fontWeight: 700, color: '#0f172a', marginTop: 3 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function CompositionBar({ contracted, inferredMonthly, inferredAnnual }) {
  const total = contracted + inferredMonthly + inferredAnnual || 1;
  const seg = (v, colour, label) => (
    <div title={`${label}: ${fmtGBP(v)}/mo (${((v / total) * 100).toFixed(0)}%)`}
      style={{ width: `${(v / total) * 100}%`, background: colour, height: '100%' }} />
  );
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', height: 26, borderRadius: 8, overflow: 'hidden', border: '1px solid #e5e7eb' }}>
        {seg(contracted, '#059669', 'Contracted (QBO templates)')}
        {seg(inferredMonthly, '#f59e0b', 'Inferred monthly')}
        {seg(inferredAnnual, '#fbbf24', 'Annual work ÷ 12')}
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11.5, color: '#64748b', flexWrap: 'wrap' }}>
        <LegendDot colour="#059669" label={`Contracted ${fmtGBP(contracted)}/mo`} />
        <LegendDot colour="#f59e0b" label={`Inferred monthly ${fmtGBP(inferredMonthly)}/mo`} />
        <LegendDot colour="#fbbf24" label={`Annual work ÷ 12 ${fmtGBP(inferredAnnual)}/mo`} />
      </div>
    </div>
  );
}

function LegendDot({ colour, label }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: colour }} />{label}</span>;
}

// 12 closed months of income as bars, with the smoothed run-rate and the
// contracted floor as reference lines.
function IncomeChart({ incomeByMonth, closedMonths, runRate, contracted }) {
  const keys = closedMonths.slice(-12);
  if (keys.length < 3) return null;
  const vals = keys.map((k) => incomeByMonth.get(k) || 0);
  const max = Math.max(...vals, runRate) * 1.08 || 1;
  const H = 120;
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ position: 'relative', height: H, borderBottom: '1px solid #e5e7eb' }}>
        {/* Run-rate line */}
        <div style={{ position: 'absolute', left: 0, right: 0, top: H - (runRate / max) * H, borderTop: '2px dashed #0e7fe0', zIndex: 1 }} />
        <div style={{ position: 'absolute', right: 0, top: H - (runRate / max) * H - 16, fontSize: 10, color: '#0e7fe0', fontWeight: 600 }}>
          run-rate {fmtGBP(runRate)}
        </div>
        {/* Contracted floor line */}
        {contracted > 0 && (
          <>
            <div style={{ position: 'absolute', left: 0, right: 0, top: H - (contracted / max) * H, borderTop: '2px dashed #059669', zIndex: 1 }} />
            <div style={{ position: 'absolute', left: 0, top: H - (contracted / max) * H + 3, fontSize: 10, color: '#059669', fontWeight: 600 }}>
              contracted floor {fmtGBP(contracted)}
            </div>
          </>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${keys.length}, 1fr)`, gap: 6, alignItems: 'end', height: '100%' }}>
          {keys.map((k, i) => (
            <div key={k} title={`${k}: ${fmtGBP(vals[i])}`}
              style={{ height: (vals[i] / max) * H, background: '#cbd5e1', borderRadius: '3px 3px 0 0' }} />
          ))}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${keys.length}, 1fr)`, gap: 6, marginTop: 4 }}>
        {keys.map((k) => (
          <div key={k} style={{ fontSize: 9, color: '#94a3b8', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden' }}>{k.slice(2)}</div>
        ))}
      </div>
    </div>
  );
}

const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 };
const h3 = { fontFamily: "'Playfair Display', serif", fontSize: 16, fontWeight: 500, color: '#0f172a', margin: 0 };
const sub = { fontSize: 12, color: '#64748b', margin: '6px 0 0', lineHeight: 1.6 };
const th = { padding: '9px 12px', textAlign: 'right', fontWeight: 600 };
const td = { padding: '7px 12px', textAlign: 'right', color: '#0f172a', fontVariantNumeric: 'tabular-nums' };
