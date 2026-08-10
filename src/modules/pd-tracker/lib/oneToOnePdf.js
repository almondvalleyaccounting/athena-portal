// 1-2-1 record PDF — the full meeting, headlines and details together.
// Follows the house style used by the quote export (jsPDF, A4 portrait, the
// ocean palette and the standard footer).

const OCEAN_700 = [25, 58, 80];
const OCEAN_600 = [30, 69, 96];
const OCEAN_100 = [223, 236, 242];
const GRAY = [120, 120, 120];
const DARK = [40, 40, 40];

const FOOTER_TEXT = [
  'Almond Valley Accounting Limited',
  'Private — this 1-2-1 record is for the individual and their manager.',
];

// Tile colours from the summary card, so the printed record reads the same
// way as the screen it came from.
const SECTION_FILL = {
  went_well: [220, 252, 231],
  improve: [254, 243, 199],
  blockers: [254, 226, 226],
  notes: [241, 245, 249],
};

const MOOD_WORD = { 1: 'Struggling', 2: 'Below par', 3: 'Okay', 4: 'Good', 5: 'Great' };

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

const fmtDate = (d) => d
  ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  : '';

/*
  meeting  — the pd_one_to_ones row
  sections — [{ key, label, points: [{ headline, detail }] }] in display order
  actions  — [{ action, owner_name, due_date, status }]
  comments — [{ author_name, created_at, body }]
*/
export async function generateOneToOnePdf(meeting, {
  staffName, managerName, sections = [], actions = [], comments = [],
} = {}) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF('p', 'mm', 'a4');
  const pw = 210, margin = 18, cw = pw - margin * 2;
  let y = margin;

  const drawFooter = () => {
    const fy = 279;
    doc.setDrawColor(...OCEAN_100);
    doc.setLineWidth(0.3);
    doc.line(margin, fy, margin + cw, fy);
    doc.setFontSize(5.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    FOOTER_TEXT.forEach((line, i) => doc.text(line, pw / 2, fy + 3.5 + (i * 3), { align: 'center' }));
  };

  // Reserve `need` mm on the current page, starting a new one if it won't fit.
  const checkPage = (need) => {
    if (y + need > 272) { drawFooter(); doc.addPage(); y = margin; }
  };

  // ── Header ──
  const logo = await getLogoBase64();
  if (logo) doc.addImage(logo, 'JPEG', pw - margin - 24, margin - 2, 24, 24);

  doc.setTextColor(...OCEAN_700);
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text(staffName || 'Team member', margin, y + 7);
  y += 13;

  doc.setFontSize(12);
  doc.setTextColor(...OCEAN_600);
  doc.setFont('helvetica', 'normal');
  doc.text('1-2-1 record', margin, y);
  y += 8;

  doc.setFontSize(8.5);
  doc.setTextColor(...GRAY);
  doc.text(fmtDate(meeting?.meeting_date), margin, y); y += 4;
  if (managerName) { doc.text(`With ${managerName}`, margin, y); y += 4; }
  const bits = [];
  if (meeting?.duration_mins) bits.push(`${meeting.duration_mins} minutes`);
  if (meeting?.mood) bits.push(`Feeling: ${MOOD_WORD[meeting.mood] || meeting.mood} (${meeting.mood}/5)`);
  if (bits.length) { doc.text(bits.join('   ·   '), margin, y); y += 4; }
  y += 5;

  // ── Sections ──
  for (const section of sections) {
    const points = (section.points || []).filter((p) => (p.headline || '').trim());
    if (!points.length) continue;

    checkPage(20);
    doc.setFillColor(...(SECTION_FILL[section.key] || SECTION_FILL.notes));
    doc.rect(margin, y, cw, 7, 'F');
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OCEAN_700);
    doc.text((section.label || '').toUpperCase(), margin + 3, y + 4.8);
    y += 11;

    for (const p of points) {
      doc.setFontSize(9.5);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...DARK);
      const head = doc.splitTextToSize(p.headline.trim(), cw - 6);
      checkPage(head.length * 4.6 + 4);
      doc.text('•', margin + 1, y);
      doc.text(head, margin + 5, y);
      y += head.length * 4.6;

      const detail = (p.detail || '').trim();
      if (detail) {
        doc.setFontSize(8.5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...GRAY);
        const body = doc.splitTextToSize(detail, cw - 11);
        checkPage(body.length * 4 + 3);
        doc.text(body, margin + 5, y + 1.5);
        y += body.length * 4 + 1.5;
      }
      y += 3;
    }
    y += 3;
  }

  // ── Actions ──
  if (actions.length) {
    checkPage(20);
    doc.setFillColor(...OCEAN_100);
    doc.rect(margin, y, cw, 7, 'F');
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OCEAN_700);
    doc.text('ACTIONS AGREED', margin + 3, y + 4.8);
    y += 11;

    for (const a of actions) {
      const meta = [a.owner_name, a.due_date ? `due ${fmtDate(a.due_date)}` : null, a.status === 'done' ? 'done' : null]
        .filter(Boolean).join('   ·   ');
      doc.setFontSize(9.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...DARK);
      const text = doc.splitTextToSize(a.action || '', cw - 6);
      checkPage(text.length * 4.6 + 8);
      doc.text('•', margin + 1, y);
      doc.text(text, margin + 5, y);
      y += text.length * 4.6;
      if (meta) {
        doc.setFontSize(8);
        doc.setTextColor(...GRAY);
        doc.text(meta, margin + 5, y + 1);
        y += 4.5;
      }
      y += 2.5;
    }
    y += 3;
  }

  // ── 360 feedback / comments ──
  if (comments.length) {
    checkPage(20);
    doc.setFillColor(...OCEAN_100);
    doc.rect(margin, y, cw, 7, 'F');
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OCEAN_700);
    doc.text('FEEDBACK & COMMENTS', margin + 3, y + 4.8);
    y += 11;

    for (const c of comments) {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...OCEAN_600);
      const who = `${c.author_name || 'Someone'}${c.created_at ? ` — ${fmtDate(c.created_at)}` : ''}`;
      checkPage(12);
      doc.text(who, margin + 1, y);
      y += 4;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(...DARK);
      const body = doc.splitTextToSize((c.body || '').trim(), cw - 4);
      checkPage(body.length * 4.2 + 3);
      doc.text(body, margin + 1, y);
      y += body.length * 4.2 + 4;
    }
  }

  drawFooter();

  const slug = (staffName || 'One-to-one').replace(/[^a-zA-Z0-9]/g, '');
  const dateSlug = (meeting?.meeting_date || '').slice(0, 10).replace(/-/g, '');
  doc.save(`1-2-1_${slug}_${dateSlug}.pdf`);
}
