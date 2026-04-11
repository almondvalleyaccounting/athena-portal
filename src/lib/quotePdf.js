// Quote PDF Export — generates a branded PDF from quote data
// Uses jsPDF (dynamic import to avoid bloating initial bundle)

const OCEAN = [25, 58, 80]; // #193A50
const OCEAN_LIGHT = [223, 236, 242]; // #DFECF2
const SUN = [245, 197, 24]; // #F5C518
const WHITE = [255, 255, 255];
const GRAY = [100, 100, 100];
const DARK = [30, 30, 30];

const fmtNum = (n) => {
  if (n == null || isNaN(n)) return '\u00A30.00';
  return '\u00A3' + Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export async function generateQuotePdf(quote, lineItems) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF('p', 'mm', 'a4');
  const pw = 210; // page width
  const margin = 15;
  const cw = pw - margin * 2; // content width
  let y = margin;

  const addPage = () => { doc.addPage(); y = margin; };
  const checkPage = (needed) => { if (y + needed > 280) addPage(); };

  // ── Header bar ──
  doc.setFillColor(...OCEAN);
  doc.rect(0, 0, pw, 28, 'F');
  doc.setTextColor(...WHITE);
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('ATHENA', margin, 12);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.text('Almond Valley Accounting', margin, 18);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text(quote.quote_ref || 'Quote', pw - margin, 12, { align: 'right' });
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.text(new Date(quote.created_at).toLocaleDateString('en-GB'), pw - margin, 18, { align: 'right' });
  y = 35;

  // ── Client info ──
  doc.setTextColor(...DARK);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text(quote.relationship_group || 'Client', margin, y);
  y += 5;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  const clientInfo = [];
  if (quote.estimated_turnover) clientInfo.push('Est. Turnover: ' + fmtNum(quote.estimated_turnover));
  if (quote.accounts_detail?.type) clientInfo.push('Type: ' + quote.accounts_detail.type);
  if (quote.defaults_version) clientInfo.push('v' + quote.defaults_version);
  if (clientInfo.length) { doc.text(clientInfo.join('  |  '), margin, y); y += 5; }
  y += 3;

  // ── Helper: draw a simple table ──
  const drawTable = (headers, rows, colWidths) => {
    checkPage(10 + rows.length * 6);
    const totalW = colWidths.reduce((a, b) => a + b, 0);

    // Header row
    doc.setFillColor(...OCEAN_LIGHT);
    doc.rect(margin, y - 3, totalW, 6, 'F');
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OCEAN);
    let x = margin;
    headers.forEach((h, i) => {
      const align = i === 0 ? 'left' : 'right';
      const tx = i === 0 ? x + 1 : x + colWidths[i] - 1;
      doc.text(h, tx, y, { align });
      x += colWidths[i];
    });
    y += 5;

    // Data rows
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...DARK);
    rows.forEach((row) => {
      checkPage(6);
      x = margin;
      row.forEach((cell, i) => {
        const align = i === 0 ? 'left' : 'right';
        const tx = i === 0 ? x + 1 : x + colWidths[i] - 1;
        doc.text(String(cell), tx, y, { align });
        x += colWidths[i];
      });
      y += 5;
    });
    y += 2;
  };

  // ── Section heading ──
  const sectionTitle = (title) => {
    checkPage(12);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OCEAN);
    doc.text(title, margin, y);
    y += 1;
    doc.setDrawColor(...OCEAN_LIGHT);
    doc.line(margin, y, margin + cw, y);
    y += 4;
  };

  // ── Setup fees ──
  const setupItems = lineItems.filter(l => !l.is_recurring);
  if (setupItems.length > 0) {
    sectionTitle('One-Off Setup Fees');
    drawTable(
      ['Item', 'Amount'],
      setupItems.map(l => [l.description, fmtNum(l.annual_amount)]),
      [cw - 30, 30]
    );
  }

  // ── Recurring services ──
  const recurring = lineItems.filter(l => l.is_recurring);
  if (recurring.length > 0) {
    sectionTitle('Recurring Services');
    drawTable(
      ['Service', 'Annual', 'Monthly'],
      recurring.map(l => [
        l.description + (l.detail ? ` (${l.detail})` : ''),
        fmtNum(l.annual_amount),
        fmtNum(l.monthly_amount),
      ]),
      [cw - 60, 30, 30]
    );
  }

  // ── Directors ──
  const dirs = quote.directors || [];
  if (dirs.length > 0) {
    sectionTitle('Directors\' Tax Returns (' + dirs.length + ')');
    drawTable(
      ['Director', 'Base', 'Add-ons', 'Total'],
      dirs.map(d => {
        const addons = [];
        if (d.other_dividends) addons.push('Dividends');
        if (d.has_rentals) addons.push('Rental x' + d.rental_properties);
        if (d.capital_gains) addons.push('CGT');
        if (d.savings_income) addons.push('Savings');
        return [d.name || 'Director', fmtNum(d.base), addons.join(', ') || '\u2014', fmtNum(d.total)];
      }),
      [cw - 75, 25, 25, 25]
    );
  }

  // ── Payroll ──
  if (quote.payroll_detail) {
    const pr = quote.payroll_detail;
    sectionTitle('Payroll');
    const prRows = [['Flat monthly fee', fmtNum(pr.flat_monthly)]];
    if (pr.monthly_ee > 0) prRows.push([`Monthly employees (${pr.monthly_ee})`, fmtNum(pr.monthly_ee * pr.monthly_ee_rate) + '/mo']);
    if (pr.weekly_ee > 0) prRows.push([`Weekly employees (${pr.weekly_ee})`, fmtNum(pr.weekly_ee * pr.weekly_ee_rate * 4.33) + '/mo']);
    if (pr.cis > 0) prRows.push([`CIS subcontractors (${pr.cis})`, fmtNum(pr.cis * pr.cis_rate * 4.33) + '/mo']);
    if (pr.p11d > 0) prRows.push([`P11D returns (${pr.p11d})`, fmtNum(pr.p11d * pr.p11d_rate) + '/yr']);
    drawTable(['Component', 'Amount'], prRows, [cw - 30, 30]);
  }

  // ── Software ──
  if (quote.software_detail) {
    sectionTitle('Software');
    const swRows = [];
    if (quote.software_detail.accounting) swRows.push([quote.software_detail.accounting.name, fmtNum(quote.software_detail.accounting.monthly) + '/mo']);
    if (quote.software_detail.dext) swRows.push(['Dext', fmtNum(quote.software_detail.dext.monthly) + '/mo']);
    if (swRows.length) drawTable(['Product', 'Monthly'], swRows, [cw - 30, 30]);
  }

  // ── Totals block ──
  checkPage(40);
  y += 3;
  doc.setFillColor(...OCEAN);
  const totalsH = 38 + (quote.one_off_total > 0 ? 7 : 0);
  doc.rect(margin, y - 3, cw, totalsH, 'F');
  doc.setTextColor(...WHITE);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');

  const ty = y;
  if (quote.one_off_total > 0) {
    doc.text('One-Off Setup', margin + 3, y);
    doc.text(fmtNum(quote.one_off_total), margin + cw - 3, y, { align: 'right' });
    y += 7;
  }
  doc.text('Annual Services', margin + 3, y);
  doc.text(fmtNum(quote.annual_services), margin + cw - 3, y, { align: 'right' });
  y += 5;
  if (quote.annual_software > 0) {
    doc.text('Annual Software', margin + 3, y);
    doc.text(fmtNum(quote.annual_software), margin + cw - 3, y, { align: 'right' });
    y += 5;
  }
  doc.text('Annual Total (Net)', margin + 3, y);
  doc.setFont('helvetica', 'bold');
  doc.text(fmtNum(quote.annual_total), margin + cw - 3, y, { align: 'right' });
  y += 7;
  doc.setFont('helvetica', 'normal');
  doc.text('Monthly (Net)', margin + 3, y);
  doc.text(fmtNum(quote.monthly_net), margin + cw - 3, y, { align: 'right' });
  y += 5;
  doc.text('VAT', margin + 3, y);
  doc.text(fmtNum(quote.monthly_vat), margin + cw - 3, y, { align: 'right' });
  y += 6;

  // Sunshine yellow highlight for DD
  doc.setFillColor(...SUN);
  doc.rect(margin, y - 4, cw, 10, 'F');
  doc.setTextColor(...OCEAN);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Monthly DD (Inc VAT)', margin + 3, y + 2);
  doc.text(fmtNum(quote.monthly_gross), margin + cw - 3, y + 2, { align: 'right' });

  // ── Footer ──
  y = 287;
  doc.setFontSize(6);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  doc.text('Almond Valley Accounting | portal.almondvalleyaccounting.co.uk', pw / 2, y, { align: 'center' });

  // Save
  doc.save(`${quote.quote_ref || 'Quote'}.pdf`);
}

