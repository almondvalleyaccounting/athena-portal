// Version comparison — up to 5 named versions of the same forecast,
// side by side.
//
// Sections:
//   1. Version picker chips — current version pinned, add/remove others
//   2. Overlaid monthly charts — revenue and closing cash, one series
//      per selected version
//   3. Key metrics table — versions as columns; profitability, cash and
//      operations rows
//   4. Assumptions diff — every driver value / loan that differs across
//      ANY of the selected versions, one column per version.
//
// Entities/locations are forecast-level and shared between versions, so
// drivers + loans are the only things that can differ. Outputs load on
// demand per version; stale versions get a one-click recompute.

import React, { useEffect, useMemo, useState } from 'react';
import { colors, fontStack, H2, serifStack, btnDark, btnOutline } from '../components/ui';
import { listScenarios, loadOutputs, loadScenarioDrivers, listLoans } from '../lib/queries';
import { recomputeScenario } from '../lib/recompute';
import { buildOccupancyIndex, occKey } from '../lib/occupancy.js';

// Categorical slots (validated palette) — one per selected version, in
// selection order, current version always slot 1.
const SLOT_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
const MAX_VERSIONS = 5;

export default function CompareView({
  forecast, versions = [], version, scenario, outputs, periods, openingPeriod, entities = [],
}) {
  // Selected version ids — current pinned first.
  const [selectedIds, setSelectedIds] = useState([]);
  // Cache: versionId -> { scenario, outputs, drivers, values, loans }
  const [cache, setCache] = useState({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  // Keep current pinned; default-select the next version if none chosen.
  useEffect(() => {
    if (!version?.id) return;
    setSelectedIds(prev => {
      const others = prev.filter(id => id !== version.id && versions.some(v => v.id === id));
      if (others.length === 0) {
        const firstOther = versions.find(v => v.id !== version.id);
        return firstOther ? [version.id, firstOther.id] : [version.id];
      }
      return [version.id, ...others].slice(0, MAX_VERSIONS);
    });
  }, [version?.id, versions]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Seed the cache for the CURRENT version from props (outputs already
  // loaded by the module shell); drivers/loans still fetched.
  useEffect(() => {
    let cancelled = false;
    if (!version?.id || !scenario?.id) return;
    (async () => {
      try {
        const [dv, loans] = await Promise.all([
          loadScenarioDrivers(scenario.id),
          listLoans(scenario.id).catch(() => []),
        ]);
        if (!cancelled) {
          setCache(prev => ({ ...prev, [version.id]: { scenario, outputs, ...dv, loans } }));
        }
      } catch (e) { if (!cancelled) setErr(e.message); }
    })();
    return () => { cancelled = true; };
  }, [version?.id, scenario?.id, outputs]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Load any selected versions not yet cached.
  useEffect(() => {
    let cancelled = false;
    const missing = selectedIds.filter(id => id !== version?.id && !cache[id]);
    if (missing.length === 0) return;
    setLoading(true);
    (async () => {
      try {
        for (const id of missing) {
          const scenarios = await listScenarios(id);
          const base = scenarios.find(s => s.kind === 'base') || scenarios[0];
          if (!base) { if (!cancelled) setCache(prev => ({ ...prev, [id]: { scenario: null, outputs: [], drivers: [], values: [], loans: [] } })); continue; }
          const [outs, dv, loans] = await Promise.all([
            loadOutputs(base.id),
            loadScenarioDrivers(base.id),
            listLoans(base.id).catch(() => []),
          ]);
          if (cancelled) return;
          setCache(prev => ({ ...prev, [id]: { scenario: base, outputs: outs, ...dv, loans } }));
        }
      } catch (e) { if (!cancelled) setErr(e.message); }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [selectedIds, version?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id) => {
    if (id === version?.id) return;   // current is pinned
    setSelectedIds(prev => prev.includes(id)
      ? prev.filter(x => x !== id)
      : (prev.length >= MAX_VERSIONS ? prev : [...prev, id]));
  };

  const onRecomputeVersion = async (versionId) => {
    const entry = cache[versionId];
    if (!entry?.scenario) return;
    setLoading(true); setErr(null);
    try {
      await recomputeScenario({ forecast_id: forecast.id, version_id: versionId, scenario_id: entry.scenario.id });
      const outs = await loadOutputs(entry.scenario.id);
      setCache(prev => ({ ...prev, [versionId]: { ...prev[versionId], outputs: outs } }));
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };

  if (versions.length < 2) {
    return (
      <div style={{ padding: '48px 24px', textAlign: 'center', color: colors.muted, fontSize: 14, fontFamily: fontStack }}>
        Only one version exists ({version?.name}). Use <strong>+ Version</strong> in the header to duplicate it
        (e.g. as "Budget" or "Rolling Forecast"), change some assumptions, then compare here.
      </div>
    );
  }

  // Ordered selection: current first, then selection order.
  const selection = selectedIds
    .map((id, i) => ({ v: versions.find(x => x.id === id), color: SLOT_COLORS[i % SLOT_COLORS.length], entry: cache[id] }))
    .filter(s => s.v);
  const ready = selection.filter(s => s.entry && s.entry.outputs.length > 0);
  const stale = selection.filter(s => s.entry && s.entry.scenario && s.entry.outputs.length === 0);

  return (
    <div style={{ fontFamily: fontStack }}>
      {/* Version picker chips */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <H2>Compare versions</H2>
        <span style={{ fontSize: 12, color: colors.muted, marginLeft: 4 }}>up to {MAX_VERSIONS} ·</span>
        {versions.map(v => {
          const idx = selectedIds.indexOf(v.id);
          const on = idx >= 0;
          const isCurrent = v.id === version?.id;
          return (
            <button key={v.id} onClick={() => toggle(v.id)}
              title={isCurrent ? 'Current version (always included)' : on ? 'Remove from comparison' : 'Add to comparison'}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', borderRadius: 999, fontSize: 12, fontFamily: fontStack,
                cursor: isCurrent ? 'default' : 'pointer',
                border: `1.5px solid ${on ? SLOT_COLORS[idx % SLOT_COLORS.length] : colors.border}`,
                background: on ? '#fff' : colors.bgSoft,
                color: on ? colors.ink : colors.muted,
                fontWeight: on ? 600 : 400,
              }}>
              {on && <span style={{ width: 10, height: 10, borderRadius: 999, background: SLOT_COLORS[idx % SLOT_COLORS.length] }} />}
              {v.name}{isCurrent ? ' (current)' : ''}
            </button>
          );
        })}
        {loading && <span style={{ fontSize: 12, color: colors.muted }}>Loading…</span>}
      </div>

      {err && (
        <div style={{ padding: 10, background: '#fef2f2', color: colors.red, borderRadius: 8, marginBottom: 12, fontSize: 12 }}>{err}</div>
      )}

      {stale.length > 0 && (
        <div style={{ padding: 12, background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, marginBottom: 14, fontSize: 13, color: '#7c2d12', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>No computed outputs yet:</span>
          {stale.map(s => (
            <button key={s.v.id} onClick={() => onRecomputeVersion(s.v.id)} disabled={loading} style={{ ...btnOutline, padding: '4px 10px', fontSize: 12 }}>
              Recompute {s.v.name}
            </button>
          ))}
        </div>
      )}

      {ready.length >= 2 && (
        <>
          <Charts selection={ready} periods={periods} openingPeriod={openingPeriod} />
          <MetricsTable selection={ready} periods={periods} openingPeriod={openingPeriod} entities={entities} currentId={version?.id} />
        </>
      )}

      <AssumptionsDiff selection={selection.filter(s => s.entry)} currentId={version?.id} />
    </div>
  );
}

// ── Series extraction ─────────────────────────────────────────────

function extractSeries(outs, n) {
  const revenue = new Array(n).fill(0);
  const ebitda = new Array(n).fill(0);
  const npat = new Array(n).fill(0);
  const cash = new Array(n).fill(null);
  for (const r of outs) {
    const t = r.period;
    if (t == null || t < 0 || t >= n) continue;
    if (r.nominal_type === 'pnl.revenue_total') revenue[t] += r.amount_p;
    else if (r.nominal_type === 'pnl.ebitda') ebitda[t] += r.amount_p;
    else if (r.nominal_type === 'pnl.npat') npat[t] += r.amount_p;
    else if (r.nominal_type === 'bs.cash') cash[t] = r.amount_p;
  }
  return { revenue, ebitda, npat, cash };
}

// ── Overlaid charts ───────────────────────────────────────────────

function Charts({ selection, periods, openingPeriod }) {
  const n = periods.length;
  const monthLbl = (t) => {
    if (!openingPeriod) return `M${t}`;
    const d = new Date(openingPeriod);
    if (isNaN(d.getTime())) return `M${t}`;
    const m = new Date(d.getFullYear(), d.getMonth() + t, 1);
    return m.toLocaleString('en-GB', { month: 'short', year: '2-digit' });
  };
  const series = selection.map(s => ({ ...s, data: extractSeries(s.entry.outputs, n) }));
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
      <MultiChart title="Monthly revenue" series={series.map(s => ({ label: s.v.name, color: s.color, values: s.data.revenue }))} monthLbl={monthLbl} />
      <MultiChart title="Closing cash" series={series.map(s => ({ label: s.v.name, color: s.color, values: s.data.cash.map(v => v ?? 0) }))} monthLbl={monthLbl} />
    </div>
  );
}

function MultiChart({ title, series, monthLbl }) {
  const W = 560, H = 210, PAD = { l: 52, r: 10, t: 10, b: 22 };
  const n = Math.max(...series.map(s => s.values.length));
  const all = series.flatMap(s => s.values).filter(v => v != null && isFinite(v));
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, flexWrap: 'wrap', gap: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: colors.muted }}>{title}</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {series.map(s => <LegendChip key={s.label} color={s.color} label={s.label} />)}
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
        {/* Draw in reverse so the CURRENT version (slot 1) paints on top */}
        {[...series].reverse().map(s => (
          <path key={s.label} d={path(s.values)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        ))}
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

// ── Key metrics table — versions as columns ───────────────────────

function MetricsTable({ selection, periods, openingPeriod, entities, currentId }) {
  const n = periods.length;
  const horizonYears = Math.max(1, Math.ceil(n / 12));
  const anchorYear = Math.min(3, horizonYears);

  const monthLbl = (t) => {
    if (t == null) return '—';
    if (!openingPeriod) return `M${t}`;
    const d = new Date(openingPeriod);
    if (isNaN(d.getTime())) return `M${t}`;
    const m = new Date(d.getFullYear(), d.getMonth() + t, 1);
    return m.toLocaleString('en-GB', { month: 'short', year: '2-digit' });
  };

  const cols = useMemo(() => selection.map(s => {
    const { revenue, ebitda, npat, cash } = extractSeries(s.entry.outputs, n);
    const sum = (arr, from = 0, to = n) => { let x = 0; for (let t = from; t < Math.min(to, n); t++) x += arr[t] || 0; return x; };
    const lastVal = (arr) => { for (let i = n - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
    let cashMin = null, cashMinT = null;
    for (let t = 0; t < n; t++) if (cash[t] != null && (cashMin == null || cash[t] < cashMin)) { cashMin = cash[t]; cashMinT = t; }
    let ebitdaPosT = null;
    for (let t = 0; t < n; t++) {
      if (ebitda[t] > 0 && (t + 1 >= n || ebitda[t + 1] > 0) && (t + 2 >= n || ebitda[t + 2] > 0)) { ebitdaPosT = t; break; }
    }
    // Capacity % / children over the last 12 months, from engine occupancy
    const occIdx = buildOccupancyIndex(s.entry.outputs);
    let kidSum = 0, kidN = 0, capTotal = 0;
    for (const e of entities) {
      const caps = e.config?.capacity_by_age_band || {};
      for (const b of Object.keys(caps)) capTotal += caps[b] || 0;
    }
    for (let t = Math.max(0, n - 12); t < n; t++) {
      let kids = 0, any = false;
      for (const e of entities) {
        const caps = e.config?.capacity_by_age_band || {};
        for (const b of Object.keys(caps)) {
          const c = caps[b] || 0;
          if (!c) continue;
          const o = occIdx.get(occKey(e.id, b, t));
          if (o == null) continue;
          kids += c * o / 100; any = true;
        }
      }
      if (any) { kidSum += kids; kidN += 1; }
    }
    const kidsAvg = kidN > 0 ? kidSum / kidN : null;

    const revLife = sum(revenue);
    const ebitdaLife = sum(ebitda);
    const yFrom = (anchorYear - 1) * 12, yTo = anchorYear * 12;
    const revY = sum(revenue, yFrom, yTo);
    const ebitdaY = sum(ebitda, yFrom, yTo);
    return {
      id: s.v.id, name: s.v.name, color: s.color,
      revLife, ebitdaLife,
      marginLife: revLife > 0 ? ebitdaLife / revLife * 100 : null,
      npatLife: sum(npat),
      revY, ebitdaY,
      marginY: revY > 0 ? ebitdaY / revY * 100 : null,
      ebitdaPosT,
      cashEnd: lastVal(cash),
      cashMin, cashMinT,
      funding: cashMin != null && cashMin < 0 ? -cashMin : 0,
      kidsAvg,
      capPct: kidsAvg != null && capTotal > 0 ? kidsAvg / capTotal * 100 : null,
    };
  }), [selection, n, entities, anchorYear]);

  const groups = [
    {
      title: 'Profitability',
      rows: [
        { label: 'Revenue — life of plan', get: c => fmtC(c.revLife) },
        { label: 'EBITDA — life of plan', get: c => fmtC(c.ebitdaLife) },
        { label: 'EBITDA margin — life', get: c => fmtPct(c.marginLife) },
        { label: 'NPAT — life of plan', get: c => fmtC(c.npatLife) },
        { label: `Revenue — Y${anchorYear}`, get: c => fmtC(c.revY) },
        { label: `EBITDA — Y${anchorYear}`, get: c => fmtC(c.ebitdaY) },
        { label: `EBITDA margin — Y${anchorYear}`, get: c => fmtPct(c.marginY) },
        { label: 'EBITDA-positive from', get: c => c.ebitdaPosT == null ? '—' : `${monthLbl(c.ebitdaPosT)} (m${c.ebitdaPosT + 1})` },
      ],
    },
    {
      title: 'Cash',
      rows: [
        { label: 'Cash at end of plan', get: c => fmtC(c.cashEnd) },
        { label: 'Lowest cash point', get: c => c.cashMin == null ? '—' : `${fmtC(c.cashMin)} (${monthLbl(c.cashMinT)})` },
        { label: 'Funding need beyond capital', get: c => c.funding > 0 ? fmtC(c.funding) : '£0' },
      ],
    },
    {
      title: 'Operations (final year)',
      rows: [
        { label: 'Children (FTE, avg)', get: c => c.kidsAvg == null ? '—' : c.kidsAvg.toFixed(1) },
        { label: 'Capacity %', get: c => fmtPct(c.capPct) },
      ],
    },
  ];

  return (
    <>
      <H2 style={{ fontSize: 16 }}>Key metrics</H2>
      <div style={{ overflowX: 'auto', border: `1px solid ${colors.border}`, borderRadius: 8, background: '#fff', marginBottom: 24 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: fontStack }}>
          <thead>
            <tr style={{ background: colors.bgSoft }}>
              <th style={{ ...th, minWidth: 190 }}>Metric</th>
              {cols.map(c => (
                <th key={c.id} style={{ ...thR, minWidth: 130 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 999, background: c.color, display: 'inline-block' }} />
                    <span style={{ fontWeight: c.id === currentId ? 700 : 600, color: colors.ink }}>
                      {c.name}{c.id === currentId ? ' (current)' : ''}
                    </span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(g => (
              <React.Fragment key={g.title}>
                <tr style={{ background: '#eef2f7' }}>
                  <td colSpan={1 + cols.length} style={{ ...td, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: colors.muted }}>
                    {g.title}
                  </td>
                </tr>
                {g.rows.map(row => (
                  <tr key={row.label} style={{ borderBottom: `1px solid ${colors.borderSoft}` }}>
                    <td style={td}>{row.label}</td>
                    {cols.map(c => (
                      <td key={c.id} style={{ ...tdR, fontWeight: c.id === currentId ? 600 : 400 }}>{row.get(c)}</td>
                    ))}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Assumptions diff — one column per version ─────────────────────

function AssumptionsDiff({ selection, currentId }) {
  const diffs = useMemo(() => {
    if (selection.length < 2 || selection.some(s => !s.entry?.drivers)) return null;

    const key = (d) => `${d.entity_id || 'group'}::${d.module_key}::${d.driver_key}`;
    const perVersion = selection.map(s => {
      const byKey = new Map(s.entry.drivers.map(d => [key(d), d]));
      const valOf = (d) => {
        if (!d) return { missing: true };
        const rows = s.entry.values.filter(v => v.driver_id === d.id);
        if (rows.length > 1 && !rows.every(r => r.period === -1)) {
          return { series: JSON.stringify(rows.map(r => [r.period, Number(r.value)]).sort((x, y) => x[0] - y[0])) };
        }
        const hit = rows.find(v => v.period === -1) || rows[0];
        return { scalar: hit != null ? Number(hit.value) : null };
      };
      return { byKey, valOf };
    });

    const allKeys = new Set();
    for (const pv of perVersion) for (const k of pv.byKey.keys()) allKeys.add(k);

    const rows = [];
    for (const k of allKeys) {
      const cells = perVersion.map(pv => ({ d: pv.byKey.get(k), val: pv.valOf(pv.byKey.get(k)) }));
      const rep = cells.find(c => c.d)?.d;
      const sig = (c) => c.val.missing ? '∅' : c.val.series != null ? `S${c.val.series}` : `N${c.val.scalar}`;
      const first = sig(cells[0]);
      if (cells.every(c => sig(c) === first)) continue;   // identical across all
      rows.push({ key: k, rep, cells });
    }
    rows.sort((a, b) => (a.rep.module_key + a.rep.driver_key).localeCompare(b.rep.module_key + b.rep.driver_key));

    // Loans: signature per version by (kind,label,principal,rate,term,start)
    const loanSig = (l) => `${l.kind}::${l.label}::${l.principal_p}::${l.interest_pct}::${l.term_months}::${l.start_month}`;
    const loanLabels = new Set();
    for (const s of selection) for (const l of (s.entry.loans || [])) loanLabels.add(`${l.kind}::${l.label}`);
    const loanRows = [];
    for (const kl of loanLabels) {
      const cells = selection.map(s => (s.entry.loans || []).find(l => `${l.kind}::${l.label}` === kl) || null);
      const sigs = cells.map(l => (l ? loanSig(l) : '∅'));
      if (sigs.every(x => x === sigs[0])) continue;
      loanRows.push({ label: kl.split('::')[1], cells });
    }

    return { rows, loanRows };
  }, [selection]);

  if (!diffs) return null;

  const fmtVal = (d, val) => {
    if (val.missing) return '—';
    if (val.series != null) return 'series';
    if (val.scalar == null) return 'blank';
    if (d?.unit === 'gbp_p') return fmtC(val.scalar);
    if (d?.unit === 'pct') return `${val.scalar}%`;
    return String(val.scalar);
  };

  return (
    <div>
      <H2 style={{ fontSize: 16 }}>Assumption differences</H2>
      <p style={{ fontSize: 11, color: colors.muted, margin: '0 0 8px' }}>
        Every driver value and loan that differs across the selected versions. Locations are shared
        between versions, so assumptions are the only thing that can differ.
      </p>
      {diffs.rows.length === 0 && diffs.loanRows.length === 0 ? (
        <div style={{ padding: 14, background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#065f46', borderRadius: 8, fontSize: 13 }}>
          No assumption differences — the selected versions are identical. Any output differences would come from a stale recompute.
        </div>
      ) : (
        <div style={{ overflowX: 'auto', border: `1px solid ${colors.border}`, borderRadius: 8, background: '#fff' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, fontFamily: fontStack }}>
            <thead>
              <tr style={{ background: colors.bgSoft }}>
                <th style={th}>Module</th>
                <th style={th}>Assumption</th>
                <th style={th}>Scope</th>
                {selection.map(s => (
                  <th key={s.v.id} style={thR}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 999, background: s.color, display: 'inline-block' }} />
                      <span style={{ color: colors.ink, fontWeight: s.v.id === currentId ? 700 : 600 }}>{s.v.name}</span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {diffs.rows.map((r) => (
                <tr key={r.key} style={{ borderBottom: `1px solid ${colors.borderSoft}` }}>
                  <td style={{ ...td, color: colors.muted, fontSize: 10.5 }}>{r.rep.module_key}</td>
                  <td style={td}>{r.rep.label || r.rep.driver_key}</td>
                  <td style={{ ...td, color: colors.muted }}>{r.rep.entity_id ? 'location' : 'group'}</td>
                  {r.cells.map((c, i) => (
                    <td key={i} style={tdR}>{fmtVal(c.d || r.rep, c.val)}</td>
                  ))}
                </tr>
              ))}
              {diffs.loanRows.map((l, i) => (
                <tr key={`loan-${i}`} style={{ borderBottom: `1px solid ${colors.borderSoft}` }}>
                  <td style={{ ...td, color: colors.muted, fontSize: 10.5 }}>loans</td>
                  <td style={td}>{l.label}</td>
                  <td style={{ ...td, color: colors.muted }}>group</td>
                  {l.cells.map((loan, j) => (
                    <td key={j} style={tdR}>
                      {loan ? `${fmtC(loan.principal_p)} @ ${loan.interest_pct}% / ${loan.term_months}mo` : '—'}
                    </td>
                  ))}
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
function fmtPct(x) { return x == null ? '—' : x.toFixed(1) + '%'; }
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

const th = { padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: colors.muted, borderBottom: `1px solid ${colors.border}`, fontSize: 10.5 };
const thR = { ...th, textAlign: 'right' };
const td = { padding: '7px 10px', color: colors.ink };
const tdR = { ...td, textAlign: 'right', fontFamily: 'ui-monospace, monospace' };
