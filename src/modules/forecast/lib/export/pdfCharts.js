// Vector chart primitives for the PDF pack — drawn with jsPDF paths so
// they stay crisp at any zoom and add nothing to file size.
//
// Follows the dataviz method: validated categorical palette in fixed
// order (≤3 series per chart), one axis per chart, hairline solid
// gridlines, ~2px lines, area fills as a pre-blended wash (no alpha —
// prints reliably), selective direct labels, legend for ≥2 series,
// text always in ink/muted — never the series colour.

// Categorical slots (validated reference palette — first three clear
// all-pairs colour-vision checks; never reorder, never cycle).
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'];

const GRID = '#e1e0d9';
const AXIS = '#c3c2b7';
const MUTED = '#64748b';
const INK = '#0f172a';
const SURFACE = '#ffffff';

// Blend hex toward white — used for area washes (≈10% tint).
function tint(hex, keep = 0.12) {
  const n = hex.replace('#', '');
  const c = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16));
  const m = c.map(v => Math.round(255 - (255 - v) * keep));
  return '#' + m.map(v => v.toString(16).padStart(2, '0')).join('');
}

// Round a max value up to a "nice" tick step so axis labels are clean.
// A shallow negative minimum gets a fifth-step floor rather than a whole
// step, so a small loss doesn't waste a full band of plot height.
function niceScale(min, max, tickCount = 4) {
  if (max === min) max = min + 1;
  const span = max - min;
  const rawStep = span / tickCount;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const hi = Math.ceil(max / step) * step;
  let lo, ticks;
  if (min >= 0) {
    lo = Math.floor(min / step) * step;
    ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
  } else {
    // Bound the scale just below the shallowest negative, but only give
    // gridlines/labels to 0..hi — a tick at -£100k beside £0 collides.
    const minor = step / 5;
    lo = -Math.ceil(-min / minor) * minor;
    ticks = [];
    for (let v = 0; v <= hi + step / 2; v += step) ticks.push(v);
  }
  return { lo, hi, ticks };
}

export function fmtAxisMoney(p) {
  if (p == null) return '';
  const abs = Math.abs(p) / 100;
  const sign = p < 0 ? '-' : '';
  if (abs >= 1_000_000) return sign + '£' + trimZeros((abs / 1_000_000).toFixed(1)) + 'm';
  if (abs >= 1_000) return sign + '£' + trimZeros((abs / 1_000).toFixed(0)) + 'k';
  return sign + '£' + Math.round(abs);
}
const trimZeros = (s) => s.replace(/\.0$/, '');

// Legend is right-aligned to the chart's own right edge so it can never
// collide with a neighbouring chart's title.
function drawLegend(doc, rightX, y, series) {
  if (series.length < 2) return;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  const widths = series.map(s => 5.5 + doc.getTextWidth(s.label));
  let cx = rightX - (widths.reduce((a, b) => a + b, 0) + (series.length - 1) * 5);
  series.forEach((s, i) => {
    doc.setDrawColor(s.color);
    doc.setLineWidth(0.7);
    doc.line(cx, y - 1, cx + 4, y - 1);
    doc.setTextColor(MUTED);
    doc.text(s.label, cx + 5.5, y);
    cx += widths[i] + 5;
  });
}

function chartFrame(doc, { x, y, w, h, title, series }) {
  if (title) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(MUTED);
    doc.text(title.toUpperCase(), x, y + 3);
  }
  drawLegend(doc, x + w, y + 3, series || []);
  // Plot region below the title row; leave room for x labels at bottom
  // and y tick labels in the left gutter.
  return { px: x + 14, py: y + 7, pw: w - 15, ph: h - 13 };
}

function yAxis(doc, { px, py, pw, ph }, lo, hi, ticks, format) {
  const yFor = (v) => py + ph - ((v - lo) / (hi - lo)) * ph;
  doc.setFontSize(6);
  doc.setFont('helvetica', 'normal');
  for (const t of ticks) {
    const yy = yFor(t);
    doc.setDrawColor(t === 0 && lo < 0 ? AXIS : GRID);
    doc.setLineWidth(t === 0 && lo < 0 ? 0.25 : 0.15);
    doc.line(px, yy, px + pw, yy);
    doc.setTextColor(MUTED);
    doc.text(format(t), px - 1.5, yy + 0.8, { align: 'right' });
  }
  return yFor;
}

