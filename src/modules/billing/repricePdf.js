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

import { BUCKETS, OUR_FEES_FOOTNOTE, PART_TITLE, longDate, reasonText, summaryRows, partFor } from './repriceReasons';
import { KIND_TITLE } from './composeRepriceEmail';

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
//
// kind 'notice' tells the client what is changing. kind 'proposal' also
// proposes new services: Part 1 is the changes we're making, Part 2 the
// new services for the client to accept.
export async function buildRepricePdf({ kind = 'notice', clientName, contactName, effectiveAt, lines, summary, acceptUrl = null }) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF('p', 'mm', 'a4');
  const pw = 210, margin = 18, cw = pw - margin * 2;
  let y = margin;
  const proposal = kind === 'proposal';
  const when = effectiveAt ? longDate(effectiveAt) : 'next month';

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
  doc.text(KIND_TITLE[kind] || KIND_TITLE.notice, margin, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...GRAY);
  doc.text(`${longDate(new Date().toISOString())}  ·  New fees from ${when}`, margin, y);
  y += 7;

  // ── Intro ──
  doc.setFontSize(10);
  doc.setTextColor(...DARK);
  const greeting = contactName ? `Dear ${contactName}, ` : '';
  const intro = proposal
    ? `${greeting}from ${when} we're making some changes to your fees (Part 1), and we'd like to add some new services (Part 2). If you accept, your monthly fee will go from ${money(summary.current)} to ${money(summary.next)}, plus VAT.`
    : `${greeting}from ${when}, your monthly fee will go from ${money(summary.current)} to ${money(summary.next)}, plus VAT. Here's what is changing and why.`;
  const introLines = doc.splitTextToSize(intro.charAt(0).toUpperCase() + intro.slice(1), cw);
  doc.text(introLines, margin, y);
  y += introLines.length * 4.6 + 4;

  // ── Headline tiles ──
  const tileW = (cw - 8) / 3, tileH = 18;
  const tiles = [
    { label: 'Current monthly fee', value: money(summary.current), sub: `excl. VAT · ${money(summary.current * 12)} a year` },
    { label: 'New monthly fee', value: money(summary.next), sub: `excl. VAT · ${money(summary.next * 12)} a year` },
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
  y += tileH + 6;

  // ── Waterfall ──
  y = waterfall(doc, { x: margin, y, w: cw, h: 52, summary });
  y += 6;

  // ── Line by line ──
  const col = { svc: margin + 2, why: margin + 62, old: margin + cw - 40, neu: margin + cw - 20, chg: margin + cw - 2 };
  const head = () => {
    doc.setFillColor(...OCEAN_100);
    doc.rect(margin, y, cw, 6.5, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...OCEAN_700);
    doc.text('Service', col.svc, y + 4.4);
    doc.text('Reason', col.why, y + 4.4);
    doc.text('Current', col.old, y + 4.4, { align: 'right' });
    doc.text('New', col.neu, y + 4.4, { align: 'right' });
    doc.text('Change', col.chg, y + 4.4, { align: 'right' });
    y += 6.5;
  };
  const table = (title, rows) => {
    need(24);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...OCEAN_700);
    doc.text(title, margin, y); y += 5;
    head();
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
    for (const l of rows) {
      const changed = Number(l.current) !== Number(l.next);
      const svc = doc.splitTextToSize(serviceName(l.serviceId), col.why - col.svc - 4);
      // How a quantity-priced service was built, e.g. "Quarterly management
      // accounts: 4 sets a year at £158.00" — under the service name.
      doc.setFontSize(7.5);
      const built = l.build?.description ? doc.splitTextToSize(l.build.description, col.why - col.svc - 4) : [];
      doc.setFontSize(8.5);
      const why = doc.splitTextToSize(changed ? reasonText(l) : 'No change', col.old - 19 - col.why - 2);
      const h = Math.max(svc.length * 3.8 + built.length * 3.3, why.length * 3.8) + 3;
      if (y + h > 268) { newPage(); head(); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); }
      doc.setTextColor(...DARK);
      doc.text(svc, col.svc, y + 4);
      if (built.length) {
        doc.setFontSize(7.5); doc.setTextColor(...GRAY);
        doc.text(built, col.svc, y + 4 + svc.length * 3.8);
        doc.setFontSize(8.5);
      }
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
  };
  if (proposal) {
    const p1 = lines.filter((l) => partFor(l) === 1);
    const p2 = lines.filter((l) => partFor(l) === 2);
    if (p1.length) table(PART_TITLE[1], p1);
    if (p2.length) table(PART_TITLE[2], p2);
  } else {
    table("What's changing", lines);
  }

  // ── Summary with VAT ──
  // Table on the right; the footnote and next step share the left column.
  const rows = summaryRows(summary, kind);
  const rowH = 5.4;
  need(rows.length * rowH + 14);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...OCEAN_700);
  doc.text('Summary', margin, y); y += 5;
  const sx = margin + cw * 0.42, mR = margin + cw - 28, aR = margin + cw - 2, sw = margin + cw - sx;
  const top = y;
  doc.setFontSize(7.5); doc.setTextColor(...GRAY); doc.setFont('helvetica', 'bold');
  doc.text('Per month', mR, y, { align: 'right' });
  doc.text('Per year', aR, y, { align: 'right' });
  y += 2;
  for (const r of rows) {
    if (r.type === 'section') {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...OCEAN_700);
      doc.text(r.label, sx + 2, y + 4);
      y += rowH;
      continue;
    }
    const fill = r.type === 'grand' ? OCEAN_700 : null;
    if (fill) { doc.setFillColor(...fill); doc.rect(sx, y, sw, rowH, 'F'); }
    const bold = r.type === 'total' || r.type === 'subtotal' || r.type === 'grand';
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(8.5);
    doc.setTextColor(...(fill ? [255, 255, 255] : DARK));
    doc.text(`${r.type === 'step' ? '   ' : ''}${r.label}${r.star ? ' *' : ''}`, sx + 2, y + 4);
    const fmt = (v) => (r.type === 'step' ? (v === 0 ? '—' : signed(v)) : money(v));
    doc.text(fmt(r.v), mR, y + 4, { align: 'right' });
    doc.text(fmt(r.v * 12), aR, y + 4, { align: 'right' });
    y += rowH;
    if (!fill) { doc.setDrawColor(...RULE); doc.line(sx, y, sx + sw, y); }
  }
  const tableEnd = y;

  const lw = sx - margin - 8;
  let ly = top + 2;
  if (proposal) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...OCEAN_700);
    const accept = doc.splitTextToSize(`To accept the new services in Part 2, click Review and accept in our email${acceptUrl ? ', or use the link below' : ''}. The changes in Part 1 go ahead from ${when} either way.`, lw);
    doc.text(accept, margin, ly); ly += accept.length * 4 + 2;
    if (acceptUrl) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(30, 69, 96);
      doc.textWithLink('Review and accept online', margin, ly + 3, { url: acceptUrl });
      ly += 8;
    } else {
      ly += 2;
    }
  }
  doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5); doc.setTextColor(...GRAY);
  const fn = doc.splitTextToSize(`* ${OUR_FEES_FOOTNOTE}`, lw);
  doc.text(fn, margin, ly); ly += fn.length * 3.3 + 4;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...DARK);
  const close = doc.splitTextToSize('Any questions? Reply to our email or call us on 0141 471 4255.', lw);
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

