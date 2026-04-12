// Quote PDF Export — professional branded output for Almond Valley Accounting

const OCEAN_700 = [25, 58, 80];
const OCEAN_600 = [30, 69, 96];
const OCEAN_100 = [223, 236, 242];
const WHITE = [255, 255, 255];
const GRAY = [120, 120, 120];
const DARK = [40, 40, 40];
const BORDER = [200, 200, 200];

const FOOTER_TEXT = [
  'Almond Valley Accounting Limited',
  '14 Ellismuir House, Ellismuir Way, Tannochside, G71 5PW',
  'info@almondvalleyaccounting.co.uk  |  0141 471 4255',
];

const hFmt = (n) => Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let logoDataUrl = null;
async function getLogoBase64() {
  if (logoDataUrl) return logoDataUrl;
  try {
    const resp = await fetch('/ava-logo.jpg');
    const blob = await resp.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => { logoDataUrl = reader.result; resolve(logoDataUrl); };
      reader.readAsDataURL(blob);
    });
  } catch { return null; }
}

function drawFooter(doc, pw, margin, cw) {
  const fy = 275;
  doc.setDrawColor(...OCEAN_100);
  doc.setLineWidth(0.3);
  doc.line(margin, fy, margin + cw, fy);
  doc.setFontSize(5.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  FOOTER_TEXT.forEach((line, i) => {
    doc.text(line, pw / 2, fy + 3 + (i * 3), { align: 'center' });
  });
}

export async function generateQuotePdf(quote, lineItems, options = {}) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF('p', 'mm', 'a4');
  const pw = 210, margin = 18, cw = pw - margin * 2;
  let y = margin;

  const checkPage = (n) => {
    if (y + n > 268) { drawFooter(doc, pw, margin, cw); doc.addPage(); y = margin; }
  };

  // Column positions — right-aligned number columns, all same width (22mm)
  const numW = 22;
  const grossR = margin + cw;
  const vatR = grossR - numW;
  const mNetR = vatR - numW;
  const annualR = mNetR - numW;

  // ── Logo ──
  const logo = await getLogoBase64();
  if (logo) {
    doc.addImage(logo, 'JPEG', pw - margin - 28, margin, 28, 28);
  }

  // ── Client name + Services Quote ──
  doc.setTextColor(...OCEAN_700);
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text(quote.relationship_group || 'Client', margin, y + 8);
  y += 14;
  doc.setFontSize(13);
  doc.setTextColor(...OCEAN_600);
  doc.text('Services Quote', margin, y);
  y += 8;

  // ── Quote metadata ──
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  doc.text(`Quote Reference: ${quote.quote_ref || ''}`, margin, y); y += 4;
  doc.text(`Quote Date: ${new Date(quote.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`, margin, y); y += 4;
  if (quote.valid_until) {
    doc.text(`Valid Until: ${new Date(quote.valid_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`, margin, y);
    y += 4;
  }

  // ── Space before table ──
  y += 10;

  // ── Column headers ──
  // "Cost Per Month" spanning header
  doc.setFillColor(...OCEAN_100);
  doc.rect(mNetR - numW, y, numW * 3, 5, 'F');
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OCEAN_700);
  doc.text('Cost Per Month', mNetR + numW * 0.5, y + 3.5, { align: 'center' });
  y += 7;

  // Sub-headers
  doc.setFontSize(7);
  doc.text('Annual Net', annualR - 1, y, { align: 'right' });
  doc.text('Monthly Net', mNetR - 1, y, { align: 'right' });
  doc.text('VAT', vatR - 1, y, { align: 'right' });
  doc.text('Monthly Gross', grossR - 1, y, { align: 'right' });
  y += 3;

  // Currency symbols
  doc.setFontSize(6);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  doc.text('\u00A3', annualR - 1, y, { align: 'right' });
  doc.text('\u00A3', mNetR - 1, y, { align: 'right' });
  doc.text('\u00A3', vatR - 1, y, { align: 'right' });
  doc.text('\u00A3', grossR - 1, y, { align: 'right' });
  y += 3;

  // Header separator
  doc.setDrawColor(...OCEAN_700);
  doc.setLineWidth(0.4);
  doc.line(margin, y, margin + cw, y);
  y += 5;

  // ── All Inclusive Monthly Fee (headline) ──
  const monthlyNet = Number(quote.monthly_net) || 0;
  const monthlyVat = Number(quote.monthly_vat) || 0;
  const monthlyGross = Number(quote.monthly_gross) || 0;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OCEAN_700);
  doc.text('All Inclusive Monthly Fee', margin, y);
  doc.setFontSize(11);
  doc.text(hFmt(monthlyNet), mNetR - 1, y, { align: 'right' });
  doc.text(hFmt(monthlyVat), vatR - 1, y, { align: 'right' });
  doc.setFontSize(12);
  doc.text(hFmt(monthlyGross), grossR - 1, y, { align: 'right' });
  y += 4;

  // Double line under headline
  doc.setDrawColor(...OCEAN_700);
  doc.setLineWidth(0.6);
  doc.line(margin, y, margin + cw, y);
  y += 8;

  // ── Service rows ──
  const recurring = lineItems.filter(l => l.is_recurring && !l.service_id?.startsWith('software'));
  const softwareItems = lineItems.filter(l => l.service_id?.startsWith('software'));
  const setupItems = lineItems.filter(l => !l.is_recurring);

  const drawRow = (name, annual, bold = false) => {
    checkPage(7);
    const mN = annual / 12;
    const mV = mN * 0.2;
    const mG = mN + mV;

    doc.setFontSize(8);
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setTextColor(...(bold ? OCEAN_700 : DARK));
    doc.text(name, margin + 2, y);

    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.text(hFmt(annual), annualR - 1, y, { align: 'right' });
    doc.text(hFmt(mN), mNetR - 1, y, { align: 'right' });
    doc.text(hFmt(mV), vatR - 1, y, { align: 'right' });
    doc.text(hFmt(mG), grossR - 1, y, { align: 'right' });
    y += 5.5;
  };

  // Individual services
  recurring.forEach(l => {
    const annual = Number(l.annual_amount) || 0;
    if (annual > 0) drawRow(l.description, annual);
  });

  y += 2;

  // ── Total Accountancy Costs ──
  const totalAccountancy = recurring.reduce((s, l) => s + (Number(l.annual_amount) || 0), 0);
  doc.setDrawColor(...OCEAN_700);
  doc.setLineWidth(0.4);
  doc.line(annualR - numW, y, margin + cw, y);
  y += 4;
  drawRow('Total Accountancy Costs', totalAccountancy, true);
  y += 2;

  // ── Software ──
  if (softwareItems.length > 0) {
    softwareItems.forEach(l => drawRow(l.description, Number(l.annual_amount) || 0));
    y += 2;
  }

  // ── Total Cost Including Software ──
  const totalAll = Number(quote.annual_total) || 0;
  doc.setDrawColor(...OCEAN_700);
  doc.setLineWidth(0.5);
  doc.line(annualR - numW, y, margin + cw, y);
  y += 4;
  drawRow('Total Cost Including Software', totalAll, true);
  // Double underline
  doc.setLineWidth(0.8);
  doc.line(annualR - numW, y, margin + cw, y);
  y += 1.5;
  doc.line(annualR - numW, y, margin + cw, y);
  y += 6;

  // ── Setup fees ──
  if (setupItems.length > 0) {
    checkPage(15 + setupItems.length * 6);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OCEAN_700);
    doc.text('One-Off Setup Fees', margin, y);
    y += 6;

    let setupTotal = 0;
    setupItems.forEach(l => {
      checkPage(6);
      const amt = Number(l.annual_amount) || 0;
      setupTotal += amt;
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...DARK);
      doc.text(l.description, margin + 2, y);
      doc.text(hFmt(amt), annualR - 1, y, { align: 'right' });
      y += 5.5;
    });

    // Setup total
    y += 1;
    doc.setDrawColor(...OCEAN_700);
    doc.setLineWidth(0.4);
    doc.line(annualR - numW, y, annualR, y);
    y += 4;
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OCEAN_700);
    doc.text('Total Setup Fees', margin + 2, y);
    doc.text(hFmt(setupTotal), annualR - 1, y, { align: 'right' });
    y += 2;
    doc.setLineWidth(0.5);
    doc.line(annualR - numW, y, annualR, y);
  }

  // ── Footer ──
  drawFooter(doc, pw, margin, cw);

  if (options.returnDoc) return doc;
  doc.save(`${quote.quote_ref || 'Quote'}.pdf`);
}

