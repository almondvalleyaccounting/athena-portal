// The fee-review letter for one client: a two-page PDF. Page 1 explains
// the change with a waterfall from the old monthly fee to the new one and
// the VAT sum; page 2 has the service-by-service detail.
//
// Figures are monthly and net of VAT throughout, with the year shown
// alongside, and VAT only at the foot — the same presentation as the
// email table, so the two can never tell the client different things.
//
// jsPDF's built-in Helvetica is WinAnsi-encoded: "£" and "—" render,
// the Unicode minus sign does not, so negatives use a plain hyphen.

import { BUCKETS, OUR_FEES_FOOTNOTE, PART_TITLE, longDate, summaryRows, partFor, componentsOf, changeLabel } from './repriceReasons';
import { KIND_TITLE, hasInflationRise, proposalOpening } from './composeRepriceEmail';
import { serviceName, clientServiceName } from './repriceReasons';

// Kept exported from here for existing callers.
export { serviceName, clientServiceName };

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
// Page 1 is the letter: the opening, the headline figures, the waterfall
// and the summary with VAT and how to accept — the whole story without
// turning over. Page 2 is service by service.
//
// kind 'notice' tells the client what is changing. kind 'proposal' also
// proposes new services: Part 1 is the changes we're making, Part 2 the
// new services for the client to accept.
//
// A proposal opens in the practice's own words (proposalOpening).
// clientRequested notes the client asked about the new services;
// lastReviewed ("March 2024") adds when we last reviewed their fees, when
// there's an inflation rise to explain.
export async function buildRepricePdf({ kind = 'notice', clientName, contactName, effectiveAt, lines, summary, acceptUrl = null, clientRequested = false, lastReviewed = null }) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF('p', 'mm', 'a4');
  const pw = 210, margin = 18, cw = pw - margin * 2;
  let y = margin;
  const proposal = kind === 'proposal';
  const when = effectiveAt ? longDate(effectiveAt) : 'next month';

  const newPage = () => { footer(doc, pw, margin, cw); doc.addPage(); y = margin; };
  const need = (h) => { if (y + h > 268) newPage(); };

  // ── Letterhead: logo and date on the right, who and what on the left ──
  const logo = await getLogo();
  if (logo) doc.addImage(logo, 'JPEG', pw - margin - 24, margin - 4, 24, 24);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...GRAY);
  doc.text(longDate(new Date().toISOString()), pw - margin, margin + 25, { align: 'right' });

  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...OCEAN_700);
  const nameLines = doc.splitTextToSize(clientName || 'Client', cw - 40);
  doc.text(nameLines, margin, y + 5);
  y += 5 + nameLines.length * 6;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(...OCEAN_600);
  doc.text(KIND_TITLE[kind] || KIND_TITLE.notice, margin, y);
  y = Math.max(y + 6, margin + 32);

  // ── The letter: greeting on its own line, then short paragraphs ──
  const para = (text, gap = 3.2) => {
    const ls = doc.splitTextToSize(text, cw);
    doc.text(ls, margin, y);
    y += ls.length * 4.8 + gap;
  };
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...DARK);
  para(contactName ? `Dear ${contactName},` : 'Dear client,', 2.2);
  const hasInflation = hasInflationRise(lines);
  if (proposal) {
    const paras = proposalOpening({ when, current: summary.current, next: summary.next, clientRequested, lastReviewed: hasInflation ? lastReviewed : null });
    paras.forEach((t, i) => para(t, i === paras.length - 1 ? 5 : 3.2));
  } else {
    if (hasInflation && lastReviewed) {
      para(`We last reviewed your fees in ${lastReviewed}. Our costs have risen with inflation since then, so from ${when} we are making the changes below.`);
    }
    para(`From ${when}, your monthly fee will go from ${money(summary.current)} to ${money(summary.next)} plus VAT.`, 5);
  }

  // ── Headline tiles ──
  const tileW = (cw - 8) / 3, tileH = 17;
  const tiles = [
    { label: 'Current monthly fee', value: money(summary.current), sub: `excl. VAT · ${money(summary.current * 12)} a year` },
    { label: proposal ? 'New monthly fee if you accept' : 'New monthly fee', value: money(summary.next), sub: `excl. VAT · ${money(summary.next * 12)} a year` },
    { label: 'Change', value: signed(summary.delta), sub: `${signed(summary.delta * 12)} a year` },
  ];
  tiles.forEach((t, i) => {
    const x = margin + i * (tileW + 4);
    doc.setFillColor(...SLATE_50); doc.setDrawColor(...RULE);
    doc.roundedRect(x, y, tileW, tileH, 2, 2, 'FD');
    doc.setFontSize(7.5); doc.setTextColor(...GRAY); doc.setFont('helvetica', 'normal');
    doc.text(t.label, x + 4, y + 5);
    doc.setFontSize(13); doc.setTextColor(...OCEAN_700); doc.setFont('helvetica', 'bold');
    doc.text(t.value, x + 4, y + 11);
    doc.setFontSize(7.5); doc.setTextColor(...GRAY); doc.setFont('helvetica', 'normal');
    doc.text(t.sub, x + 4, y + 15);
  });
  y += tileH + 7;

  // ── Waterfall ──
  y = waterfall(doc, { x: margin, y, w: cw, h: 46, summary });
  y += 8;

  // ── Summary with VAT, on page 1: the whole story without turning over ──
  const rows = summaryRows(summary, kind).filter((r) => r.type !== 'step' || r.v !== 0);
  // A part with nothing in it loses its heading (and Part 1 its subtotal).
  const tidy = rows.filter((r, i) => r.type !== 'section' || (rows[i + 1] && rows[i + 1].type === 'step'));
  const p1Empty = !tidy.some((r) => r.type === 'section' && r.label.startsWith('Part 1'));
  const finalRows = p1Empty ? tidy.filter((r) => r.type !== 'subtotal') : tidy;
  const rowH = 5.4;
  need(finalRows.length * rowH + 14);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...OCEAN_700);
  doc.text('Summary', margin, y); y += 5;
  const sx = margin + cw * 0.42, mR = margin + cw - 28, aR = margin + cw - 2, sw = margin + cw - sx;
  const top = y;
  doc.setFontSize(7.5); doc.setTextColor(...GRAY); doc.setFont('helvetica', 'bold');
  doc.text('Per month', mR, y, { align: 'right' });
  doc.text('Per year', aR, y, { align: 'right' });
  y += 2;
  for (const r of finalRows) {
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
    const fmt = (v) => (r.type === 'step' ? signed(v) : money(v));
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
    const accept = doc.splitTextToSize(`To accept the new services, click Review and accept in our email${acceptUrl ? ', or use the button below' : ''}. The changes in Part 1 go ahead from ${when} either way.`, lw);
    doc.text(accept, margin, ly); ly += accept.length * 4 + 2;
    // The accept link as a button, the one thing on the page to click.
    // Before the letter is sent there is no link yet, so the preview shows
    // where it will go.
    const bh = 10, bw = Math.min(lw, 70);
    if (acceptUrl) {
      doc.setFillColor(...OCEAN_700);
      doc.roundedRect(margin, ly, bw, bh, 2, 2, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(255, 255, 255);
      doc.text('Review and accept online', margin + bw / 2, ly + 6.6, { align: 'center' });
      doc.link(margin, ly, bw, bh, { url: acceptUrl });
    } else {
      doc.setDrawColor(...GRAY); doc.setLineWidth(0.3);
      doc.setLineDashPattern([1.2, 1.2], 0);
      doc.roundedRect(margin, ly, bw, bh, 2, 2, 'S');
      doc.setLineDashPattern([], 0);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...GRAY);
      doc.text('Accept button: added when sent', margin + bw / 2, ly + 6.3, { align: 'center' });
    }
    ly += bh + 5;
  }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...DARK);
  const over = doc.splitTextToSize('The detail for each service is overleaf.', lw);
  doc.text(over, margin, ly); ly += over.length * 3.8 + 3;
  // A proposal's letter already closes with "get in touch"; a notice's doesn't.
  if (!proposal) {
    const close = doc.splitTextToSize('Any questions? Reply to our email or call us on 0141 471 4255.', lw);
    doc.text(close, margin, ly); ly += close.length * 3.8;
  }
  ly += 4;
  if (finalRows.some((r) => r.star)) {
    doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5); doc.setTextColor(...GRAY);
    const fn = doc.splitTextToSize(`* ${OUR_FEES_FOOTNOTE}`, lw);
    doc.text(fn, margin, ly); ly += fn.length * 3.3;
  }
  y = Math.max(tableEnd, ly);

  // ── Page 2: service by service ──
  newPage();
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...OCEAN_700);
  doc.text('Service by service', margin, y + 4);
  y += 9.5;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...GRAY);
  doc.text('Monthly fees, excluding VAT.', margin, y + 1);
  y += 8;

  const col = { svc: margin + 2, why: margin + 58, old: margin + cw - 40, neu: margin + cw - 20, chg: margin + cw - 2 };
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
  // One reason per line; the amount beside it only when a line has several.
  const reasonLines = (l) => {
    const comps = componentsOf(l);
    if (Number(l.current) === Number(l.next) || comps.length === 0) return [{ t: 'No change' }];
    if (comps.length === 1) return [{ t: changeLabel(comps[0]) }];
    return comps.map((c) => ({ t: changeLabel(c), a: c.amount }));
  };
  const whyW = col.old - 16 - col.why;
  const table = (title, rowsIn) => {
    need(24);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...OCEAN_700);
    doc.text(title, margin, y); y += 5;
    head();
    for (const l of rowsIn) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
      const changed = Number(l.current) !== Number(l.next);
      const svc = doc.splitTextToSize(clientServiceName(l.serviceId), col.why - col.svc - 4);
      doc.setFontSize(7.5);
      const built = l.build?.description ? doc.splitTextToSize(tidyBuild(l.build.description), col.why - col.svc - 4) : [];
      doc.setFontSize(8.5);
      const reasons = reasonLines(l).map((r) => ({ ...r, ls: doc.splitTextToSize(r.t, r.a != null ? whyW - 15 : whyW) }));
      const whyH = reasons.reduce((t, r) => t + r.ls.length * 3.8, 0) + (reasons.length - 1) * 1;
      const h = Math.max(svc.length * 3.8 + built.length * 3.3, whyH) + 3.5;
      if (y + h > 268) { newPage(); head(); }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...DARK);
      doc.text(svc, col.svc, y + 4);
      if (built.length) {
        doc.setFontSize(7.5); doc.setTextColor(...GRAY);
        doc.text(built, col.svc, y + 4 + svc.length * 3.8);
        doc.setFontSize(8.5);
      }
      let ry = y + 4;
      for (const r of reasons) {
        doc.setTextColor(...(changed ? DARK : GRAY));
        doc.text(r.ls, col.why, ry);
        if (r.a != null) {
          doc.setTextColor(...GRAY);
          doc.text(signed(r.a), col.old - 16, ry, { align: 'right' });
        }
        ry += r.ls.length * 3.8 + 1;
      }
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
    y += 8;
  };
  if (proposal) {
    const p1 = lines.filter((l) => partFor(l) === 1);
    const p2 = lines.filter((l) => partFor(l) === 2);
    if (p1.length) table(PART_TITLE[1], p1);
    if (p2.length) table(PART_TITLE[2], p2);
  } else {
    table("What's changing", lines);
  }

  footer(doc, pw, margin, cw);
  return doc;
}

// "1 hours a month" → "1 hour a month".
function tidyBuild(s) {
  return String(s).replace(/\b1 (hours|sets|returns|meetings)\b/g, (_, w) => `1 ${w.replace(/s$/, '')}`);
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