/**
 * Multi-series line chart (≤3 series).
 *
 * opts: { x, y, w, h, title, series: [{ label, color, values: number[] }],
 *         xLabelAt: (index) => string|null   — sparse tick labels,
 *         yFormat, fillFirst — wash under series[0],
 *         annotations: [{ series, index, text, below }] }
 */
export function drawLineChart(doc, opts) {
  const { series, xLabelAt, yFormat = fmtAxisMoney, fillFirst = false, annotations = [] } = opts;
  const frame = chartFrame(doc, opts);
  const { px, py, pw, ph } = frame;

  const n = Math.max(...series.map(s => s.values.length));
  const all = series.flatMap(s => s.values).filter(v => v != null && isFinite(v));
  const { lo, hi, ticks } = niceScale(Math.min(0, ...all), Math.max(...all, 1));
  const yFor = yAxis(doc, frame, lo, hi, ticks, yFormat);
  const xFor = (i) => px + (n <= 1 ? 0 : (i / (n - 1)) * pw);

  // X tick labels (sparse)
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6);
  doc.setTextColor(MUTED);
  for (let i = 0; i < n; i++) {
    const lbl = xLabelAt ? xLabelAt(i) : null;
    if (!lbl) continue;
    doc.text(lbl, xFor(i), py + ph + 3.4, { align: 'center' });
    doc.setDrawColor(AXIS);
    doc.setLineWidth(0.15);
    doc.line(xFor(i), py + ph, xFor(i), py + ph + 1);
  }
  // Baseline
  doc.setDrawColor(AXIS);
  doc.setLineWidth(0.25);
  doc.line(px, py + ph, px + pw, py + ph);

  // Area wash under the first series (pre-blended tint, no alpha)
  if (fillFirst && series[0]) {
    const vals = series[0].values;
    const zeroY = yFor(Math.max(lo, 0));
    doc.setFillColor(tint(series[0].color));
    const pts = [];
    for (let i = 0; i < vals.length; i++) pts.push([xFor(i), yFor(vals[i] ?? 0)]);
    // Build a closed polygon down to the zero line using relative segments.
    const start = pts[0];
    const segs = [];
    for (let i = 1; i < pts.length; i++) segs.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
    segs.push([0, zeroY - pts[pts.length - 1][1]]);
    segs.push([start[0] - pts[pts.length - 1][0], 0]);
    doc.lines(segs, start[0], start[1], [1, 1], 'F', true);
  }

  // Lines
  for (const s of series) {
    doc.setDrawColor(s.color);
    doc.setLineWidth(0.55);
    doc.setLineJoin('round');
    doc.setLineCap('round');
    for (let i = 1; i < s.values.length; i++) {
      if (s.values[i - 1] == null || s.values[i] == null) continue;
      doc.line(xFor(i - 1), yFor(s.values[i - 1]), xFor(i), yFor(s.values[i]));
    }
    // End marker with surface ring
    const lastIdx = s.values.length - 1;
    if (s.values[lastIdx] != null) {
      doc.setFillColor(SURFACE);
      doc.circle(xFor(lastIdx), yFor(s.values[lastIdx]), 1.15, 'F');
      doc.setFillColor(s.color);
      doc.circle(xFor(lastIdx), yFor(s.values[lastIdx]), 0.75, 'F');
    }
  }

  // Annotations — dot with surface ring + short label in ink
  for (const a of annotations) {
    const s = series[a.series || 0];
    if (!s || s.values[a.index] == null) continue;
    const ax = xFor(a.index), ay = yFor(s.values[a.index]);
    doc.setFillColor(SURFACE);
    doc.circle(ax, ay, 1.3, 'F');
    doc.setFillColor(s.color);
    doc.circle(ax, ay, 0.85, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6);
    doc.setTextColor(INK);
    // Keep the label inside the plot — flip above/below if it would land
    // outside, and clamp horizontally.
    let ty = a.below ? ay + 4 : ay - 2.4;
    if (ty > py + ph - 0.5) ty = ay - 2.4;
    if (ty < py + 2) ty = ay + 4;
    const tw = doc.getTextWidth(a.text);
    const tx = Math.min(Math.max(ax, px + tw / 2 + 1), px + pw - tw / 2 - 1);
    doc.text(a.text, tx, ty, { align: 'center' });
  }
}

