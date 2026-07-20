import React from 'react';
import { moneyCompact, shortMonth, OUTFIT } from './dashboardData';

/*
  Inline SVG charts for the Client Dashboard — no chart libraries.
  Pure components (data in via props) so they can be reused verbatim in a
  future client-safe portal view.
*/

/* ─── 12-month trend: revenue bars + net-profit line ───────────── */
export function TrendChart({ months = [], income = [], net = [], currency = 'GBP' }) {
  const W = 720, H = 250;
  const PAD = { top: 18, right: 12, bottom: 30, left: 52 };
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const n = months.length;
  if (!n) return null;

  const inc = months.map((_, i) => Number(income?.[i]) || 0);
  const nets = months.map((_, i) => Number(net?.[i]) || 0);
  const hasNet = Array.isArray(net) && net.length > 0;

  let max = Math.max(0, ...inc, ...(hasNet ? nets : [0]));
  let min = Math.min(0, ...(hasNet ? nets : [0]), ...inc);
  if (max === min) max = min + 1;
  const span = max - min;
  const y = (v) => PAD.top + ih - ((v - min) / span) * ih;
  const slot = iw / n;
  const barW = Math.min(34, slot * 0.55);
  const xMid = (i) => PAD.left + slot * i + slot / 2;

  // ~4 horizontal gridlines at round-ish values
  const gridVals = [];
  for (let g = 0; g <= 4; g++) gridVals.push(min + (span * g) / 4);

  const linePts = hasNet ? nets.map((v, i) => `${xMid(i)},${y(v)}`).join(' ') : null;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="12-month revenue and net profit trend">
      {gridVals.map((v, gi) => (
        <g key={gi}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="#f1f5f9" strokeWidth="1" />
          <text x={PAD.left - 8} y={y(v) + 3.5} textAnchor="end" fontSize="10" fill="#94a3b8" fontFamily={OUTFIT}>
            {moneyCompact(v, currency)}
          </text>
        </g>
      ))}
      {/* zero line if the range crosses zero */}
      {min < 0 && <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke="#cbd5e1" strokeWidth="1" />}

      {/* revenue bars */}
      {inc.map((v, i) => {
        const y0 = y(Math.max(0, v));
        const h = Math.abs(y(v) - y(0));
        return (
          <rect
            key={i}
            x={xMid(i) - barW / 2}
            y={v >= 0 ? y0 : y(0)}
            width={barW}
            height={Math.max(h, v === 0 ? 0 : 1)}
            rx="3"
            fill="#bae6fd"
          >
            <title>{`${months[i]} — income ${moneyCompact(v, currency)}`}</title>
          </rect>
        );
      })}

      {/* net income line + dots */}
      {linePts && <polyline points={linePts} fill="none" stroke="#0f172a" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
      {hasNet && nets.map((v, i) => (
        <circle key={i} cx={xMid(i)} cy={y(v)} r="3" fill={v >= 0 ? '#166534' : '#991b1b'} stroke="#ffffff" strokeWidth="1">
          <title>{`${months[i]} — net ${moneyCompact(v, currency)}`}</title>
        </circle>
      ))}

      {/* month labels */}
      {months.map((m, i) => (
        <text key={i} x={xMid(i)} y={H - 10} textAnchor="middle" fontSize="10" fill="#94a3b8" fontFamily={OUTFIT}>
          {shortMonth(m)}
        </text>
      ))}
    </svg>
  );
}

/* ─── Sparkline for portfolio cards ────────────────────────────── */
export function Sparkline({ values = [], width = 140, height = 36, stroke = '#38bdf8' }) {
  const pts = (values || []).map((v) => Number(v) || 0);
  if (pts.length < 2) return null;
  const max = Math.max(...pts);
  const min = Math.min(...pts, 0);
  const span = max - min || 1;
  const P = 3;
  const x = (i) => P + (i / (pts.length - 1)) * (width - 2 * P);
  const y = (v) => P + (1 - (v - min) / span) * (height - 2 * P);
  const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${x(0).toFixed(1)},${y(min).toFixed(1)} ${line} ${x(pts.length - 1).toFixed(1)},${y(min).toFixed(1)}`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: `${width}px`, height: `${height}px`, display: 'block' }} aria-hidden="true">
      <polygon points={area} fill="#e0f2fe" opacity="0.7" />
      <polyline points={line} fill="none" stroke={stroke} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
