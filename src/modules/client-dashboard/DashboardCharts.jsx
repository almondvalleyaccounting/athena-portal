import React from 'react';
import { moneyCompact, OUTFIT } from './dashboardData';

/*
  Inline SVG charts for the Client Dashboard — no chart libraries.
  Pure components (data in via props) so they are reused verbatim in the
  client-portal view, which has no Athena code available to it.
*/

/* ─── Revenue bars + net-profit line, over arbitrary buckets ───── */
/*
  points        [{ label, income, net }] — one entry per bucket, oldest first.
                Buckets are months, quarters or years depending on the
                Overview's grain toggle, so nothing here may assume months.
  width         the pixel width the chart will be drawn at, where the caller
                knows it. The SVG then maps 1:1 and its 11px labels stay 11px —
                without it the 720-unit drawing is scaled to fit, so text is
                microscopic on a phone and oversized on a wide monitor.
  forecastFrom  index of the first FORECAST bucket (null = all actual). From
                that point the bars go hollow and the line dashes, with a
                divider on the boundary — the Projection tab shows actuals and
                forecast on one axis and the eye needs to know where the
                evidence stops.
*/
export function BucketChart({
  points = [], currency = 'GBP', forecastFrom = null, height = 250,
  incomeLabel = 'revenue', netLabel = 'net profit', width = null,
}) {
  const W = width && width > 200 ? Math.round(width) : 720;
  const H = height;
  const PAD = { top: 18, right: 12, bottom: 30, left: 56 };
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const n = points.length;
  if (!n) return null;

  const inc = points.map((p) => Number(p?.income) || 0);
  const nets = points.map((p) => Number(p?.net) || 0);
  const hasNet = points.some((p) => p?.net !== null && p?.net !== undefined);
  // Last year's turnover, drawn faintly behind this year's bars. A bucket the
  // caller could not fill (null) breaks the line rather than reading as zero.
  const priors = points.map((p) => (p?.priorIncome == null ? null : Number(p.priorIncome)));
  const hasPrior = priors.some((v) => v != null);

  let max = Math.max(0, ...inc, ...(hasNet ? nets : [0]), ...(hasPrior ? priors.filter((v) => v != null) : [0]));
  let min = Math.min(0, ...(hasNet ? nets : [0]), ...inc);
  if (max === min) max = min + 1;
  const span = max - min;
  const y = (v) => PAD.top + ih - ((v - min) / span) * ih;
  const slot = iw / n;
  const barW = Math.min(width ? 44 : 34, slot * 0.55);
  const xMid = (i) => PAD.left + slot * i + slot / 2;
  const isFc = (i) => forecastFrom != null && i >= forecastFrom;

  const gridVals = [];
  for (let g = 0; g <= 4; g++) gridVals.push(min + (span * g) / 4);

  // Split the net line so the actual and forecast halves can be styled apart
  // while still joining up across the boundary.
  const pts = nets.map((v, i) => `${xMid(i)},${y(v)}`);
  const splitAt = forecastFrom == null ? n : forecastFrom;
  const actualPts = pts.slice(0, splitAt).join(' ');
  const fcPts = pts.slice(Math.max(0, splitAt - 1)).join(' ');

  // Thin the labels when there are more buckets than will fit legibly — about
  // one per 52px, which holds "Sep 25" or "Q3 25" without collisions.
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 52))));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label={`${incomeLabel} and ${netLabel} by period`}>
      <defs>
        <pattern id="fcHatch" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
          <rect width="5" height="5" fill="#f0f9ff" />
          <line x1="0" y1="0" x2="0" y2="5" stroke="#bae6fd" strokeWidth="2.5" />
        </pattern>
      </defs>

      {gridVals.map((v, gi) => (
        <g key={gi}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="#f1f5f9" strokeWidth="1" />
          <text x={PAD.left - 8} y={y(v) + 3.5} textAnchor="end" fontSize="11" fill="#94a3b8" fontFamily={OUTFIT}>
            {moneyCompact(v, currency)}
          </text>
        </g>
      ))}
      {min < 0 && <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke="#cbd5e1" strokeWidth="1" />}

      {/* Actual / forecast divider */}
      {forecastFrom != null && forecastFrom > 0 && forecastFrom < n && (
        <g>
          <line
            x1={PAD.left + slot * forecastFrom} x2={PAD.left + slot * forecastFrom}
            y1={PAD.top - 6} y2={PAD.top + ih}
            stroke="#94a3b8" strokeWidth="1" strokeDasharray="3 3"
          />
          <text x={PAD.left + slot * forecastFrom + 4} y={PAD.top - 8} fontSize="10.5" fill="#94a3b8" fontFamily={OUTFIT}>
            forecast
          </text>
        </g>
      )}

      {/* Revenue bars */}
      {inc.map((v, i) => {
        const h = Math.abs(y(v) - y(0));
        return (
          <rect
            key={i}
            x={xMid(i) - barW / 2}
            y={v >= 0 ? y(v) : y(0)}
            width={barW}
            height={Math.max(h, v === 0 ? 0 : 1)}
            rx="3"
            fill={isFc(i) ? 'url(#fcHatch)' : '#bae6fd'}
            stroke={isFc(i) ? '#bae6fd' : 'none'}
            strokeWidth={isFc(i) ? 1 : 0}
          >
            <title>{`${points[i].label} — ${incomeLabel} ${moneyCompact(v, currency)}${isFc(i) ? ' (forecast)' : ''}`}</title>
          </rect>
        );
      })}

      {/* Last year's turnover */}
      {hasPrior && (() => {
        const segs = [];
        let cur = [];
        priors.forEach((v, i) => {
          if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(`${xMid(i)},${y(v)}`);
        });
        if (cur.length) segs.push(cur);
        return segs.map((seg, si) => (
          <polyline key={si} points={seg.join(' ')} fill="none" stroke="#7dd3fc" strokeWidth="2" strokeDasharray="4 3" opacity="0.9" strokeLinejoin="round" />
        ));
      })()}
      {hasPrior && priors.map((v, i) => (v == null ? null : (
        <circle key={`p${i}`} cx={xMid(i)} cy={y(v)} r="2.2" fill="#ffffff" stroke="#7dd3fc" strokeWidth="1.2">
          <title>{`${points[i].label} — ${incomeLabel} a year earlier ${moneyCompact(v, currency)}`}</title>
        </circle>
      )))}

      {/* Net profit line */}
      {hasNet && splitAt > 1 && (
        <polyline points={actualPts} fill="none" stroke="#0f172a" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      )}
      {hasNet && forecastFrom != null && splitAt < n && (
        <polyline points={fcPts} fill="none" stroke="#0f172a" strokeWidth="2" strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" opacity="0.65" />
      )}
      {hasNet && nets.map((v, i) => (
        <circle
          key={i} cx={xMid(i)} cy={y(v)} r="3"
          fill={isFc(i) ? '#ffffff' : (v >= 0 ? '#166534' : '#991b1b')}
          stroke={isFc(i) ? (v >= 0 ? '#166534' : '#991b1b') : '#ffffff'} strokeWidth="1.4"
        >
          <title>{`${points[i].label} — ${netLabel} ${moneyCompact(v, currency)}${isFc(i) ? ' (forecast)' : ''}`}</title>
        </circle>
      ))}

      {/* Bucket labels */}
      {points.map((p, i) => (
        (i % labelEvery === 0 || i === n - 1) ? (
          <text key={i} x={xMid(i)} y={H - 10} textAnchor="middle" fontSize="11" fill="#94a3b8" fontFamily={OUTFIT}>
            {p.label}
          </text>
        ) : null
      ))}
    </svg>
  );
}

