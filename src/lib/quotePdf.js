// Quote PDF Export — professional branded output for Almond Valley Accounting
// Uses jsPDF with Scottish Coast palette

const OCEAN_700 = [25, 58, 80];     // #193A50
const OCEAN_600 = [30, 69, 96];     // #1E4560
const OCEAN_100 = [223, 236, 242];  // #DFECF2
const SUN = [245, 197, 24];         // #F5C518
const WHITE = [255, 255, 255];
const GRAY = [120, 120, 120];
const DARK = [40, 40, 40];
const LIGHT_GRAY = [245, 245, 245];
const BORDER = [200, 200, 200];

const fmtNum = (n) => {
  if (n == null || isNaN(n)) return '£0.00';
  return '£' + Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// Convert ava-logo.jpg to base64 on first use (cached)
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

export async function generateQuotePdf(quote, lineItems) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF('p', 'mm', 'a4');
  const pw = 210, margin = 18, cw = pw - margin * 2;
  let y = margin;

  const checkPage = (n) => { if (y + n > 275) { doc.addPage(); y = margin; } };

  // ── Column layout (inspired by the table image) ──
  // Service | Annual Net | Monthly Net | VAT | Monthly Gross
  const col = {
    service: margin,
    serviceW: cw - 100,
    annual: margin + cw - 100,
    annualW: 25,
    monthlyNet: margin + cw - 75,
    monthlyNetW: 25,
    vat: margin + cw - 50,
    vatW: 25,
    gross: margin + cw - 25,
    grossW: 25,
  };

  // ── Logo + Header ──
  const logo = await getLogoBase64();
  if (logo) {
    doc.addImage(logo, 'JPEG', pw - margin - 30, margin, 30, 30);
  }

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  doc.text('almond valley', pw - margin - 30, margin + 33, { align: 'left' });
  doc.text('accounting', pw - margin - 30, margin + 37, { align: 'left' });

  // Client name as title
  doc.setTextColor(...OCEAN_700);
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text(quote.relationship_group || 'Client', margin, y + 8);
  y += 13;
  doc.setFontSize(14);
  doc.setTextColor(...OCEAN_600);
  doc.text('Services Quote', margin, y);
  y += 10;

  // Quote metadata
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  const quoteDate = new Date(quote.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  doc.text(`Quote Reference: ${quote.quote_ref}`, margin, y);
  y += 4;
  doc.text(`Quote Date: ${quoteDate}`, margin, y);
  if (quote.valid_until) {
    y += 4;
    const expiryDate = new Date(quote.valid_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    doc.text(`Valid Until: ${expiryDate}`, margin, y);
  }
  y += 8;

  // ── Column headers ──
  const drawTableHeader = () => {
    checkPage(12);
    // "Cost Per Month" spanning header
    doc.setFillColor(...OCEAN_100);
    doc.rect(col.monthlyNet, y - 4, 75, 5, 'F');
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OCEAN_700);
    doc.text('Cost Per Month', col.monthlyNet + 37.5, y - 1, { align: 'center' });
    y += 3;

    // Sub-headers
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OCEAN_700);
    doc.text('Annual Net', col.annual + col.annualW - 1, y, { align: 'right' });
    doc.text('Monthly', col.monthlyNet + col.monthlyNetW - 1, y, { align: 'right' });
    doc.text('VAT', col.vat + col.vatW - 1, y, { align: 'right' });
    doc.text('Monthly', col.gross + col.grossW - 1, y, { align: 'right' });
    y += 3;
    doc.setFont('helvetica', 'normal');
    doc.text('Net', col.monthlyNet + col.monthlyNetW - 1, y, { align: 'right' });
    doc.text('Gross', col.gross + col.grossW - 1, y, { align: 'right' });
    y += 1;

    // Currency row
    doc.setFontSize(6);
    doc.setTextColor(...GRAY);
    doc.text('£', col.annual + col.annualW - 1, y + 2, { align: 'right' });
    doc.text('£', col.monthlyNet + col.monthlyNetW - 1, y + 2, { align: 'right' });
    doc.text('£', col.vat + col.vatW - 1, y + 2, { align: 'right' });
    doc.text('£', col.gross + col.grossW - 1, y + 2, { align: 'right' });
    y += 5;

    // Separator line
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.3);
    doc.line(margin, y, margin + cw, y);
    y += 3;
  };

  drawTableHeader();

  // ── All Inclusive Monthly Fee (headline) ──
  const monthlyNet = Number(quote.monthly_net) || 0;
  const monthlyVat = Number(quote.monthly_vat) || 0;
  const monthlyGross = Number(quote.monthly_gross) || 0;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OCEAN_700);
  doc.text('All Inclusive Monthly Fee', margin, y + 1);
  // Headline numbers
  const hFmt = (n) => Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  doc.setFontSize(12);
  doc.text(hFmt(monthlyNet), col.monthlyNet + col.monthlyNetW - 1, y + 1, { align: 'right' });
  doc.text(hFmt(monthlyVat), col.vat + col.vatW - 1, y + 1, { align: 'right' });
  doc.setTextColor(...OCEAN_700);
  doc.setFontSize(13);
  doc.text(hFmt(monthlyGross), col.gross + col.grossW - 1, y + 1, { align: 'right' });
  y += 8;

  // Separator
  doc.setDrawColor(...BORDER);
  doc.line(margin, y, margin + cw, y);
  y += 5;

  // ── Service rows ──
  const recurring = lineItems.filter(l => l.is_recurring && !l.service_id?.startsWith('software'));
  const softwareItems = lineItems.filter(l => l.service_id?.startsWith('software'));
  const setupItems = lineItems.filter(l => !l.is_recurring);

  const drawServiceRow = (name, annual, isHeader = false) => {
    checkPage(6);
    const mNet = annual / 12;
    const mVat = mNet * 0.2;
    const mGross = mNet + mVat;

    doc.setFontSize(8);
    doc.setFont('helvetica', isHeader ? 'bold' : 'normal');
    doc.setTextColor(...(isHeader ? OCEAN_700 : DARK));
    doc.text(name, margin + 2, y);

    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...DARK);
    doc.text(hFmt(annual), col.annual + col.annualW - 1, y, { align: 'right' });
    doc.text(hFmt(mNet), col.monthlyNet + col.monthlyNetW - 1, y, { align: 'right' });
    doc.text(hFmt(mVat), col.vat + col.vatW - 1, y, { align: 'right' });
    doc.text(hFmt(mGross), col.gross + col.grossW - 1, y, { align: 'right' });
    y += 5;
  };

  const drawDash = (name) => {
    checkPage(6);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...DARK);
    doc.text(name, margin + 2, y);
    doc.setTextColor(...GRAY);
    doc.text('-', col.annual + col.annualW - 1, y, { align: 'right' });
    doc.text('-', col.monthlyNet + col.monthlyNetW - 1, y, { align: 'right' });
    doc.text('-', col.vat + col.vatW - 1, y, { align: 'right' });
    doc.text('-', col.gross + col.grossW - 1, y, { align: 'right' });
    y += 5;
  };

  // Individual services
  recurring.forEach(l => {
    const annual = Number(l.annual_amount) || 0;
    if (annual > 0) drawServiceRow(l.description, annual);
    else drawDash(l.description);
  });

  y += 2;

  // ── Total Accountancy Costs ──
  const totalAccountancy = recurring.reduce((s, l) => s + (Number(l.annual_amount) || 0), 0);
  doc.setDrawColor(...OCEAN_700);
  doc.setLineWidth(0.5);
  doc.line(col.annual, y - 1, margin + cw, y - 1);
  drawServiceRow('Total Accountancy Costs', totalAccountancy, true);
  y += 2;

  // ── Software ──
  if (softwareItems.length > 0) {
    const totalSw = softwareItems.reduce((s, l) => s + (Number(l.annual_amount) || 0), 0);
    softwareItems.forEach(l => drawServiceRow(l.description, Number(l.annual_amount) || 0));
    y += 2;
  }

  // ── Total Cost Including Software ──
  const totalAll = Number(quote.annual_total) || 0;
  doc.setDrawColor(...OCEAN_700);
  doc.setLineWidth(0.8);
  doc.line(col.annual, y - 1, margin + cw, y - 1);
  doc.line(col.annual, y + 4, margin + cw, y + 4);
  drawServiceRow('Total Cost Including Software', totalAll, true);
  y += 5;

  // ── Setup fees (if any) ──
  if (setupItems.length > 0) {
    y += 5;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OCEAN_700);
    doc.text('One-Off Setup Fees', margin, y);
    y += 5;
    setupItems.forEach(l => {
      checkPage(5);
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...DARK);
      doc.text(l.description, margin + 2, y);
      doc.text(hFmt(Number(l.annual_amount) || 0), col.annual + col.annualW - 1, y, { align: 'right' });
      y += 5;
    });
  }

  // ── Footer ──
  y = 270;
  doc.setDrawColor(...OCEAN_100);
  doc.setLineWidth(0.3);
  doc.line(margin, y, margin + cw, y);
  y += 4;
  doc.setFontSize(6);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  doc.text('Almond Valley Accounting  |  portal.almondvalleyaccounting.co.uk', pw / 2, y, { align: 'center' });
  y += 3;
  doc.text('All fees are subject to VAT at the prevailing rate. This quote is valid for 30 days from the date of issue.', pw / 2, y, { align: 'center' });

  // Save
  doc.save(`${quote.quote_ref || 'Quote'}.pdf`);
}