/**
 * Grouped column chart (≤3 series).
 * opts: { x, y, w, h, title, groups: string[], series: [{label,color,values[]}], yFormat }
 */
export function drawColumnChart(doc, opts) {
  const { groups, series, yFormat = fmtAxisMoney } = opts;
  const frame = chartFrame(doc, opts);
  const { px, py, pw, ph } = frame;

  const all = series.flatMap(s => s.values).filter(v => v != null && isFinite(v));
  const { lo, hi, ticks } = niceScale(Math.min(0, ...all), Math.max(...all, 1));
  const yFor = yAxis(doc, frame, lo, hi, ticks, yFormat);

  const nG = groups.length;
  const slot = pw / nG;
  const gap = 0.5;                                        // surface gap between touching bars
  const barW = Math.min(6, (slot * 0.6 - gap * (series.length - 1)) / series.length);
  const groupW = barW * series.length + gap * (series.length - 1);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6);
  for (let g = 0; g < nG; g++) {
    const gx = px + g * slot + (slot - groupW) / 2;
    series.forEach((s, si) => {
      const v = s.values[g];
      if (v == null) return;
      const zeroY = yFor(Math.max(lo, 0));
      const vy = yFor(v);
      const top = Math.min(vy, zeroY);
      const hgt = Math.abs(zeroY - vy);
      doc.setFillColor(s.color);
      if (hgt > 1.2) {
        // Rounded data-end, square baseline: rounded rect + square patch over the base
        doc.roundedRect(gx + si * (barW + gap), top, barW, hgt, 0.8, 0.8, 'F');
        doc.rect(gx + si * (barW + gap), v >= 0 ? top + hgt - 1 : top, barW, 1, 'F');
      } else if (hgt > 0.05) {
        doc.rect(gx + si * (barW + gap), top, barW, hgt, 'F');
      }
    });
    doc.setTextColor(MUTED);
    doc.text(groups[g], px + g * slot + slot / 2, py + ph + 3.4, { align: 'center' });
  }
  doc.setDrawColor(AXIS);
  doc.setLineWidth(0.25);
  doc.line(px, yFor(Math.max(lo, 0)), px + pw, yFor(Math.max(lo, 0)));
}

/**
 * Horizontal stacked bars — one row per item, ≤3 segments.
 * opts: { x, y, w, h, title, rows: [{label, parts: number[]}],
 *         series: [{label, color}], valueFormat }
 * Total labelled at the bar end (ink); segments carry no inline numbers.
 */
export function drawStackedBars(doc, opts) {
  const { rows, series, valueFormat = fmtAxisMoney } = opts;
  const { x, y, w, h, title } = opts;
  if (title) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(MUTED);
    doc.text(title.toUpperCase(), x, y + 3);
  }
  drawLegend(doc, x + (title ? doc.getTextWidth(title.toUpperCase()) * 1.18 + 8 : 0), y + 3, series);

  const labelW = 24;
  const valueW = 16;
  const px = x + labelW, pw = w - labelW - valueW;
  const py = y + 7;
  const rowH = Math.min(9, (h - 9) / Math.max(1, rows.length));
  const barH = Math.min(5.5, rowH - 2.5);
  const maxTotal = Math.max(1, ...rows.map(r => r.parts.reduce((a, b) => a + (b || 0), 0)));

  rows.forEach((r, ri) => {
    const ry = py + ri * rowH;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(INK);
    doc.text(r.label, x, ry + barH / 2 + 1);
    let cx = px;
    const total = r.parts.reduce((a, b) => a + (b || 0), 0);
    r.parts.forEach((p, pi) => {
      const segW = (Math.max(0, p || 0) / maxTotal) * pw;
      if (segW <= 0.1) return;
      doc.setFillColor(series[pi].color);
      const isLast = pi === r.parts.length - 1 || r.parts.slice(pi + 1).every(v => !v);
      if (isLast && segW > 1.6) {
        doc.roundedRect(cx, ry, segW, barH, 0.8, 0.8, 'F');
        doc.rect(cx, ry, 1, barH, 'F');           // square the leading edge
      } else {
        doc.rect(cx, ry, segW, barH, 'F');
      }
      cx += segW + 0.5;                            // surface gap between segments
    });
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(INK);
    doc.text(valueFormat(total), cx + 1.5, ry + barH / 2 + 1);
  });
}
