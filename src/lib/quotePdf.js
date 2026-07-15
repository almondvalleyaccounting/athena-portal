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

// Build a single reference for a group quote from the group name, e.g.
// "LauraWrightGroup_20260603" — rather than concatenating every member
// quote's individual ref. Mirrors the individual ref shape
// ({NameSlug}_{YYYYMMDD}) using the group build date.
export function buildGroupQuoteRef(group, quotes) {
  const nameSlug = (group?.name || 'Group').replace(/[^a-zA-Z0-9]/g, '');
  const parsed = quotes?.[0]?.created_at ? new Date(quotes[0].created_at) : new Date();
  const d = isNaN(parsed.getTime()) ? new Date() : parsed;
  const dateSlug = d.toISOString().slice(0, 10).replace(/-/g, '');
  return `${nameSlug}_${dateSlug}`;
}

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

// Standard terms and conditions that accompany every quote. These are the
// commercial terms of the quote itself — the signed engagement letter remains
// the full contract and prevails over anything here.
const QUOTE_TERMS = [
  {
    h: 'About these terms',
    p: [
      'These terms and conditions accompany, and form part of, the attached quote from Almond Valley Accounting Limited ("we", "us", "our"). They set out the basis on which the quoted services are offered. On engagement you will be issued with a formal letter of engagement; where anything in that engagement letter differs from these terms, the engagement letter prevails.',
    ],
  },
  {
    h: 'Validity of this quote',
    p: [
      'This quote is valid until the "Valid Until" date shown, or for 30 days from the quote date where no such date is shown. After that point the quote may be withdrawn or re-priced. Fees are based on the information available to us at the date of the quote; if the scope, size or complexity of your affairs differs materially from what we were told, we will discuss a revised fee with you before proceeding.',
    ],
  },
  {
    h: 'Fees, VAT and payment',
    p: [
      'Recurring fees are payable monthly in advance by Direct Debit, unless we agree otherwise in writing. All fees are subject to VAT at the prevailing rate (currently 20%). One-off setup fees are payable on commencement of the engagement.',
      'We reserve the right to suspend work where fees are overdue. Amounts unpaid beyond their due date may be subject to interest at the statutory rate under the Late Payment of Commercial Debts (Interest) Act 1998.',
    ],
  },
  {
    h: 'Annual fee review',
    p: [
      'Fees are reviewed at least annually. They may be adjusted to reflect inflation, changes in the scope or volume of work, and changes in the cost of third-party services. We will notify you of any change in advance of it taking effect.',
    ],
  },
  {
    h: 'Scope of services',
    p: [
      'The services covered are those itemised in the attached quote. Any work outside that scope — including ad hoc advice, additional filings, HMRC enquiries, or work arising from incomplete or late records — is not included and will be quoted for, or charged, separately. We will agree additional work with you before undertaking it wherever practicable.',
    ],
  },
  {
    h: 'Third-party software',
    p: [
      'Where the quote includes bookkeeping or other software subscriptions, these are provided by third parties and are subject to those providers’ own terms. Software charges are passed on at the amounts stated and may change if the provider’s pricing changes.',
    ],
  },
  {
    h: 'Commencement of the engagement',
    p: [
      'Acceptance of this quote confirms the services and fees. Work will begin once the engagement letter is signed, a Direct Debit is in place, and our anti-money-laundering identity and business verification checks are complete, as required by the Money Laundering Regulations 2017.',
    ],
  },
  {
    h: 'Your responsibilities',
    p: [
      'You are responsible for the completeness and accuracy of the records and information you provide, and for providing them in good time to allow us to meet filing deadlines. You remain responsible for maintaining proper accounting records. We cannot accept responsibility for penalties, interest or other losses arising from information supplied late, incomplete or incorrect.',
    ],
  },
  {
    h: 'Confidentiality and data protection',
    p: [
      'We treat your information as confidential and process personal data in accordance with the UK GDPR and the Data Protection Act 2018, using it only as necessary to provide the services and to meet our legal and regulatory obligations. Our privacy notice is available on request.',
    ],
  },
  {
    h: 'Limitation of liability',
    p: [
      'We will provide the services with reasonable care and skill. Our total liability to you arising from or in connection with the engagement is limited to the fees paid for the services in the twelve months preceding the event giving rise to the claim, except for liability that cannot be limited by law. We are not liable for indirect or consequential loss, nor for any loss arising from reliance on information that was incomplete, inaccurate or provided late. The precise liability terms are set out in the engagement letter.',
    ],
  },
  {
    h: 'Termination',
    p: [
      'Either party may end the engagement by giving 30 days’ written notice. Fees are payable for all work carried out up to the date of termination, including work in progress. On termination we will, subject to settlement of outstanding fees, provide reasonable assistance to hand over to a new adviser.',
    ],
  },
  {
    h: 'Professional and regulatory standards',
    p: [
      'We act in accordance with the standards of our professional body and applicable law, including the Money Laundering Regulations 2017. We may be required to make reports to the relevant authorities and are not always able to inform you that a report has been made.',
    ],
  },
  {
    h: 'Governing law',
    p: [
      'These terms, and the engagement to which they relate, are governed by the law of Scotland and are subject to the exclusive jurisdiction of the Scottish courts.',
    ],
  },
];