// Returns base64-encoded PDF for email attachment
export async function generateQuotePdfBase64(quote, lineItems) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF('p', 'mm', 'a4');
  const pw = 210, margin = 18, cw = pw - margin * 2;
  let y = margin;
  const numW = 22;
  const grossR = margin + cw;
  const annualR = grossR - numW * 3;

  const recurring = lineItems.filter(l => l.is_recurring);

  doc.setTextColor(...OCEAN_700);
  doc.setFontSize(16); doc.setFont('helvetica', 'bold');
  doc.text(quote.relationship_group || 'Client', margin, y + 8); y += 14;
  doc.setFontSize(12);
  doc.text('Services Quote', margin, y); y += 8;
  doc.setFontSize(8); doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  doc.text(`Ref: ${quote.quote_ref}  |  ${new Date(quote.created_at).toLocaleDateString('en-GB')}`, margin, y); y += 8;

  recurring.forEach(l => {
    doc.setFontSize(8); doc.setTextColor(...DARK);
    doc.text(l.description, margin + 2, y);
    doc.text(hFmt(Number(l.annual_amount)), annualR - 1, y, { align: 'right' });
    y += 5;
  });
  y += 3;

  doc.setFillColor(...OCEAN_700);
  doc.rect(margin, y, cw, 18, 'F');
  y += 5;
  doc.setTextColor(...WHITE); doc.setFontSize(8);
  doc.text('Annual Total (Net)', margin + 3, y); doc.text(hFmt(Number(quote.annual_total)), margin + cw - 3, y, { align: 'right' }); y += 5;
  doc.text('Monthly (Net)', margin + 3, y); doc.text(hFmt(Number(quote.monthly_net)), margin + cw - 3, y, { align: 'right' }); y += 5;
  doc.setFillColor(245, 197, 24);
  doc.rect(margin, y - 2, cw, 8, 'F');
  doc.setTextColor(...OCEAN_700); doc.setFontSize(10); doc.setFont('helvetica', 'bold');
  doc.text('Monthly Direct Debit (Inc VAT)', margin + 3, y + 2); doc.text(hFmt(Number(quote.monthly_gross)), margin + cw - 3, y + 2, { align: 'right' });

  // Footer
  drawFooter(doc, pw, margin, cw);

  return doc.output('datauristring').split(',')[1];
}
