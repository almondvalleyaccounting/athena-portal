// The fee-review letter for one client: a one-page PDF that explains
// the change with a waterfall from the old monthly fee to the new one,
// the service-by-service detail, and the VAT sum.
//
// Figures are monthly and net of VAT throughout, with the year shown
// alongside, and VAT only at the foot — the same presentation as the
// email table, so the two can never tell the client different things.
//
// jsPDF's built-in Helvetica is WinAnsi-encoded: "£" and "—" render,
// the Unicode minus sign does not, so negatives use a plain hyphen.

import { BUCKETS, visibleBuckets, OUR_FEES_FOOTNOTE, VAT_RATE, longDate, reasonText } from './repriceReasons';

const OCEAN_700 = [25, 58, 80];
const OCEAN_600 = [30, 69, 96];
const OCEAN_100 = [223, 236, 242];
const SLATE_50 = [248, 250, 252];
const GRAY = [120, 120, 120];
const DARK = [40, 40, 40];
const RULE = [226, 232, 240];
const RISE = [201, 138, 62];   // muted amber — an increase
const FALL = [47, 133, 90];    // green — a reduction

const FOOTER_TEXT = [
  'Almond Valley Accounting Limited',
  '14 Ellismuir House, Ellismuir Way, Tannochside, G71 5PW',
  'info@almondvalleyaccounting.co.uk  |  0141 471 4255',
];

