// Version comparison — the current version (A) against any other named
// version (B) of the same forecast.
//
// Sections:
//   1. KPI delta cards — lifetime revenue/EBITDA, cash at end, lowest cash
//   2. Overlaid monthly charts — revenue and closing cash, A vs B
//   3. Annual A / B / Δ table — revenue, costs, EBITDA, margin, NPAT, cash
//   4. Assumptions diff — every driver value and loan that differs,
//      formatted by unit, so the "why" sits next to the "what".
//
// Entities/locations are forecast-level and shared between versions, so
// only drivers + loans can differ. Outputs for B are loaded on demand;
// if B was never recomputed a one-click recompute is offered.

import React, { useEffect, useMemo, useState } from 'react';
import { colors, fontStack, H2, serifStack, selectStyle, btnDark } from '../components/ui';
import { listScenarios, loadOutputs, loadScenarioDrivers, listLoans } from '../lib/queries';
import { recomputeScenario } from '../lib/recompute';

const SERIES_A = '#2a78d6';   // current version
const SERIES_B = '#eb6834';   // comparison version

export default function CompareView({
  forecast, versions = [], version, scenario, outputs, periods, openingPeriod,
}) {
  const others = versions.filter(v => v.id !== version?.id);
  const [otherId, setOtherId] = useState(others[0]?.id || null);
  const [other, setOther] = useState(null);          // { scenario, outputs, drivers, values, loans }
  const [mine, setMine] = useState(null);            // { drivers, values, loans } for current
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!others.find(v => v.id === otherId)) setOtherId(others[0]?.id || null);
  }, [versions, version?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Load the current version's drivers/loans (for the assumptions diff).
  useEffect(() => {
    let cancelled = false;
    if (!scenario?.id) { setMine(null); return; }
    (async () => {
      try {
        const [dv, loans] = await Promise.all([
          loadScenarioDrivers(scenario.id),
          listLoans(scenario.id).catch(() => []),
        ]);
        if (!cancelled) setMine({ ...dv, loans });
      } catch (e) { if (!cancelled) setErr(e.message); }
    })();
    return () => { cancelled = true; };
  }, [scenario?.id]);

  // Load the other version's base scenario, outputs, drivers, loans.
  const loadOther = async (versionId) => {
    if (!versionId) { setOther(null); return; }
    setLoading(true); setErr(null);
    try {
      const scenarios = await listScenarios(versionId);
      const base = scenarios.find(s => s.kind === 'base') || scenarios[0];
      if (!base) { setOther(null); setLoading(false); return; }
      const [outs, dv, loans] = await Promise.all([
        loadOutputs(base.id),
        loadScenarioDrivers(base.id),
        listLoans(base.id).catch(() => []),
      ]);
      setOther({ scenario: base, outputs: outs, ...dv, loans });
    } catch (e) { setErr(e.message); setOther(null); }
    setLoading(false);
  };

  useEffect(() => { loadOther(otherId); }, [otherId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const onRecomputeOther = async () => {
    if (!other?.scenario || !otherId) return;
    setLoading(true); setErr(null);
    try {
      await recomputeScenario({ forecast_id: forecast.id, version_id: otherId, scenario_id: other.scenario.id });
      await loadOther(otherId);
    } catch (e) { setErr(e.message); setLoading(false); }
  };

  const otherVersion = versions.find(v => v.id === otherId);

  if (others.length === 0) {
    return (
      <div style={{ padding: '48px 24px', textAlign: 'center', color: colors.muted, fontSize: 14, fontFamily: fontStack }}>
        Only one version exists ({version?.name}). Use <strong>+ Version</strong> in the header to duplicate it
        (e.g. as "Budget" or "Rolling Forecast"), change some assumptions, then compare here.
      </div>
    );
  }

  return (
    <div style={{ fontFamily: fontStack }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <H2>Compare versions</H2>
        <span style={{ fontSize: 13, color: colors.muted }}>·</span>
        <LegendChip color={SERIES_A} label={`${version?.name} (current)`} />
        <span style={{ fontSize: 13, color: colors.muted }}>vs</span>
        <LegendChip color={SERIES_B} label={otherVersion?.name || '—'} />
        <select value={otherId || ''} onChange={(e) => setOtherId(e.target.value)} style={selectStyle}>
          {others.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        {loading && <span style={{ fontSize: 12, color: colors.muted }}>Loading…</span>}
      </div>

      {err && (
        <div style={{ padding: 10, background: '#fef2f2', color: colors.red, borderRadius: 8, marginBottom: 12, fontSize: 12 }}>{err}</div>
      )}

      {other && other.outputs.length === 0 && (
        <div style={{ padding: 14, background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, marginBottom: 14, fontSize: 13, color: '#7c2d12', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span>"{otherVersion?.name}" has no computed outputs yet.</span>
          <button onClick={onRecomputeOther} disabled={loading} style={btnDark}>Recompute {otherVersion?.name}</button>
        </div>
      )}

      {other && other.outputs.length > 0 && (
        <ComparisonBody
          aName={version?.name} bName={otherVersion?.name}
          aOutputs={outputs} bOutputs={other.outputs}
          periods={periods} openingPeriod={openingPeriod}
        />
      )}

      <AssumptionsDiff
        aName={version?.name} bName={otherVersion?.name}
        mine={mine} other={other}
      />
    </div>
  );
}

// ── Numeric comparison body ───────────────────────────────────────

function ComparisonBody({ aName, bName, aOutputs, bOutputs, periods, openingPeriod }) {
  const n = periods.length;

  const series = (outs, nt, mode = 'sum') => {
    const arr = new Array(n).fill(mode === 'last' ? null : 0);
    for (const r of outs) {
      if (r.nominal_type !== nt) continue;
      const t = r.period;
      if (t == null || t < 0 || t >= n) continue;
      if (mode === 'last') arr[t] = r.amount_p;
      else arr[t] += r.amount_p;
    }
    return arr;
  };

  const a = useMemo(() => ({
    revenue: series(aOutputs, 'pnl.revenue_total'),
    costs: series(aOutputs, 'pnl.cost_total'),
    ebitda: series(aOutputs, 'pnl.ebitda'),
    npat: series(aOutputs, 'pnl.npat'),
    cash: series(aOutputs, 'bs.cash', 'last'),
  }), [aOutputs, n]);   // eslint-disable-line react-hooks/exhaustive-deps
  const b = useMemo(() => ({
    revenue: series(bOutputs, 'pnl.revenue_total'),
    costs: series(bOutputs, 'pnl.cost_total'),
    ebitda: series(bOutputs, 'pnl.ebitda'),
    npat: series(bOutputs, 'pnl.npat'),
    cash: series(bOutputs, 'bs.cash', 'last'),
  }), [bOutputs, n]);   // eslint-disable-line react-hooks/exhaustive-deps

  const sum = (arr) => arr.reduce((s, v) => s + (v || 0), 0);
  const lastVal = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
  const minVal = (arr) => {
    let m = null;
    for (const v of arr) if (v != null && (m == null || v < m)) m = v;
    return m;
  };

  const kpis = [
    { label: 'Revenue (life of plan)', a: sum(a.revenue), b: sum(b.revenue), upGood: true },
    { label: 'EBITDA (life of plan)', a: sum(a.ebitda), b: sum(b.ebitda), upGood: true },
    { label: 'Cash at end of plan', a: lastVal(a.cash), b: lastVal(b.cash), upGood: true },
    { label: 'Lowest cash point', a: minVal(a.cash), b: minVal(b.cash), upGood: true },
  ];

  const monthLbl = (t) => {
    if (!openingPeriod) return `M${t}`;
    const d = new Date(openingPeriod);
    if (isNaN(d.getTime())) return `M${t}`;
    const m = new Date(d.getFullYear(), d.getMonth() + t, 1);
    return m.toLocaleString('en-GB', { month: 'short', year: '2-digit' });
  };

  const horizonYears = Math.max(1, Math.ceil(n / 12));
  const yearRows = [];
  for (let y = 0; y < horizonYears; y++) {
    const ts = periods.filter(t => t >= y * 12 && t < (y + 1) * 12);
    const sumOver = (arr) => ts.reduce((s, t) => s + (arr[t] || 0), 0);
    const lastOf = (arr) => { for (let i = ts.length - 1; i >= 0; i--) { const v = arr[ts[i]]; if (v != null) return v; } return null; };
    yearRows.push({
      label: `Y${y + 1}`,
      revenue: [sumOver(a.revenue), sumOver(b.revenue)],
      costs: [sumOver(a.costs), sumOver(b.costs)],
      ebitda: [sumOver(a.ebitda), sumOver(b.ebitda)],
      npat: [sumOver(a.npat), sumOver(b.npat)],
      cash: [lastOf(a.cash), lastOf(b.cash)],
    });
  }

  return (
    <>
      {/* KPI delta cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginBottom: 18 }}>
        {kpis.map(k => <DeltaKpi key={k.label} {...k} aName={aName} bName={bName} />)}
      </div>

      {/* Overlaid charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
        <CompareChart title="Monthly revenue" aName={aName} bName={bName}
          aValues={a.revenue} bValues={b.revenue} monthLbl={monthLbl} />
        <CompareChart title="Closing cash" aName={aName} bName={bName}
          aValues={a.cash.map(v => v ?? 0)} bValues={b.cash.map(v => v ?? 0)} monthLbl={monthLbl} />
      </div>

      {/* Annual A/B/Δ table */}
      <H2 style={{ fontSize: 16 }}>Year by year</H2>
      <div style={{ overflowX: 'auto', border: `1px solid ${colors.border}`, borderRadius: 8, background: '#fff', marginBottom: 24 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, fontFamily: fontStack }}>
          <thead>
            <tr style={{ background: colors.bgSoft }}>
              <th style={th}>Metric</th>
              {yearRows.map(y => <th key={y.label} colSpan={3} style={{ ...th, textAlign: 'center', borderLeft: `1px solid ${colors.border}` }}>{y.label}</th>)}
            </tr>
            <tr style={{ background: colors.bgSoft }}>
              <th style={th}></th>
              {yearRows.map(y => (
                <React.Fragment key={y.label}>
                  <th style={{ ...thR, borderLeft: `1px solid ${colors.border}`, color: SERIES_A }}>{aName}</th>
                  <th style={{ ...thR, color: SERIES_B }}>{bName}</th>
                  <th style={thR}>Δ</th>
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            <MetricRow label="Revenue" rows={yearRows} k="revenue" upGood />
            <MetricRow label="Operating costs" rows={yearRows} k="costs" upGood={false} signed />
            <MetricRow label="EBITDA" rows={yearRows} k="ebitda" upGood bold />
            <MetricRow label="NPAT" rows={yearRows} k="npat" upGood />
            <MetricRow label="Closing cash" rows={yearRows} k="cash" upGood bold />
          </tbody>
        </table>
      </div>
    </>
  );
}

function MetricRow({ label, rows, k, upGood, bold, signed }) {
  return (
    <tr style={{ borderBottom: `1px solid ${colors.borderSoft}`, fontWeight: bold ? 700 : 400 }}>
      <td style={td}>{label}</td>
      {rows.map(y => {
        const [av, bv] = y[k];
        const delta = (av == null || bv == null) ? null : av - bv;
        const good = delta == null || delta === 0 ? null : (upGood ? delta > 0 : delta < 0);
        return (
          <React.Fragment key={y.label}>
            <td style={{ ...tdR, borderLeft: `1px solid ${colors.border}` }}>{fmtC(av)}</td>
            <td style={tdR}>{fmtC(bv)}</td>
            <td style={{ ...tdR, color: good == null ? colors.muted : good ? '#166534' : '#b91c1c' }}>
              {delta == null ? '—' : (delta > 0 ? '+' : '') + fmtC(delta)}
            </td>
          </React.Fragment>
        );
      })}
    </tr>
  );
}

function DeltaKpi({ label, a, b, upGood, aName, bName }) {
  const delta = (a == null || b == null) ? null : a - b;
  const good = delta == null || delta === 0 ? null : (upGood ? delta > 0 : delta < 0);
  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: '12px 14px', background: '#fff' }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: colors.muted }}>{label}</div>
      <div style={{ fontFamily: serifStack, fontSize: 22, color: good == null ? colors.ink : good ? '#166534' : '#b91c1c', margin: '4px 0 2px' }}>
        {delta == null ? '—' : (delta > 0 ? '+' : '') + fmtC(delta)}
      </div>
      <div style={{ fontSize: 11, color: colors.muted }}>
        <span style={{ color: SERIES_A, fontWeight: 600 }}>{aName}</span> {fmtC(a)} · <span style={{ color: SERIES_B, fontWeight: 600 }}>{bName}</span> {fmtC(b)}
      </div>
    </div>
  );
}

// ── Overlay line chart (inline SVG, 2 series) ────────────────────

function CompareChart({ title, aName, bName, aValues, bValues, monthLbl }) {
  const W = 560, H = 210, PAD = { l: 52, r: 10, t: 10, b: 22 };
  const n = Math.max(aValues.length, bValues.length);
  const all = [...aValues, ...bValues].filter(v => v != null && isFinite(v));
  const lo = Math.min(0, ...all);
  const hi = Math.max(...all, 1);
  const ticks = niceTicks(lo, hi, 4);
  const yFor = (v) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - ticks.lo) / (ticks.hi - ticks.lo));
  const xFor = (i) => PAD.l + (W - PAD.l - PAD.r) * (n <= 1 ? 0 : i / (n - 1));
  const path = (vals) => vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${xFor(i).toFixed(1)},${yFor(v || 0).toFixed(1)}`).join(' ');
  const xLabels = [];
  for (let i = 0; i < n; i += 12) xLabels.push(i);

  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, background: '#fff', padding: '10px 12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: colors.muted }}>{title}</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <LegendChip color={SERIES_A} label={aName} />
          <LegendChip color={SERIES_B} label={bName} />
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {ticks.values.map(v => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={yFor(v)} y2={yFor(v)} stroke="#e1e0d9" strokeWidth="1" />
            <text x={PAD.l - 6} y={yFor(v) + 3} textAnchor="end" fontSize="9" fill="#898781">{fmtAxis(v)}</text>
          </g>
        ))}
        {xLabels.map(i => (
          <text key={i} x={xFor(i)} y={H - 6} textAnchor="middle" fontSize="9" fill="#898781">{monthLbl(i)}</text>
        ))}
        <path d={path(bValues)} fill="none" stroke={SERIES_B} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <path d={path(aValues)} fill="none" stroke={SERIES_A} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </div>
  );
}

function LegendChip({ color, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: colors.inkSoft }}>
      <span style={{ width: 14, height: 3, background: color, borderRadius: 2, display: 'inline-block' }} />
      {label}
    </span>
  );
}

// ── Assumptions diff ──────────────────────────────────────────────

function AssumptionsDiff({ aName, bName, mine, other }) {
  const diffs = useMemo(() => {
    if (!mine || !other) return null;
    const valOf = (values, driverId) => {
      const rows = values.filter(v => v.driver_id === driverId);
      const scalar = rows.find(v => v.period === -1) || rows[0];
      return rows.length > 1 && !rows.every(r => r.period === -1)
        ? { series: rows.map(r => [r.period, Number(r.value)]).sort((x, y) => x[0] - y[0]) }
        : { scalar: scalar ? Number(scalar.value) : null };
    };
    const key = (d) => `${d.entity_id || 'group'}::${d.module_key}::${d.driver_key}`;
    const aMap = new Map(mine.drivers.map(d => [key(d), d]));
    const bMap = new Map(other.drivers.map(d => [key(d), d]));
    const out = [];
    for (const [k, da] of aMap) {
      const db = bMap.get(k);
      const va = valOf(mine.values, da.id);
      const vb = db ? valOf(other.values, db.id) : null;
      if (!db) { out.push({ d: da, kind: 'only_a' }); continue; }
      if (va.series || vb.series) {
        if (JSON.stringify(va.series || null) !== JSON.stringify(vb.series || null)) {
          out.push({ d: da, kind: 'series' });
        }
      } else if ((va.scalar ?? null) !== (vb.scalar ?? null)) {
        out.push({ d: da, kind: 'scalar', a: va.scalar, b: vb.scalar });
      }
    }
    for (const [k, db] of bMap) {
      if (!aMap.has(k)) out.push({ d: db, kind: 'only_b' });
    }
    out.sort((x, y) => (x.d.module_key + x.d.driver_key).localeCompare(y.d.module_key + y.d.driver_key));

    // Loans diff by (kind, label)
    const lkey = (l) => `${l.kind}::${l.label}`;
    const la = new Map((mine.loans || []).map(l => [lkey(l), l]));
    const lb = new Map((other.loans || []).map(l => [lkey(l), l]));
    const loanDiffs = [];
    for (const [k, l] of la) {
      const o = lb.get(k);
      if (!o) loanDiffs.push({ label: l.label, note: `only in ${aName}` });
      else if (l.principal_p !== o.principal_p || l.interest_pct !== o.interest_pct || l.term_months !== o.term_months || l.start_month !== o.start_month) {
        loanDiffs.push({ label: l.label, note: `${fmtC(l.principal_p)} @ ${l.interest_pct}% / ${l.term_months}mo vs ${fmtC(o.principal_p)} @ ${o.interest_pct}% / ${o.term_months}mo` });
      }
    }
    for (const [k, o] of lb) if (!la.has(k)) loanDiffs.push({ label: o.label, note: `only in ${bName}` });

    return { drivers: out, loans: loanDiffs };
  }, [mine, other, aName, bName]);

  if (!diffs) return null;

  const fmtVal = (d, v) => {
    if (v == null) return '—';
    if (d.unit === 'gbp_p') return fmtC(v);
    if (d.unit === 'pct') return `${v}%`;
    return String(v);
  };

  return (
    <div>
      <H2 style={{ fontSize: 16 }}>Assumption differences</H2>
      <p style={{ fontSize: 11, color: colors.muted, margin: '0 0 8px' }}>
        Every driver value and loan that differs between <strong style={{ color: SERIES_A }}>{aName}</strong> and{' '}
        <strong style={{ color: SERIES_B }}>{bName}</strong>. Locations are shared between versions, so assumptions are the only thing that can differ.
      </p>
      {diffs.drivers.length === 0 && diffs.loans.length === 0 ? (
        <div style={{ padding: 14, background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#065f46', borderRadius: 8, fontSize: 13 }}>
          No assumption differences — the two versions are identical. Any output differences would come from a stale recompute.
        </div>
      ) : (
        <div style={{ overflowX: 'auto', border: `1px solid ${colors.border}`, borderRadius: 8, background: '#fff' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, fontFamily: fontStack }}>
            <thead>
              <tr style={{ background: colors.bgSoft }}>
                <th style={th}>Module</th>
                <th style={th}>Assumption</th>
                <th style={th}>Scope</th>
                <th style={{ ...thR, color: SERIES_A }}>{aName}</th>
                <th style={{ ...thR, color: SERIES_B }}>{bName}</th>
                <th style={thR}>Δ%</th>
              </tr>
            </thead>
            <tbody>
              {diffs.drivers.map((x, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${colors.borderSoft}` }}>
                  <td style={{ ...td, color: colors.muted, fontSize: 10.5 }}>{x.d.module_key}</td>
                  <td style={td}>{x.d.label || x.d.driver_key}</td>
                  <td style={{ ...td, color: colors.muted }}>{x.d.entity_id ? 'location' : 'group'}</td>
                  {x.kind === 'scalar' ? (
                    <>
                      <td style={tdR}>{fmtVal(x.d, x.a)}</td>
                      <td style={tdR}>{fmtVal(x.d, x.b)}</td>
                      <td style={{ ...tdR, color: colors.muted }}>
                        {x.b ? `${(((x.a ?? 0) - x.b) / Math.abs(x.b) * 100).toFixed(1)}%` : '—'}
                      </td>
                    </>
                  ) : (
                    <td colSpan={3} style={{ ...td, color: colors.muted, fontStyle: 'italic' }}>
                      {x.kind === 'series' ? 'time-series values differ' : x.kind === 'only_a' ? `only in ${aName}` : `only in ${bName}`}
                    </td>
                  )}
                </tr>
              ))}
              {diffs.loans.map((l, i) => (
                <tr key={`loan-${i}`} style={{ borderBottom: `1px solid ${colors.borderSoft}` }}>
                  <td style={{ ...td, color: colors.muted, fontSize: 10.5 }}>loans</td>
                  <td style={td}>{l.label}</td>
                  <td style={{ ...td, color: colors.muted }}>group</td>
                  <td colSpan={3} style={{ ...td, color: colors.muted }}>{l.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Formatting helpers ────────────────────────────────────────────

function fmtC(p) {
  if (p == null || !isFinite(p)) return '—';
  const sign = p < 0 ? '-' : '';
  const abs = Math.abs(p) / 100;
  if (abs >= 1_000_000) return sign + '£' + (abs / 1_000_000).toFixed(2) + 'm';
  if (abs >= 10_000) return sign + '£' + Math.round(abs / 1000).toLocaleString('en-GB') + 'k';
  return sign + '£' + Math.round(abs).toLocaleString('en-GB');
}
function fmtAxis(p) {
  const abs = Math.abs(p) / 100;
  const sign = p < 0 ? '-' : '';
  if (abs >= 1_000_000) return sign + '£' + (abs / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'm';
  if (abs >= 1_000) return sign + '£' + Math.round(abs / 1000) + 'k';
  return sign + '£' + Math.round(abs);
}
function niceTicks(lo, hi, count) {
  if (hi === lo) hi = lo + 1;
  const rawStep = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const nlo = Math.floor(lo / step) * step;
  const nhi = Math.ceil(hi / step) * step;
  const values = [];
  for (let v = nlo; v <= nhi + step / 2; v += step) values.push(v);
  return { lo: nlo, hi: nhi, values };
}

const th = { padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: colors.muted, borderBottom: `1px solid ${colors.border}`, fontSize: 10.5 };
const thR = { ...th, textAlign: 'right' };
const td = { padding: '6px 10px', color: colors.ink };
const tdR = { ...td, textAlign: 'right', fontFamily: 'ui-monospace, monospace' };