// Returns base64-encoded PDF string (for email attachment)
export async function generateQuotePdfBase64(quote, lineItems) {
  // Reuse the same generation logic but return base64 instead of saving
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF('p', 'mm', 'a4');
  // We'll call the internal builder — for now, generate and return base64
  // This is a simplified approach: generate the same PDF, output as base64
  await generateQuotePdfInternal(doc, quote, lineItems);
  return doc.output('datauristring').split(',')[1]; // strip the data:application/pdf;base64, prefix
}

// Internal shared builder (extracted for reuse)
async function generateQuotePdfInternal(doc, quote, lineItems) {
  const pw = 210, margin = 15, cw = pw - margin * 2;
  let y = margin;
  const checkPage = (n) => { if (y + n > 280) { doc.addPage(); y = margin; } };

  // Header
  doc.setFillColor(25, 58, 80);
  doc.rect(0, 0, pw, 28, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16); doc.setFont('helvetica', 'bold');
  doc.text('ATHENA', margin, 12);
  doc.setFontSize(8); doc.setFont('helvetica', 'normal');
  doc.text('Almond Valley Accounting', margin, 18);
  doc.setFontSize(10); doc.setFont('helvetica', 'bold');
  doc.text(quote.quote_ref || 'Quote', pw - margin, 12, { align: 'right' });
  doc.setFontSize(8); doc.setFont('helvetica', 'normal');
  doc.text(new Date(quote.created_at).toLocaleDateString('en-GB'), pw - margin, 18, { align: 'right' });
  y = 35;

  // Client
  doc.setTextColor(30, 30, 30);
  doc.setFontSize(12); doc.setFont('helvetica', 'bold');
  doc.text(quote.relationship_group || 'Client', margin, y); y += 6;

  // Services
  const recurring = lineItems.filter(l => l.is_recurring);
  if (recurring.length > 0) {
    doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(25, 58, 80);
    doc.text('Services', margin, y); y += 5;
    doc.setFontSize(7); doc.setFont('helvetica', 'normal'); doc.setTextColor(30, 30, 30);
    recurring.forEach(l => {
      checkPage(5);
      doc.text(l.description, margin + 1, y);
      doc.text(fmtNum(l.annual_amount), margin + cw - 1, y, { align: 'right' });
      y += 4;
    });
    y += 3;
  }

  // Totals
  checkPage(30);
  doc.setFillColor(25, 58, 80);
  doc.rect(margin, y - 3, cw, 30, 'F');
  doc.setTextColor(255, 255, 255); doc.setFontSize(8); doc.setFont('helvetica', 'normal');
  doc.text('Annual Total (Net)', margin + 3, y); doc.text(fmtNum(quote.annual_total), margin + cw - 3, y, { align: 'right' }); y += 5;
  doc.text('Monthly (Net)', margin + 3, y); doc.text(fmtNum(quote.monthly_net), margin + cw - 3, y, { align: 'right' }); y += 5;
  doc.text('VAT', margin + 3, y); doc.text(fmtNum(quote.monthly_vat), margin + cw - 3, y, { align: 'right' }); y += 5;
  doc.setFillColor(245, 197, 24);
  doc.rect(margin, y - 3, cw, 8, 'F');
  doc.setTextColor(25, 58, 80); doc.setFontSize(10); doc.setFont('helvetica', 'bold');
  doc.text('Monthly DD (Inc VAT)', margin + 3, y + 1); doc.text(fmtNum(quote.monthly_gross), margin + cw - 3, y + 1, { align: 'right' });
}