const money = (n) => `£${Math.abs(Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (n) => (Number(n) > 0 ? `+${money(n)}` : Number(n) < 0 ? `-${money(n)}` : money(0));

let logoDataUrl = null;
async function getLogo() {
  if (logoDataUrl) return logoDataUrl;
  try {
    const blob = await (await fetch('/ava-logo.jpg')).blob();
    logoDataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
    return logoDataUrl;
  } catch { return null; }
}

// Build the letter. Returns the jsPDF document; callers choose between
// .save() (download) and base64 (email attachment).
export async function buildRepricePdf({ clientName, contactName, effectiveAt, lines, summary }) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF('p', 'mm', 'a4');
  const pw = 210, margin = 18, cw = pw - margin * 2;
  let y = margin;

  const newPage = () => { footer(doc, pw, margin, cw); doc.addPage(); y = margin; };
  const need = (h) => { if (y + h > 268) newPage(); };

  // ── Header ──
  const logo = await getLogo();
  if (logo) doc.addImage(logo, 'JPEG', pw - margin - 26, margin - 2, 26, 26);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(...OCEAN_700);
  doc.text(clientName || 'Client', margin, y + 7, { maxWidth: cw - 32 });
  y += 14;
  doc.setFontSize(13);
  doc.setTextColor(...OCEAN_600);
  doc.text('Your fee review', margin, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...GRAY);
  doc.text(`Prepared ${longDate(new Date().toISOString())}`, margin, y); y += 4;
  if (effectiveAt) { doc.text(`New fees apply from ${longDate(effectiveAt)}`, margin, y); y += 4; }
  y += 3;

  // ── Intro ──
  doc.setFontSize(10);
  doc.setTextColor(...DARK);
  const intro = `${contactName ? `Dear ${contactName}, t` : 'T'}his letter sets out how your monthly fee is changing, from ${money(summary.current)} to ${money(summary.next)} a month before VAT, and why. The chart shows where the difference comes from; the table beneath it lists each service.`;
  const introLines = doc.splitTextToSize(intro, cw);
  doc.text(introLines, margin, y);
  y += introLines.length * 4.6 + 3;

  // ── Headline tiles ──
  const tileW = (cw - 8) / 3, tileH = 18;
  const tiles = [
    { label: 'Current monthly fee', value: money(summary.current), sub: `${money(summary.current * 12)} a year` },
    { label: 'New monthly fee', value: money(summary.next), sub: `${money(summary.next * 12)} a year` },
    { label: 'Change', value: signed(summary.delta), sub: `${signed(summary.delta * 12)} a year` },
  ];
  tiles.forEach((t, i) => {
    const x = margin + i * (tileW + 4);
    doc.setFillColor(...SLATE_50);
    doc.setDrawColor(...RULE);
    doc.roundedRect(x, y, tileW, tileH, 2, 2, 'FD');
    doc.setFontSize(7.5); doc.setTextColor(...GRAY); doc.setFont('helvetica', 'normal');
    doc.text(t.label, x + 4, y + 5);
    doc.setFontSize(13); doc.setTextColor(...OCEAN_700); doc.setFont('helvetica', 'bold');
    doc.text(t.value, x + 4, y + 11.5);
    doc.setFontSize(7.5); doc.setTextColor(...GRAY); doc.setFont('helvetica', 'normal');
    doc.text(t.sub, x + 4, y + 15.5);
  });
  y += tileH + 4;
  doc.setFontSize(7); doc.setFont('helvetica', 'italic'); doc.setTextColor(...GRAY);
  doc.text('All figures exclude VAT unless stated.', margin + cw, y, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  y += 4;

  // ── Waterfall ──
  y = waterfall(doc, { x: margin, y, w: cw, h: 52, summary });
  y += 6;

  // ── Service detail ──
  need(30);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...OCEAN_700);
  doc.text('Service by service', margin, y); y += 5;

  const col = { svc: margin + 2, why: margin + 62, old: margin + cw - 40, neu: margin + cw - 20, chg: margin + cw - 2 };
  const head = () => {
    doc.setFillColor(...OCEAN_100);
    doc.rect(margin, y, cw, 6.5, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...OCEAN_700);
    doc.text('Service', col.svc, y + 4.4);
    doc.text('Reason', col.why, y + 4.4);
    doc.text('Was / month', col.old, y + 4.4, { align: 'right' });
    doc.text('Now / month', col.neu, y + 4.4, { align: 'right' });
    doc.text('Change', col.chg, y + 4.4, { align: 'right' });
    y += 6.5;
  };
  head();
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
  for (const l of lines) {
    const changed = Number(l.current) !== Number(l.next);
    const svc = doc.splitTextToSize(serviceName(l.serviceId), col.why - col.svc - 4);
    const why = doc.splitTextToSize(changed ? reasonText(l) : 'No change', col.old - 19 - col.why - 2);
    const h = Math.max(svc.length, why.length) * 3.8 + 3;
    if (y + h > 268) { newPage(); head(); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); }
    doc.setTextColor(...DARK);
    doc.text(svc, col.svc, y + 4);
    doc.setTextColor(...(changed ? DARK : GRAY));
    doc.text(why, col.why, y + 4);
    doc.setTextColor(...GRAY);
    doc.text(money(l.current), col.old, y + 4, { align: 'right' });
    doc.setTextColor(...DARK); doc.setFont('helvetica', 'bold');
    doc.text(money(l.next), col.neu, y + 4, { align: 'right' });
    const d = Number(l.next) - Number(l.current);
    doc.setTextColor(...(d > 0 ? RISE : d < 0 ? FALL : GRAY));
    doc.text(d === 0 ? '—' : signed(d), col.chg, y + 4, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    y += h;
    doc.setDrawColor(...RULE); doc.setLineWidth(0.2);
    doc.line(margin, y, margin + cw, y);
  }
  y += 6;

  // ── Summary with VAT ──
  // The table sits on the right; the footnote and closing note share the
  // left column beside it, which keeps a typical client to one page.
  need(62);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...OCEAN_700);
  doc.text('Summary', margin, y); y += 5;
  const sx = margin + cw * 0.42, mR = margin + cw - 28, aR = margin + cw - 2, sw = margin + cw - sx;
  const top = y;
  doc.setFontSize(7.5); doc.setTextColor(...GRAY); doc.setFont('helvetica', 'bold');
  doc.text('Per month', mR, y, { align: 'right' });
  doc.text('Per year', aR, y, { align: 'right' });
  y += 2;
  const row = (label, m, { bold = false, fill = null, sign = false, star = false } = {}) => {
    if (fill) { doc.setFillColor(...fill); doc.rect(sx, y, sw, 5.4, 'F'); }
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(8.5);
    doc.setTextColor(...(fill ? [255, 255, 255] : DARK));
    doc.text(`${label}${star ? ' *' : ''}`, sx + 2, y + 4);
    const fmt = (v) => (sign ? (v === 0 ? '—' : signed(v)) : money(v));
    doc.text(fmt(m), mR, y + 4, { align: 'right' });
    doc.text(fmt(m * 12), aR, y + 4, { align: 'right' });
    y += 5.4;
    if (!fill) { doc.setDrawColor(...RULE); doc.line(sx, y, sx + sw, y); }
  };
  row('Current fees', summary.current, { bold: true });
  for (const b of visibleBuckets(summary)) row(b.label, summary.buckets[b.key], { sign: true, star: b.star });
  row('New fees (net of VAT)', summary.next, { bold: true });
  row(`VAT at ${Math.round(VAT_RATE * 100)}%`, summary.vat);
  row('Total including VAT', summary.gross, { bold: true, fill: OCEAN_700 });
  const tableEnd = y;

  const lw = sx - margin - 8;
  let ly = top + 2;
  doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5); doc.setTextColor(...GRAY);
  const fn = doc.splitTextToSize(`* ${OUR_FEES_FOOTNOTE}`, lw);
  doc.text(fn, margin, ly); ly += fn.length * 3.3 + 5;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...DARK);
  const close = doc.splitTextToSize('If you would like to talk any of this through, just reply to our email or call us on 0141 471 4255 — we are always happy to explain how a fee is made up.', lw);
  doc.text(close, margin, ly); ly += close.length * 3.8;
  y = Math.max(tableEnd, ly);

  footer(doc, pw, margin, cw);
  return doc;
}

// "Accounts:Business Accounts and…" → "Business Accounts and…". QBO
// item names carry their category as a prefix the client never sees.
export function serviceName(serviceId) {
  const s = String(serviceId || 'Service');
  const i = s.lastIndexOf(':');
  return i >= 0 ? s.slice(i + 1).trim() : s;
}

// Waterfall from the current fee to the new one. Zero-based axis —
// starting the axis above zero would make a 9% rise look like a
// doubling, which is exactly what a client letter must not do. Middle
// bars are drawn only for buckets that moved.
function waterfall(doc, { x, y, w, h, summary }) {
  const steps = [
    { label: 'Current fee', kind: 'total', value: summary.current },
    ...BUCKETS.filter((b) => summary.buckets[b.key] !== 0).map((b) => ({
      label: b.star ? `${b.label} *` : b.label, kind: 'step', value: summary.buckets[b.key],
    })),
    { label: 'New fee', kind: 'total', value: summary.next },
  ];

  let run = 0;
  let peak = 0;
  const bars = steps.map((s) => {
    if (s.kind === 'total') { run = s.value; peak = Math.max(peak, run); return { ...s, from: 0, to: run }; }
    const from = run; run += s.value; peak = Math.max(peak, from, run);
    return { ...s, from, to: run };
  });
  peak = niceCeil(peak || 1);

  const labelH = 10, valueH = 5;
  const plotTop = y + valueH, plotBottom = y + h - labelH, plotH = plotBottom - plotTop;
  const axisL = x + 14;
  const plotW = x + w - axisL;
  const slot = plotW / bars.length;
  const barW = Math.min(22, slot * 0.62);
  const py = (v) => plotBottom - (v / peak) * plotH;

  doc.setLineWidth(0.15);
  doc.setFontSize(6.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...GRAY);
  // Gridlines + axis labels in whole pounds: as many steps (4, 3, 5 or 2)
  // as divide the axis evenly, so it never reads £133.33.
  const gridSteps = [4, 3, 5, 2].find((k) => Number.isInteger(peak / k)) || 4;
  for (let i = 0; i <= gridSteps; i++) {
    const v = (peak / gridSteps) * i;
    const gy = py(v);
    doc.setDrawColor(...RULE);
    doc.line(axisL, gy, x + w, gy);
    doc.text(money(v).replace('.00', ''), axisL - 2, gy + 1, { align: 'right' });
  }

  bars.forEach((b, i) => {
    const cx = axisL + slot * i + slot / 2;
    const top = py(Math.max(b.from, b.to));
    const bot = py(Math.min(b.from, b.to));
    const colour = b.kind === 'total' ? OCEAN_700 : b.value > 0 ? RISE : FALL;
    doc.setFillColor(...colour);
    doc.rect(cx - barW / 2, top, barW, Math.max(0.6, bot - top), 'F');

    // Connector to the next bar's starting level.
    if (i < bars.length - 1) {
      doc.setDrawColor(...GRAY); doc.setLineWidth(0.15);
      doc.setLineDashPattern([0.8, 0.8], 0);
      doc.line(cx + barW / 2, py(b.to), cx + slot - barW / 2, py(b.to));
      doc.setLineDashPattern([], 0);
    }

    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5);
    doc.setTextColor(...(b.kind === 'total' ? OCEAN_700 : colour));
    doc.text(b.kind === 'total' ? money(b.value) : signed(b.value), cx, top - 1.5, { align: 'center' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.8); doc.setTextColor(...DARK);
    doc.text(doc.splitTextToSize(b.label, slot - 2), cx, plotBottom + 4, { align: 'center' });
  });

  doc.setDrawColor(...GRAY); doc.setLineWidth(0.25);
  doc.line(axisL, plotBottom, x + w, plotBottom);
  doc.setFontSize(6.5); doc.setTextColor(...GRAY);
  doc.text('Monthly fee, excluding VAT', x, y + 1);
  return y + h;
}

function niceCeil(v) {
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * mag >= v * 1.08) return m * mag;
  return 10 * mag;
}

function footer(doc, pw, margin, cw) {
  const fy = 275;
  doc.setDrawColor(...OCEAN_100); doc.setLineWidth(0.3);
  doc.line(margin, fy, margin + cw, fy);
  doc.setFontSize(6); doc.setFont('helvetica', 'normal'); doc.setTextColor(...GRAY);
  FOOTER_TEXT.forEach((line, i) => doc.text(line, pw / 2, fy + 3.5 + i * 3, { align: 'center' }));
}

// Base64 (no data: prefix) for an email attachment.
export function pdfBase64(doc) {
  return doc.output('datauristring').split(',')[1];
}

export function pdfFilename(clientName) {
  const slug = String(clientName || 'Client').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `Fee-review-${slug}.pdf`;
}