// Returns base64-encoded PDF for email attachment
export async function generateQuotePdfBase64(quote, lineItems) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF('p', 'mm', 'a4');
  // Simplified version for email — reuses the same approach
  const pw = 210, margin = 18, cw = pw - margin * 2;
  let y = margin;

  const hFmt = (n) => Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const recurring = lineItems.filter(l => l.is_recurring);

  // Header
  doc.setTextColor(25, 58, 80);
  doc.setFontSize(16); doc.setFont('helvetica', 'bold');
  doc.text(quote.relationship_group || 'Client', margin, y + 8);
  y += 13;
  doc.setFontSize(12);
  doc.text('Services Quote', margin, y); y += 8;
  doc.setFontSize(8); doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 100, 100);
  doc.text(`Ref: ${quote.quote_ref}  |  ${new Date(quote.created_at).toLocaleDateString('en-GB')}`, margin, y);
  y += 8;

  // Services
  recurring.forEach(l => {
    doc.setFontSize(8); doc.setTextColor(40, 40, 40);
    doc.text(l.description, margin + 2, y);
    doc.text(hFmt(Number(l.annual_amount)), margin + cw - 1, y, { align: 'right' });
    y += 5;
  });
  y += 3;

  // Totals
  doc.setFillColor(25, 58, 80);
  doc.rect(margin, y - 3, cw, 20, 'F');
  doc.setTextColor(255, 255, 255); doc.setFontSize(8);
  doc.text('Annual Total (Net)', margin + 3, y); doc.text(hFmt(Number(quote.annual_total)), margin + cw - 3, y, { align: 'right' }); y += 5;
  doc.text('Monthly (Net)', margin + 3, y); doc.text(hFmt(Number(quote.monthly_net)), margin + cw - 3, y, { align: 'right' }); y += 5;
  doc.setFillColor(245, 197, 24);
  doc.rect(margin, y - 3, cw, 8, 'F');
  doc.setTextColor(25, 58, 80); doc.setFontSize(10); doc.setFont('helvetica', 'bold');
  doc.text('Monthly Direct Debit (Inc VAT)', margin + 3, y + 1); doc.text(hFmt(Number(quote.monthly_gross)), margin + cw - 3, y + 1, { align: 'right' });

  return doc.output('datauristring').split(',')[1];
}