// Appends the standard terms and conditions to the quote PDF, starting on a
// fresh page, wrapping and paginating as needed. Reused by every quote
// generator so the terms always travel with the quote.
function drawTermsPages(doc, pw, margin, cw) {
  doc.addPage();
  let y = margin;

  const ensureRoom = (n) => {
    if (y + n > 268) { drawFooter(doc, pw, margin, cw); doc.addPage(); y = margin; }
  };

  // Page heading
  doc.setTextColor(...OCEAN_700);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('Terms & Conditions', margin, y + 6);
  y += 11;
  doc.setDrawColor(...OCEAN_700);
  doc.setLineWidth(0.4);
  doc.line(margin, y, margin + cw, y);
  y += 7;

  QUOTE_TERMS.forEach((section, idx) => {
    // Keep the section heading with at least its first line of body text.
    ensureRoom(9);
    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OCEAN_700);
    doc.text(`${idx + 1}.  ${section.h}`, margin, y);
    y += 4.5;

    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...DARK);
    section.p.forEach((para) => {
      const lines = doc.splitTextToSize(para, cw);
      lines.forEach((line) => {
        ensureRoom(4);
        doc.text(line, margin, y);
        y += 3.6;
      });
      y += 1.5;
    });
    y += 2.5;
  });

  drawFooter(doc, pw, margin, cw);
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

    // Setup subtotal (net)
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
    y += 5.5;

    // VAT on setup fees
    const setupVat = Math.round(setupTotal * 0.2 * 100) / 100;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...DARK);
    doc.text('VAT (20%)', margin + 2, y);
    doc.text(hFmt(setupVat), annualR - 1, y, { align: 'right' });
    y += 2;
    doc.setDrawColor(...OCEAN_700);
    doc.setLineWidth(0.4);
    doc.line(annualR - numW, y, annualR, y);
    y += 4;

    // Total inc VAT
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OCEAN_700);
    doc.text('Total Setup Fees Inc VAT', margin + 2, y);
    doc.text(hFmt(setupTotal + setupVat), annualR - 1, y, { align: 'right' });
    y += 2;
    doc.setLineWidth(0.5);
    doc.line(annualR - numW, y, annualR, y);
  }

  // ── Footer ──
  drawFooter(doc, pw, margin, cw);

  // ── Standard terms & conditions ──
  drawTermsPages(doc, pw, margin, cw);

  if (options.returnDoc) return doc;
  doc.save(`${quote.quote_ref || 'Quote'}.pdf`);
}

// ── Group Quote PDF — entity-column layout ─────────────────────────
// Columns: Service | Entity1 | Entity2 | ... | Group Total
// Then VAT + Grand Total, then Monthly Breakdown box

