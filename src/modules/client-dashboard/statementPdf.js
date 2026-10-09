import { AGE_BUCKETS, money2, dateGB, addressLines, statementFilename } from './openItems';

/*
  A customer statement as a PDF — one customer, one file.

  Shared with the client portal through @dash, which only admits modules that
  import nothing but their siblings. So jsPDF is passed IN: each app imports it
  from its own node_modules and hands over the constructor.

  The statement goes out under the CLIENT's name, not ours. Letterhead comes
  from their statement settings first (sql/361 — logo, contact details, how to
  pay) and falls back to what QuickBooks knows about the business.

  A4, millimetres, Helvetica: the standard fonts embed nothing and encode £
  and en dashes, so the file stays small and prints the same everywhere.
*/

const INK = [31, 41, 55];
const MUTED = [100, 116, 139];
const FAINT = [148, 163, 184];
const RULE = [226, 232, 240];
const SHADE = [246, 248, 250];
const ACCENT = [30, 69, 96];
const OVERDUE = [185, 28, 28];

const PAGE_W = 210;
const PAGE_H = 297;
const M = 16;            // side margin
const FOOT = 18;         // reserved at the foot of every page

// The letterhead: settings where given, QuickBooks where not.
export function letterhead(settings, business) {
  const s = settings || {};
  const b = business || {};
  const addr = s.address
    ? s.address.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
    : addressLines(b.address);
  return {
    name: s.business_name || b.name || b.legal_name || '',
    address: addr,
    email: s.email || b.email || null,
    phone: s.phone || b.phone || null,
    website: s.website || b.website || null,
    company_number: s.company_number || null,
    vat_number: s.vat_number || null,
    payment_details: s.payment_details || null,
    footer_note: s.footer_note || null,
    logo: s.logo_data_url || null,
  };
}

const TYPE_LABEL = {
  invoice: 'Invoice', creditmemo: 'Credit note', 'credit memo': 'Credit note',
  payment: 'On account', 'journal entry': 'Adjustment', journalentry: 'Adjustment',
};
const typeLabel = (t) => TYPE_LABEL[String(t || '').toLowerCase()] || t || '';

const COLS = [
  { key: 'date', label: 'Date', w: 24 },
  { key: 'type', label: 'Type', w: 30 },
  { key: 'number', label: 'Reference', w: 34 },
  { key: 'due', label: 'Due', w: 24 },
  { key: 'days', label: 'Days overdue', w: 20, right: true },
  { key: 'amount', label: 'Amount', w: 23, right: true },
  { key: 'open', label: 'Outstanding', w: 23, right: true },
];

