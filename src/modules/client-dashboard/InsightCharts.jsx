import React from 'react';
import { moneyCompact, money, OUTFIT } from './dashboardData';

/*
  The client dashboard's explanatory charts — one or two per tab, each beside
  the table it explains. Inline SVG and plain HTML, no chart library, and pure:
  shared with the client portal through @dash, so React and siblings only.

  Every SVG chart takes the `width` it will be drawn at (FitChart supplies it)
  and maps 1:1, so text stays at its designed size on a phone and a monitor.

  Colour is meaning, kept the same everywhere: turnover is the pale blue of the
  Overview bars, profit is ink, and age runs blue (not due) → amber → red (old).
*/

export const AGE_COLOURS = {
  current: '#93c5fd',
  b1_30: '#fcd34d',
  b31_60: '#fb923c',
  b61_90: '#f87171',
  b91_plus: '#b91c1c',
};
export const AGE_KEYS = ['current', 'b1_30', 'b31_60', 'b61_90', 'b91_plus'];
export const AGE_LABELS = {
  current: 'Not yet due', b1_30: '1–30 days', b31_60: '31–60 days', b61_90: '61–90 days', b91_plus: 'Over 90 days',
};

const INK = '#0f172a';
const FAINT = '#94a3b8';
const GRID = '#f1f5f9';
const font = OUTFIT;

const axisVals = (min, max, n = 4) => {
  const out = [];
  for (let g = 0; g <= n; g++) out.push(min + ((max - min) * g) / n);
  return out;
};
const labelStep = (n, innerW) => Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 52))));