export async function generateGroupQuotePdf(group, quotes, entities, discounts = {}, options = {}) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF('p', 'mm', 'a4');
  const pw = 210, margin = 18, cw = pw - margin * 2;
  let y = margin;

  const checkPage = (n) => {
    if (y + n > 268) { drawFooter(doc, pw, margin, cw); doc.addPage(); y = margin; }
  };

  // Map entities to their quotes
  const quoteByEntity = {};
  quotes.forEach(q => { quoteByEntity[q.entity_id || q.id] = q; });

  // Collect all service IDs across entities
  const allServices = new Map();
  const softwareServices = new Map();
  quotes.forEach(q => {
    (q.line_items || []).filter(l => l.is_recurring).forEach(l => {
      const map = l.service_id?.startsWith('software') ? softwareServices : allServices;
      if (!map.has(l.service_id)) map.set(l.service_id, l.description);
    });
  });

  // Per-entity calculations (mirrors ConsolidationTable logic)
  const getServiceAmount = (entityId, serviceId) => {
    const q = quoteByEntity[entityId];
    if (!q?.line_items) return 0;
    const line = q.line_items.find(l => l.service_id === serviceId);
    return Number(line?.annual_amount) || 0;
  };

  const entityCalcs = {};
  entities.forEach(e => {
    const q = quoteByEntity[e.id];
    const recurring = (q?.line_items || []).filter(l => l.is_recurring);
    const swLines = recurring.filter(l => l.service_id?.startsWith('software'));
    const svcLines = recurring.filter(l => !l.service_id?.startsWith('software'));
    const svcTotal = svcLines.reduce((s, l) => s + (Number(l.annual_amount) || 0), 0);
    const swTotal = swLines.reduce((s, l) => s + (Number(l.annual_amount) || 0), 0);
    const subtotal = svcTotal + swTotal;
    const disc = discounts[e.id] || 0;
    const discAmt = Math.round(subtotal * (disc / 100) * 100) / 100;
    const annualNet = subtotal - discAmt;
    const monthlyNet = Math.round((annualNet / 12) * 100) / 100;
    const monthlyVat = Math.round(monthlyNet * 0.2 * 100) / 100;
    const monthlyGross = Math.round((monthlyNet + monthlyVat) * 100) / 100;
    entityCalcs[e.id] = { svcTotal, swTotal, subtotal, disc, discAmt, annualNet, monthlyNet, monthlyVat, monthlyGross };
  });

  const groupAnnualNet = entities.reduce((s, e) => s + entityCalcs[e.id].annualNet, 0);
  const groupVat = Math.round((groupAnnualNet / 12) * 0.2 * 12 * 100) / 100;
  const groupGrandTotal = groupAnnualNet + groupVat;
  const groupMonthlyNet = entities.reduce((s, e) => s + entityCalcs[e.id].monthlyNet, 0);
  const groupMonthlyVat = entities.reduce((s, e) => s + entityCalcs[e.id].monthlyVat, 0);
  const groupMonthlyGross = entities.reduce((s, e) => s + entityCalcs[e.id].monthlyGross, 0);

  // Column layout: Service label | entity columns | group total
  const numCols = entities.length + 1; // entities + total
  const labelW = Math.min(50, cw * 0.3);
  const colW = (cw - labelW) / numCols;

  function colX(i) { return margin + labelW + (i * colW) + colW; } // right edge of column i

  // Wrap an entity name to at most 2 lines for the column header, fitting
  // the column width. If it would need a 3rd line, the 2nd is truncated
  // with an ellipsis. Assumes the caller has set the header font first.
  function wrapHeaderName(name, maxW) {
    const lines = doc.splitTextToSize(String(name || ''), maxW);
    if (lines.length <= 2) return lines;
    let second = lines[1];
    while (second.length > 0 && doc.getTextWidth(second + '\u2026') > maxW) {
      second = second.slice(0, -1);
    }
    return [lines[0], second.trimEnd() + '\u2026'];
  }

  // ── Logo ──
  const logo = await getLogoBase64();
  if (logo) doc.addImage(logo, 'JPEG', pw - margin - 28, margin, 28, 28);

  // ── Header ──
  doc.setTextColor(...OCEAN_700);
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text(group.name || 'Group Quote', margin, y + 8);
  y += 14;
  doc.setFontSize(13);
  doc.setTextColor(...OCEAN_600);
  doc.text('Group Services Quote', margin, y);
  y += 8;

  // Quote metadata
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  // Keep metadata clear of the top-right logo (logo spans the right ~28mm).
  const metaMaxW = (pw - margin - 28) - margin - 4;
  const ref = buildGroupQuoteRef(group, quotes);
  if (ref) {
    const refLines = doc.splitTextToSize(`Reference: ${ref}`, metaMaxW);
    doc.text(refLines, margin, y);
    y += 4 * refLines.length;
  }
  if (quotes[0]?.created_at) {
    doc.text(`Quote Date: ${new Date(quotes[0].created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`, margin, y);
    y += 4;
  }
  if (quotes[0]?.valid_until) {
    doc.text(`Valid Until: ${new Date(quotes[0].valid_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`, margin, y);
    y += 4;
  }
  y += 8;

  // Currency note above the table — makes clear every column is in £.
  doc.setFontSize(7);
  doc.setFont('helvetica', 'italic');
  doc.setTextColor(...GRAY);
  doc.text('All figures in £', margin + cw, y, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  y += 3;

  // ── Column headers (entity names wrap to max 2 lines) ──
  const headH = 9;
  doc.setFillColor(...OCEAN_100);
  doc.rect(margin, y, cw, headH, 'F');
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OCEAN_700);
  const hL1 = y + 3.5, hL2 = y + 7; // two baselines within the band
  doc.text('Service', margin + 2, hL2);
  entities.forEach((e, i) => {
    const lines = wrapHeaderName(e.name, colW - 2);
    if (lines.length <= 1) {
      doc.text(lines[0] || '', colX(i) - 1, hL2, { align: 'right' });
    } else {
      doc.text(lines[0], colX(i) - 1, hL1, { align: 'right' });
      doc.text(lines[1], colX(i) - 1, hL2, { align: 'right' });
    }
  });
  doc.text('Group Total', colX(entities.length) - 1, hL2, { align: 'right' });
  y += headH + 2;

  // Header line
  doc.setDrawColor(...OCEAN_700);
  doc.setLineWidth(0.4);
  doc.line(margin, y, margin + cw, y);
  y += 4;

  // ── Service rows ──
  function drawGroupRow(label, getVal, bold, bg) {
    checkPage(6);
    if (bg) { doc.setFillColor(...bg); doc.rect(margin, y - 3, cw, 5.5, 'F'); }
    doc.setFontSize(7);
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setTextColor(...(bold ? OCEAN_700 : DARK));
    doc.text(label, margin + 2, y);
    let total = 0;
    entities.forEach((e, i) => {
      const val = getVal(e.id);
      total += val;
      doc.text(val > 0 ? hFmt(val) : '\u2014', colX(i) - 1, y, { align: 'right' });
    });
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OCEAN_700);
    doc.text(hFmt(total), colX(entities.length) - 1, y, { align: 'right' });
    y += 5;
    return total;
  }

  // Accountancy services
  Array.from(allServices.entries()).forEach(([sid, name]) => {
    drawGroupRow(name, (eid) => getServiceAmount(eid, sid), false);
  });
  y += 1;

  // Software
  if (softwareServices.size > 0) {
    Array.from(softwareServices.entries()).forEach(([sid, name]) => {
      drawGroupRow(name, (eid) => getServiceAmount(eid, sid), false, OCEAN_100);
    });
    y += 1;
  }

  // Annual Subtotal
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.3);
  doc.line(margin + labelW, y, margin + cw, y);
  y += 4;
  drawGroupRow('Annual Subtotal', (eid) => entityCalcs[eid].subtotal, true);
  y += 1;

  // Discount row (only if any entity has a discount)
  const hasAnyDiscount = entities.some(e => entityCalcs[e.id].disc > 0);
  if (hasAnyDiscount) {
    checkPage(6);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    doc.text('Discount', margin + 2, y);
    entities.forEach((e, i) => {
      const c = entityCalcs[e.id];
      doc.text(c.disc > 0 ? `${c.disc}% (\u2212${hFmt(c.discAmt)})` : '\u2014', colX(i) - 1, y, { align: 'right' });
    });
    const totalDisc = entities.reduce((s, e) => s + entityCalcs[e.id].discAmt, 0);
    doc.text(totalDisc > 0 ? `\u2212${hFmt(totalDisc)}` : '\u2014', colX(entities.length) - 1, y, { align: 'right' });
    y += 5;
  }

  // Annual Total (Net)
  doc.setDrawColor(...OCEAN_700);
  doc.setLineWidth(0.4);
  doc.line(margin + labelW, y, margin + cw, y);
  y += 4;
  drawGroupRow('Annual Total (Net)', (eid) => entityCalcs[eid].annualNet, true);
  y += 2;

  // VAT on annual
  checkPage(6);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  doc.text('Add VAT (20%)', margin + 2, y);
  entities.forEach((e, i) => {
    const vat = Math.round(entityCalcs[e.id].annualNet * 0.2 * 100) / 100;
    doc.text(hFmt(vat), colX(i) - 1, y, { align: 'right' });
  });
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OCEAN_700);
  doc.text(hFmt(groupVat), colX(entities.length) - 1, y, { align: 'right' });
  y += 5;

  // Grand Total (Inc VAT)
  doc.setDrawColor(...OCEAN_700);
  doc.setLineWidth(0.6);
  doc.line(margin + labelW, y, margin + cw, y);
  y += 4;
  checkPage(6);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OCEAN_700);
  doc.text('Grand Total (Inc VAT)', margin + 2, y);
  entities.forEach((e, i) => {
    const total = entityCalcs[e.id].annualNet * 1.2;
    doc.text(hFmt(total), colX(i) - 1, y, { align: 'right' });
  });
  doc.text(hFmt(groupGrandTotal), colX(entities.length) - 1, y, { align: 'right' });
  y += 2;
  // Double underline
  doc.setLineWidth(0.8);
  doc.line(margin + labelW, y, margin + cw, y);
  y += 1.5;
  doc.line(margin + labelW, y, margin + cw, y);
  y += 10;

  // ── Monthly Breakdown Box ──
  checkPage(35);
  // Box border
  const boxY = y;
  doc.setDrawColor(...OCEAN_700);
  doc.setLineWidth(0.5);

  // Monthly header (entity names wrap to max 2 lines, matching the table above)
  const mHeadH = 9;
  doc.setFillColor(...OCEAN_100);
  doc.rect(margin, y, cw, mHeadH, 'F');
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OCEAN_700);
  const mL1 = y + 3.5, mL2 = y + 7;
  doc.text('Monthly Breakdown', margin + 2, mL2);
  entities.forEach((e, i) => {
    const lines = wrapHeaderName(e.name, colW - 2);
    if (lines.length <= 1) {
      doc.text(lines[0] || '', colX(i) - 1, mL2, { align: 'right' });
    } else {
      doc.text(lines[0], colX(i) - 1, mL1, { align: 'right' });
      doc.text(lines[1], colX(i) - 1, mL2, { align: 'right' });
    }
  });
  doc.text('Group Total', colX(entities.length) - 1, mL2, { align: 'right' });
  y += mHeadH + 2;

  // Monthly Net
  drawGroupRow('Monthly Net', (eid) => entityCalcs[eid].monthlyNet, false);

  // VAT
  checkPage(6);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  doc.text('VAT (20%)', margin + 2, y);
  entities.forEach((e, i) => {
    doc.text(hFmt(entityCalcs[e.id].monthlyVat), colX(i) - 1, y, { align: 'right' });
  });
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OCEAN_700);
  doc.text(hFmt(groupMonthlyVat), colX(entities.length) - 1, y, { align: 'right' });
  y += 5;

  // Monthly Direct Debit (highlight row)
  checkPage(8);
  doc.setFillColor(...OCEAN_700);
  doc.rect(margin, y - 3, cw, 8, 'F');
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...WHITE);
  doc.text('Monthly Direct Debit', margin + 2, y + 1);
  entities.forEach((e, i) => {
    doc.text(hFmt(entityCalcs[e.id].monthlyGross), colX(i) - 1, y + 1, { align: 'right' });
  });
  doc.setTextColor(245, 197, 24); // SUN_300 equivalent
  doc.text(hFmt(groupMonthlyGross), colX(entities.length) - 1, y + 1, { align: 'right' });
  y += 8;

  // Box outline
  doc.setDrawColor(...OCEAN_700);
  doc.setLineWidth(0.3);
  doc.rect(margin, boxY, cw, y - boxY);

  // ── Footer ──
  drawFooter(doc, pw, margin, cw);

  // ── Standard terms & conditions ──
  drawTermsPages(doc, pw, margin, cw);

  if (options.returnDoc) return doc;
  doc.save(`${group.name || 'Group_Quote'}.pdf`);
}

// Returns base64 group PDF for email attachment
export async function generateGroupQuotePdfBase64(group, quotes, entities, discounts = {}) {
  const doc = await generateGroupQuotePdf(group, quotes, entities, discounts, { returnDoc: true });
  return doc.output('datauristring').split(',')[1];
}

// Returns base64-encoded PDF for email attachment (individual)
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

  // Standard terms & conditions
  drawTermsPages(doc, pw, margin, cw);

  return doc.output('datauristring').split(',')[1];
}