export function statementPdf(jsPDF, statement, head) {
  // compress: a statement is emailed, and an uncompressed logo alone runs to
  // the best part of a megabyte.
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const cur = statement.currency;
  const set = (size, style = 'normal', color = INK) => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    doc.setTextColor(...color);
  };

  /* ── Letterhead ── */
  let y = M;
  let logoBottom = y;
  if (head.logo) {
    try {
      const p = doc.getImageProperties(head.logo);
      const maxW = 62;
      const maxH = 24;
      const k = Math.min(maxW / p.width, maxH / p.height);
      const w = p.width * k;
      const h = p.height * k;
      doc.addImage(head.logo, head.logo.startsWith('data:image/jpeg') ? 'JPEG' : 'PNG', M, y, w, h, 'logo', 'FAST');
      logoBottom = y + h;
    } catch { /* an unreadable logo costs the logo, not the statement */ }
  } else if (head.name) {
    set(16, 'bold', ACCENT);
    doc.text(head.name, M, y + 7);
    logoBottom = y + 9;
  }

  // Business details, right-aligned.
  const rx = PAGE_W - M;
  let ry = y + 3;
  if (head.logo && head.name) {
    set(11, 'bold');
    doc.text(head.name, rx, ry, { align: 'right' });
    ry += 5;
  }
  set(8.5, 'normal', MUTED);
  for (const line of [...head.address, head.phone, head.email, head.website].filter(Boolean)) {
    doc.text(String(line), rx, ry, { align: 'right' });
    ry += 4;
  }

  y = Math.max(logoBottom, ry) + 8;

  /* ── Title ── */
  set(22, 'bold', ACCENT);
  doc.text('Statement', M, y + 6);
  doc.setDrawColor(...ACCENT);
  doc.setLineWidth(0.8);
  doc.line(M, y + 10, M + 24, y + 10);
  y += 18;

  /* ── To / summary ── */
  const c = statement.customer || {};
  const top = y;
  set(8, 'bold', FAINT);
  doc.text('STATEMENT TO', M, y);
  y += 5;
  set(10.5, 'bold');
  doc.text(c.name || '', M, y);
  y += 5;
  set(9, 'normal', INK);
  const toLines = [
    c.company && c.company !== c.name ? c.company : null,
    c.contact ? `FAO ${c.contact}` : null,
    ...addressLines(c.address),
  ].filter(Boolean);
  for (const l of toLines) { doc.text(String(l), M, y); y += 4.4; }

  // Summary panel on the right.
  const px = 118;
  const pw = PAGE_W - M - px;
  const rows = [
    ['Statement date', dateGB(statement.as_at)],
    ['Open items', String(statement.lines.length)],
  ];
  let py = top - 4;
  doc.setFillColor(...SHADE);
  doc.roundedRect(px, py, pw, 38, 2, 2, 'F');
  py += 7;
  for (const [k, v] of rows) {
    set(8.5, 'normal', MUTED);
    doc.text(k, px + 5, py);
    set(8.5, 'normal', INK);
    doc.text(doc.splitTextToSize(String(v), pw - 40)[0] || '', px + pw - 5, py, { align: 'right' });
    py += 6;
  }
  doc.setDrawColor(...RULE);
  doc.setLineWidth(0.2);
  doc.line(px + 5, py - 2, px + pw - 5, py - 2);
  py += 4;
  set(9, 'bold');
  doc.text('Balance due', px + 5, py);
  set(13, 'bold', ACCENT);
  doc.text(money2(statement.balance, cur), px + pw - 5, py, { align: 'right' });
  py += 7;
  set(8.5, 'bold', statement.overdue > 0 ? OVERDUE : MUTED);
  doc.text('Of which overdue', px + 5, py);
  doc.text(money2(statement.overdue, cur), px + pw - 5, py, { align: 'right' });

  y = Math.max(y, top + 38) + 10;

  /* ── Lines ── */
  const tableX = M;
  const tableW = PAGE_W - 2 * M;
  const scale = tableW / COLS.reduce((s, col) => s + col.w, 0);
  const cols = COLS.map((col) => ({ ...col, w: col.w * scale }));
  const header = () => {
    doc.setFillColor(...ACCENT);
    doc.rect(tableX, y, tableW, 8, 'F');
    set(8, 'bold', [255, 255, 255]);
    let x = tableX;
    for (const col of cols) {
      if (col.right) doc.text(col.label, x + col.w - 2, y + 5.3, { align: 'right' });
      else doc.text(col.label, x + 2, y + 5.3);
      x += col.w;
    }
    y += 8;
  };
  header();

  const ROW = 7;
  statement.lines.forEach((l, i) => {
    if (y + ROW > PAGE_H - FOOT - 4) {
      doc.addPage();
      y = M;
      header();
    }
    if (i % 2 === 1) {
      doc.setFillColor(...SHADE);
      doc.rect(tableX, y, tableW, ROW, 'F');
    }
    const cells = {
      date: dateGB(l.date),
      type: typeLabel(l.type),
      number: String(l.number || ''),
      due: l.due_date ? dateGB(l.due_date) : '',
      days: l.days_overdue > 0 ? String(l.days_overdue) : '',
      amount: money2(l.amount, cur),
      open: money2(l.open, cur),
    };
    let x = tableX;
    for (const col of cols) {
      const overdueCell = col.key === 'days' && l.days_overdue > 0;
      set(8.5, col.key === 'open' ? 'bold' : 'normal', overdueCell ? OVERDUE : INK);
      const text = doc.splitTextToSize(cells[col.key], col.w - 3)[0] || '';
      if (col.right) doc.text(text, x + col.w - 2, y + 4.7, { align: 'right' });
      else doc.text(text, x + 2, y + 4.7);
      x += col.w;
    }
    y += ROW;
  });
  doc.setDrawColor(...RULE);
  doc.setLineWidth(0.3);
  doc.line(tableX, y, tableX + tableW, y);
  y += 6;
  set(9.5, 'bold');
  doc.text('Balance due', tableX + tableW - 34, y, { align: 'right' });
  doc.text(money2(statement.balance, cur), tableX + tableW - 2, y, { align: 'right' });
  y += 10;

  /* ── Ageing ── */
  const boxes = [...AGE_BUCKETS.map((b) => [b.label, statement.ageing[b.key] || 0]), ['Total due', statement.balance]];
  const needAgeing = 20;
  if (y + needAgeing > PAGE_H - FOOT) { doc.addPage(); y = M; }
  const bw = tableW / boxes.length;
  boxes.forEach(([label, v], i) => {
    const bx = tableX + i * bw;
    const last = i === boxes.length - 1;
    doc.setFillColor(...(last ? ACCENT : SHADE));
    doc.rect(bx + (i ? 0.6 : 0), y, bw - (i ? 0.6 : 0), 16, 'F');
    set(7.5, 'normal', last ? [255, 255, 255] : MUTED);
    doc.text(label, bx + bw / 2, y + 5.5, { align: 'center' });
    set(9.5, 'bold', last ? [255, 255, 255] : (i > 0 && v > 0.004 ? OVERDUE : INK));
    doc.text(money2(v, cur), bx + bw / 2, y + 11.5, { align: 'center' });
  });
  y += 24;

  /* ── How to pay, and any note ── */
  const block = (title, text) => {
    if (!text) return;
    set(9, 'normal', INK);
    const lines = doc.splitTextToSize(text, tableW - 10);
    const h = 9 + lines.length * 4.4;
    if (y + h > PAGE_H - FOOT) { doc.addPage(); y = M; }
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.3);
    doc.roundedRect(tableX, y, tableW, h, 2, 2, 'S');
    set(8, 'bold', FAINT);
    doc.text(title.toUpperCase(), tableX + 5, y + 6);
    set(9, 'normal', INK);
    doc.text(lines, tableX + 5, y + 11);
    y += h + 5;
  };
  block('How to pay', head.payment_details);
  block('Note', head.footer_note);

  if (statement.overdue > 0 && !head.footer_note) {
    if (y + 8 > PAGE_H - FOOT) { doc.addPage(); y = M; }
    set(9, 'normal', MUTED);
    doc.text(
      doc.splitTextToSize('Please arrange payment of the overdue balance at your earliest convenience. If you have already paid, thank you, and please disregard this reminder.', tableW),
      tableX, y,
    );
  }

  /* ── Footer on every page ── */
  const pages = doc.getNumberOfPages();
  const legal = [
    head.name,
    head.company_number ? `Company no. ${head.company_number}` : null,
    head.vat_number ? `VAT no. ${head.vat_number}` : null,
  ].filter(Boolean).join('  ·  ');
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.2);
    doc.line(M, PAGE_H - 12, PAGE_W - M, PAGE_H - 12);
    set(7.5, 'normal', FAINT);
    if (legal) doc.text(legal, M, PAGE_H - 7.5);
    doc.text(`Page ${p} of ${pages}`, PAGE_W - M, PAGE_H - 7.5, { align: 'right' });
  }

  return doc;
}

// Build and save one file per statement. Spaced out because browsers drop
// downloads fired in the same tick.
export async function downloadStatements(jsPDF, statements, head) {
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i];
    statementPdf(jsPDF, s, head).save(statementFilename(s.customer?.name, s.as_at));
    if (i < statements.length - 1) await new Promise((r) => setTimeout(r, 450));
  }
}