/* ─── Age bar: one bar, split by age band ─────────────────────────── */
/*
  Where the money owed sits, from not-yet-due to over 90 days. A credit in a
  band (a negative) draws nothing but is still listed, so the legend adds up to
  the total even when the bar cannot show it.
*/
export function AgeBar({ buckets, currency = 'GBP', title, note }) {
  if (!buckets) return null;
  const vals = AGE_KEYS.map((k) => ({ key: k, value: Number(buckets[k]) || 0 }));
  const positive = vals.reduce((s, v) => s + Math.max(0, v.value), 0);
  const total = vals.reduce((s, v) => s + v.value, 0);
  const overdue = vals.filter((v) => v.key !== 'current').reduce((s, v) => s + v.value, 0);
  return (
    <div>
      {title && <div style={{ fontFamily: font, fontSize: 14.5, fontWeight: 700, color: INK, marginBottom: 2 }}>{title}</div>}
      <div style={{ fontFamily: font, fontSize: 12.5, color: FAINT, marginBottom: 10 }}>
        {money(total, currency)} in all
        {Math.abs(total) > 0.005 && ` · ${Math.round((overdue / total) * 100)}% past its due date`}
        {note ? ` · ${note}` : ''}
      </div>
      <div style={{ display: 'flex', height: 22, borderRadius: 6, overflow: 'hidden', background: GRID }}>
        {positive > 0 && vals.map((v) => (v.value > 0 ? (
          <div
            key={v.key}
            title={`${AGE_LABELS[v.key]}: ${money(v.value, currency)}`}
            style={{ width: `${(v.value / positive) * 100}%`, background: AGE_COLOURS[v.key] }}
          />
        ) : null))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '8px 14px', marginTop: 10 }}>
        {vals.map((v) => (
          <div key={v.key} style={{ fontFamily: font }}>
            <div style={{ fontSize: 12, color: FAINT, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: AGE_COLOURS[v.key], display: 'inline-block' }} />
              {AGE_LABELS[v.key]}
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: v.key === 'b91_plus' && v.value > 0.005 ? AGE_COLOURS.b91_plus : INK }}>
              {money(v.value, currency)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Top names, each bar split by age ────────────────────────────── */
export function TopAgedBars({ rows = [], currency = 'GBP', limit = 10, title }) {
  const top = rows.filter((r) => (r.total || 0) > 0.005).slice(0, limit);
  if (!top.length) return null;
  const max = Math.max(...top.map((r) => r.total));
  return (
    <div>
      {title && <div style={{ fontFamily: font, fontSize: 14.5, fontWeight: 700, color: INK, marginBottom: 10 }}>{title}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 34%) 1fr auto', gap: '7px 10px', alignItems: 'center' }}>
        {top.map((r) => (
          <React.Fragment key={r.name}>
            <div style={{ fontFamily: font, fontSize: 12.5, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.name}>
              {r.name}
            </div>
            <div style={{ display: 'flex', height: 14, borderRadius: 4, overflow: 'hidden', width: `${Math.max(2, (r.total / max) * 100)}%` }}>
              {AGE_KEYS.map((k) => {
                const v = Math.max(0, Number(r[k]) || 0);
                const pos = AGE_KEYS.reduce((s, kk) => s + Math.max(0, Number(r[kk]) || 0), 0) || 1;
                return v > 0 ? (
                  <div key={k} title={`${AGE_LABELS[k]}: ${money(v, currency)}`} style={{ width: `${(v / pos) * 100}%`, background: AGE_COLOURS[k] }} />
                ) : null;
              })}
            </div>
            <div style={{ fontFamily: font, fontSize: 12.5, fontWeight: 700, color: INK, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {moneyCompact(r.total, currency)}
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

/* ─── Waterfall: turnover down to profit ──────────────────────────── */
/*
  steps: [{ label, value, kind: 'total' | 'step' }]. A 'total' bar stands on
  the axis; a 'step' floats from the running total, down if negative.
*/
export function Waterfall({ steps = [], currency = 'GBP', width = 600, height = 260 }) {
  const W = Math.max(260, Math.round(width));
  const H = height;
  const PAD = { top: 22, right: 10, bottom: 34, left: 56 };
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  if (!steps.length) return null;

  let run = 0;
  const bars = steps.map((s) => {
    if (s.kind === 'total') { run = s.value; return { ...s, from: 0, to: s.value }; }
    const from = run;
    run += s.value;
    return { ...s, from, to: run };
  });
  const lo = Math.min(0, ...bars.map((b) => Math.min(b.from, b.to)));
  let hi = Math.max(0, ...bars.map((b) => Math.max(b.from, b.to)));
  if (hi === lo) hi = lo + 1;
  const y = (v) => PAD.top + ih - ((v - lo) / (hi - lo)) * ih;
  const slot = iw / bars.length;
  const bw = Math.min(70, slot * 0.6);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="From turnover to profit">
      {axisVals(lo, hi).map((v, i) => (
        <g key={i}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke={GRID} />
          <text x={PAD.left - 8} y={y(v) + 3.5} textAnchor="end" fontSize="11" fill={FAINT} fontFamily={font}>{moneyCompact(v, currency)}</text>
        </g>
      ))}
      <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke="#cbd5e1" />
      {bars.map((b, i) => {
        const x = PAD.left + slot * i + (slot - bw) / 2;
        const top = y(Math.max(b.from, b.to));
        const h = Math.max(1, Math.abs(y(b.from) - y(b.to)));
        const fill = b.kind === 'total'
          ? (b.to >= 0 ? '#1E4560' : '#b91c1c')
          : (b.value >= 0 ? '#86efac' : '#fca5a5');
        const next = bars[i + 1];
        return (
          <g key={b.label}>
            <rect x={x} y={top} width={bw} height={h} rx="3" fill={fill}>
              <title>{`${b.label}: ${money(b.value, currency)}`}</title>
            </rect>
            <text x={x + bw / 2} y={top - 6} textAnchor="middle" fontSize="11" fontWeight="700" fill={INK} fontFamily={font}>
              {moneyCompact(b.value, currency)}
            </text>
            {next && next.kind !== 'total' && (
              <line x1={x + bw} x2={x + slot} y1={y(b.to)} y2={y(b.to)} stroke={FAINT} strokeDasharray="2 2" />
            )}
            <text x={x + bw / 2} y={H - 14} textAnchor="middle" fontSize="11" fill="#64748b" fontFamily={font}>{b.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

/* ─── Stacked columns: costs by heading, period by period ─────────── */
export const STACK_COLOURS = ['#1E4560', '#0e7490', '#38bdf8', '#7dd3fc', '#a78bfa', '#fbbf24', '#cbd5e1'];

export function StackedColumns({ labels = [], series = [], currency = 'GBP', width = 600, height = 260 }) {
  const W = Math.max(260, Math.round(width));
  const H = height;
  const PAD = { top: 14, right: 10, bottom: 28, left: 56 };
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const n = labels.length;
  if (!n || !series.length) return null;
  const totals = labels.map((_, i) => series.reduce((s, se) => s + Math.max(0, Number(se.values[i]) || 0), 0));
  let max = Math.max(...totals, 0);
  if (!max) max = 1;
  const y = (v) => PAD.top + ih - (v / max) * ih;
  const slot = iw / n;
  const bw = Math.min(40, slot * 0.62);
  const every = labelStep(n, iw);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Costs by heading">
      {axisVals(0, max).map((v, i) => (
        <g key={i}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke={GRID} />
          <text x={PAD.left - 8} y={y(v) + 3.5} textAnchor="end" fontSize="11" fill={FAINT} fontFamily={font}>{moneyCompact(v, currency)}</text>
        </g>
      ))}
      {labels.map((l, i) => {
        let acc = 0;
        const x = PAD.left + slot * i + (slot - bw) / 2;
        return (
          <g key={l + i}>
            {series.map((se) => {
              const v = Math.max(0, Number(se.values[i]) || 0);
              if (!v) return null;
              const r = <rect key={se.name} x={x} y={y(acc + v)} width={bw} height={Math.max(0.5, y(acc) - y(acc + v))} fill={se.colour}><title>{`${l} — ${se.name}: ${money(v, currency)}`}</title></rect>;
              acc += v;
              return r;
            })}
            {(i % every === 0 || i === n - 1) && (
              <text x={x + bw / 2} y={H - 9} textAnchor="middle" fontSize="11" fill={FAINT} fontFamily={font}>{l}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function SeriesLegend({ series = [] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 8, fontFamily: font, fontSize: 12, color: '#64748b' }}>
      {series.map((s) => (
        <span key={s.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: s.line ? 2 : 10, borderRadius: 2, background: s.colour, display: 'inline-block', ...(s.dashed ? { background: 'none', borderTop: `2px dashed ${s.colour}` } : {}) }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

/* ─── Two positions over time, the gap between them shaded ────────── */
/*
  What the business owns against what it owes, month end by month end. The
  space between is net worth: green where it owns more, red where it owes more.
*/
export function GapChart({ labels = [], a, b, currency = 'GBP', width = 600, height = 260 }) {
  const W = Math.max(260, Math.round(width));
  const H = height;
  const PAD = { top: 14, right: 12, bottom: 28, left: 56 };
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const n = labels.length;
  if (n < 2 || !a || !b) return null;
  const av = a.values.map((v) => (v == null ? null : Number(v)));
  const bv = b.values.map((v) => (v == null ? null : Number(v)));
  const all = [...av, ...bv].filter((v) => v != null);
  if (!all.length) return null;
  let lo = Math.min(0, ...all);
  let hi = Math.max(0, ...all);
  if (hi === lo) hi = lo + 1;
  const x = (i) => PAD.left + (i / (n - 1)) * iw;
  const y = (v) => PAD.top + ih - ((v - lo) / (hi - lo)) * ih;
  const every = labelStep(n, iw);
  const line = (vals) => vals.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label={`${a.name} against ${b.name}`}>
      {axisVals(lo, hi).map((v, i) => (
        <g key={i}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke={GRID} />
          <text x={PAD.left - 8} y={y(v) + 3.5} textAnchor="end" fontSize="11" fill={FAINT} fontFamily={font}>{moneyCompact(v, currency)}</text>
        </g>
      ))}
      {av.map((_, i) => {
        if (i === n - 1 || av[i] == null || bv[i] == null || av[i + 1] == null || bv[i + 1] == null) return null;
        const pos = (av[i] - bv[i]) + (av[i + 1] - bv[i + 1]) >= 0;
        return (
          <polygon
            key={i}
            points={`${x(i)},${y(av[i])} ${x(i + 1)},${y(av[i + 1])} ${x(i + 1)},${y(bv[i + 1])} ${x(i)},${y(bv[i])}`}
            fill={pos ? '#22c55e' : '#ef4444'} opacity="0.13"
          />
        );
      })}
      <polyline points={line(av)} fill="none" stroke={a.colour} strokeWidth="2" strokeLinejoin="round" />
      <polyline points={line(bv)} fill="none" stroke={b.colour} strokeWidth="2" strokeLinejoin="round" />
      {labels.map((l, i) => ((i % every === 0 || i === n - 1) ? (
        <text key={l + i} x={x(i)} y={H - 9} textAnchor={i === n - 1 ? 'end' : 'middle'} fontSize="11" fill={FAINT} fontFamily={font}>{l}</text>
      ) : null))}
    </svg>
  );
}

/* ─── Plain bars, coloured per bar ────────────────────────────────── */
export function SimpleBars({ points = [], currency = 'GBP', width = 600, height = 220 }) {
  const W = Math.max(260, Math.round(width));
  const H = height;
  const PAD = { top: 20, right: 10, bottom: 30, left: 56 };
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const n = points.length;
  if (!n) return null;
  let max = Math.max(0, ...points.map((p) => p.value || 0));
  if (!max) max = 1;
  const y = (v) => PAD.top + ih - (Math.max(0, v) / max) * ih;
  const slot = iw / n;
  const bw = Math.min(46, slot * 0.6);
  const every = labelStep(n, iw);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="bars">
      {axisVals(0, max).map((v, i) => (
        <g key={i}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke={GRID} />
          <text x={PAD.left - 8} y={y(v) + 3.5} textAnchor="end" fontSize="11" fill={FAINT} fontFamily={font}>{moneyCompact(v, currency)}</text>
        </g>
      ))}
      {points.map((p, i) => {
        const x = PAD.left + slot * i + (slot - bw) / 2;
        return (
          <g key={p.label + i}>
            <rect x={x} y={y(p.value)} width={bw} height={Math.max(p.value > 0 ? 1 : 0, y(0) - y(p.value))} rx="3" fill={p.colour || '#93c5fd'}>
              <title>{`${p.label}: ${money(p.value, currency)}`}</title>
            </rect>
            {p.value > 0 && n <= 12 && (
              <text x={x + bw / 2} y={y(p.value) - 5} textAnchor="middle" fontSize="10.5" fill="#64748b" fontFamily={font}>{moneyCompact(p.value, currency)}</text>
            )}
            {(i % every === 0 || i === n - 1) && (
              <text x={x + bw / 2} y={H - 10} textAnchor="middle" fontSize="11" fill={FAINT} fontFamily={font}>{p.label}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