/* ─── Single-series line, for cash / balance-sheet trends ──────── */
/*
  format    value → axis text (default money). A KPI or a day count passes its own.
  target    a horizontal reference line, drawn when the value is set.
  band      { lo: [], hi: [] } — a shaded range around the line, per point.
  markMin   ring and label the lowest point (the projected cash low).
*/
export function LineChart({
  points = [], currency = 'GBP', forecastFrom = null, height = 200, colour = '#0284c7', width = null,
  format = null, target = null, band = null, markMin = false,
}) {
  const fmt = format || ((v) => moneyCompact(v, currency));
  const W = width && width > 200 ? Math.round(width) : 720;
  const H = height;
  const PAD = { top: 16, right: 12, bottom: 28, left: 56 };
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const n = points.length;
  if (!n) return null;

  const vals = points.map((p) => Number(p?.value) || 0);
  const extra = [
    ...(target != null ? [Number(target)] : []),
    ...(band ? [...(band.lo || []), ...(band.hi || [])].filter((v) => v != null).map(Number) : []),
  ];
  let max = Math.max(0, ...vals, ...extra);
  let min = Math.min(0, ...vals, ...extra);
  if (max === min) max = min + 1;
  const span = max - min;
  const y = (v) => PAD.top + ih - ((v - min) / span) * ih;
  const x = (i) => PAD.left + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);

  const pts = vals.map((v, i) => `${x(i)},${y(v)}`);
  const splitAt = forecastFrom == null ? n : forecastFrom;
  const gridVals = [];
  for (let g = 0; g <= 4; g++) gridVals.push(min + (span * g) / 4);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 52))));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="trend">
      {gridVals.map((v, gi) => (
        <g key={gi}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="#f1f5f9" strokeWidth="1" />
          <text x={PAD.left - 8} y={y(v) + 3.5} textAnchor="end" fontSize="11" fill="#94a3b8" fontFamily={OUTFIT}>
            {fmt(v)}
          </text>
        </g>
      ))}
      {min < 0 && <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke="#fca5a5" strokeWidth="1" />}
      {band && (() => {
        const idx = vals.map((_, i) => i).filter((i) => band.lo?.[i] != null && band.hi?.[i] != null);
        if (idx.length < 2) return null;
        const up = idx.map((i) => `${x(i)},${y(Number(band.hi[i]))}`);
        const down = [...idx].reverse().map((i) => `${x(i)},${y(Number(band.lo[i]))}`);
        return <polygon points={[...up, ...down].join(' ')} fill={colour} opacity="0.12" />;
      })()}
      {target != null && (
        <g>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(Number(target))} y2={y(Number(target))} stroke="#16a34a" strokeWidth="1.2" strokeDasharray="6 4" />
          <text x={W - PAD.right} y={y(Number(target)) - 4} textAnchor="end" fontSize="10.5" fill="#16a34a" fontFamily={OUTFIT}>target {fmt(Number(target))}</text>
        </g>
      )}
      {forecastFrom != null && forecastFrom > 0 && forecastFrom < n && (
        <line x1={x(forecastFrom)} x2={x(forecastFrom)} y1={PAD.top} y2={PAD.top + ih} stroke="#94a3b8" strokeWidth="1" strokeDasharray="3 3" />
      )}
      {splitAt > 1 && <polyline points={pts.slice(0, splitAt).join(' ')} fill="none" stroke={colour} strokeWidth="2" strokeLinejoin="round" />}
      {forecastFrom != null && splitAt < n && (
        <polyline points={pts.slice(Math.max(0, splitAt - 1)).join(' ')} fill="none" stroke={colour} strokeWidth="2" strokeDasharray="5 4" opacity="0.65" strokeLinejoin="round" />
      )}
      {vals.map((v, i) => (
        <circle key={i} cx={x(i)} cy={y(v)} r="2.6" fill={i >= splitAt ? '#ffffff' : colour} stroke={colour} strokeWidth="1.3">
          <title>{`${points[i].label} — ${fmt(v)}`}</title>
        </circle>
      ))}
      {markMin && n > 1 && (() => {
        const i = vals.indexOf(Math.min(...vals));
        const right = x(i) > W - 130;
        // Below the ring unless that would run into the month labels.
        const below = y(vals[i]) + 16 < PAD.top + ih - 2;
        return (
          <g>
            <circle cx={x(i)} cy={y(vals[i])} r="6" fill="none" stroke="#b91c1c" strokeWidth="1.6" />
            <text x={x(i) + (right ? -9 : 9)} y={below ? y(vals[i]) + 16 : y(vals[i]) - 10} textAnchor={right ? 'end' : 'start'} fontSize="11" fontWeight="700" fill="#b91c1c" fontFamily={OUTFIT}>
              Lowest {fmt(vals[i])} · {points[i].label}
            </text>
          </g>
        );
      })()}
      {points.map((p, i) => (
        (i % labelEvery === 0 || i === n - 1) ? (
          // The last point sits on the right edge: anchor its label there so it is not cut off.
          <text key={i} x={x(i)} y={H - 9} textAnchor={i === n - 1 && n > 1 ? 'end' : 'middle'} fontSize="11" fill="#94a3b8" fontFamily={OUTFIT}>{p.label}</text>
        ) : null
      ))}
    </svg>
  );
}

/* ─── Sparkline for portfolio cards ────────────────────────────── */
// zeroBase: scale from zero (portfolio cards, where size matters). Off, the
// line uses its own range — a tile's trend, where the direction is the point.
export function Sparkline({ values = [], width = 140, height = 36, stroke = '#38bdf8', zeroBase = true }) {
  const pts = (values || []).map((v) => Number(v) || 0);
  if (pts.length < 2) return null;
  const max = Math.max(...pts);
  const min = zeroBase ? Math.min(...pts, 0) : Math.min(...pts);
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
