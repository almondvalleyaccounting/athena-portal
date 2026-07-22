// PDF export — produces a polished forecast pack using jsPDF + autotable.

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { PNL_LINES, BS_LINES, CF_LINES } from '../../views/statementLines';
import {
  groupPeriods, buildStatementMatrix,
  buildStaffMatrix, STAFF_ROWS,
  buildPremisesMatrix,
  buildIncomeMatrix,
  pToGbp,
} from './aggregations';
import { buildOccupancyIndex, occKey, curveForBand, occupancyOnCurve } from '../occupancy.js';
import { drawLineChart, drawColumnChart, drawStackedBars, SERIES, fmtAxisMoney } from './pdfCharts.js';

// Brand palette
const INK = '#0f172a';
const MUTED = '#64748b';
const ACCENT = '#0e7fe0';
const RULE = '#cbd5e1';
const SOFT = '#f8fafc';
const BORDER = '#e5e7eb';

const PAGE = { w: 297, h: 210 };          // A4 landscape, mm
const MARGIN = { top: 18, bottom: 16, left: 14, right: 14 };

function fmtP(p) {
  if (p == null || p === 0) return '–';
  const v = p / 100;
  const sign = v < 0 ? '(' : '';
  const close = v < 0 ? ')' : '';
  return sign + Math.abs(Math.round(v)).toLocaleString('en-GB') + close;
}
function fmtPct(x, dp = 1) { return x == null ? '—' : `${x.toFixed(dp)}%`; }
function fmtN(x, dp = 0) { return x == null ? '—' : Number(x).toLocaleString('en-GB', { maximumFractionDigits: dp }); }
function fmtRateP(p) { return p == null ? '—' : '£' + (p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// ── Header / footer chrome ─────────────────────────────────────

function drawHeader(doc, { forecast, scenario, scopeLabel, granularity }) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(INK);
  doc.text((forecast?.client_name || 'Forecast pack').toUpperCase(), MARGIN.left, 10);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(MUTED);
  const right = `${scenario?.name || ''} · ${scopeLabel || 'all'} · ${granularity}`;
  doc.text(right, PAGE.w - MARGIN.right, 10, { align: 'right' });

  doc.setDrawColor(RULE);
  doc.setLineWidth(0.2);
  doc.line(MARGIN.left, 12, PAGE.w - MARGIN.right, 12);
}

function drawFooter(doc, pageNum, pageTotal) {
  doc.setDrawColor(RULE);
  doc.setLineWidth(0.2);
  doc.line(MARGIN.left, PAGE.h - 12, PAGE.w - MARGIN.right, PAGE.h - 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(MUTED);
  doc.text(`Generated ${new Date().toLocaleString('en-GB')}`, MARGIN.left, PAGE.h - 7);
  doc.text(`${pageNum} / ${pageTotal}`, PAGE.w - MARGIN.right, PAGE.h - 7, { align: 'right' });
}

function drawSectionHeading(doc, title, subtitle) {
  doc.setFont('times', 'normal');
  doc.setFontSize(20);
  doc.setTextColor(INK);
  doc.text(title, MARGIN.left, 24);
  if (subtitle) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(MUTED);
    doc.text(subtitle, MARGIN.left, 30);
  }
  doc.setDrawColor(INK);
  doc.setLineWidth(0.4);
  doc.line(MARGIN.left, 33, PAGE.w - MARGIN.right, 33);
}

// ── Cover page ─────────────────────────────────────────────────

function drawCover(doc, { forecast, scenario, scopeLabel, granularity, year, kpis, notes, preparedBy, preparedFor, contents = [] }) {
  // Title block
  doc.setFillColor(INK);
  doc.rect(0, 0, PAGE.w, 70, 'F');
  doc.setFillColor(ACCENT);
  doc.rect(0, 70, PAGE.w, 1.2, 'F');

  doc.setTextColor('#ffffff');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.text((forecast?.client_name || '—').toUpperCase(), MARGIN.left, 18);

  doc.setFont('times', 'normal');
  doc.setFontSize(34);
  doc.text('Forecast pack', MARGIN.left, 36);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text(forecast?.name || '', MARGIN.left, 46);

  doc.setFontSize(9);
  doc.setTextColor('#cbd5e1');
  doc.text([
    `Scenario: ${scenario?.name || ''}`,
    scopeLabel || 'All locations',
    `${granularity} · anchored to Y${year}`,
    `Generated ${new Date().toLocaleDateString('en-GB')}`,
  ].join('   ·   '), MARGIN.left, 56);

  // Cover deliberately carries no headline numbers — title + commentary
  // only. Quantitative summary lives on the Executive summary page.

  // Contents — right-hand column of section names
  if (contents.length > 0) {
    const cx = PAGE.w - MARGIN.right - 70;
    let cy = 90;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(MUTED);
    doc.text('IN THIS PACK', cx, cy);
    doc.setDrawColor(RULE);
    doc.setLineWidth(0.2);
    doc.line(cx, cy + 2, PAGE.w - MARGIN.right, cy + 2);
    cy += 8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    for (const c of contents) {
      doc.setFillColor(ACCENT);
      doc.circle(cx + 1, cy - 1, 0.7, 'F');
      doc.setTextColor(INK);
      doc.text(c, cx + 4, cy);
      cy += 6.5;
    }
  }

  // Prepared-for / prepared-by block — kept clear of the contents column
  const bodyW = contents.length > 0 ? PAGE.w - MARGIN.left - MARGIN.right - 84 : PAGE.w - MARGIN.left - MARGIN.right;
  let infoY = 90;
  if (preparedFor || preparedBy) {
    const colW = bodyW / 2;
    doc.setTextColor(MUTED);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    if (preparedFor) doc.text('PREPARED FOR', MARGIN.left, infoY);
    if (preparedBy)  doc.text('PREPARED BY',  MARGIN.left + colW, infoY);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(INK);
    if (preparedFor) doc.text(preparedFor, MARGIN.left, infoY + 6);
    if (preparedBy)  doc.text(preparedBy,  MARGIN.left + colW, infoY + 6);
    infoY += 16;
  }

  // Notes block — wrap user-supplied text into the body of the cover.
  if (notes && notes.trim()) {
    const startY = Math.max(infoY, 90);
    doc.setDrawColor(RULE);
    doc.setLineWidth(0.2);
    doc.line(MARGIN.left, startY, MARGIN.left + bodyW, startY);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(MUTED);
    doc.text('NOTES', MARGIN.left, startY + 7);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(INK);
    const maxW = bodyW;
    const wrapped = doc.splitTextToSize(notes.trim(), maxW);
    // Cap so notes can't overflow the cover page; the rest fits on the page now
    // that headline KPIs have been removed.
    const capped = wrapped.slice(0, 55);
    doc.text(capped, MARGIN.left, startY + 16);
    if (wrapped.length > capped.length) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8);
      doc.setTextColor(MUTED);
      doc.text(`(+${wrapped.length - capped.length} more lines truncated)`, MARGIN.left, PAGE.h - 18);
    }
  }
}

// ── Statement page (P&L / BS / CF) ─────────────────────────────

function drawStatementPage(doc, { title, subtitle, lines, outputs, scopedOutputs, grouped, headers, header }) {
  drawHeader(doc, header);
  drawSectionHeading(doc, title, subtitle);

  const matrix = buildStatementMatrix(outputs, lines, grouped, scopedOutputs);
  const body = matrix.map(({ line, values }) => {
    const cells = [
      { content: (line.indent ? '   ' : '') + line.label, styles: {
        fontStyle: line.kind === 'header' ? 'bold' : 'normal',
        textColor: line.kind === 'subtle' ? MUTED : INK,
      }},
      ...values.map(v => ({
        content: fmtP(v),
        styles: {
          halign: 'right',
          fontStyle: line.kind === 'header' ? 'bold' : 'normal',
          textColor: line.kind === 'subtle' ? MUTED : INK,
        },
      })),
    ];
    return { cells, isHeader: line.kind === 'header' };
  });

  // Build the header row with explicit alignment so the period column
  // labels line up with the right-aligned numeric cells underneath.
  const headRow = [
    { content: '', styles: { halign: 'left' } },
    ...headers.map(h => ({ content: h, styles: { halign: 'right' } })),
  ];

  autoTable(doc, {
    startY: 38,
    head: [headRow],
    body: body.map(r => r.cells),
    theme: 'plain',
    styles: {
      font: 'helvetica', fontSize: 8, cellPadding: { top: 1.4, right: 3, bottom: 1.4, left: 3 },
      lineColor: BORDER, lineWidth: 0,
    },
    headStyles: {
      fontStyle: 'bold', fontSize: 7, textColor: MUTED, fillColor: SOFT,
      lineWidth: { bottom: 0.4 }, lineColor: INK,
    },
    columnStyles: { 0: { cellWidth: 70, halign: 'left' } },
    didParseCell: (data) => {
      if (data.section === 'body') {
        const r = body[data.row.index];
        if (r.isHeader) {
          data.cell.styles.fillColor = SOFT;
          data.cell.styles.lineWidth = { top: 0.2, bottom: 0.2 };
          data.cell.styles.lineColor = INK;
        } else {
          data.cell.styles.lineWidth = { bottom: 0.1 };
          data.cell.styles.lineColor = BORDER;
        }
      }
    },
    // Continuation pages get the page chrome + a "(continued)" heading
    // instead of an orphaned bare table.
    margin: { left: MARGIN.left, right: MARGIN.right, top: 38, bottom: 16 },
    didDrawPage: (data) => {
      if (data.pageNumber > 1) {
        drawHeader(doc, header);
        drawSectionHeading(doc, `${title} (continued)`, subtitle);
      }
    },
  });
}

// ── Staff detail page ──────────────────────────────────────────

function drawStaffPage(doc, { outputs, grouped, headers, entityIds, header }) {
  drawHeader(doc, header);
  drawSectionHeading(doc, 'Staff detail', 'FTE and cost by role, per period');

  // Replace HC integer with average-FTE decimal across periods in each
  // group. Mirrors StaffCostsView logic (sum HC across roles per period,
  // then average across the periods in the group).
  //
  // ALWAYS reads the raw outputs: the tagged per-entity staff_cost rows
  // this page needs don't exist in the scoped aggregate (it only carries
  // summary statement lines) — the location filter is applied here via
  // entityIds instead.
  const staff = buildStaffMatrix(outputs, grouped, entityIds);
  const fteByRoleGroup = computeFteByRoleGroup(outputs, grouped, entityIds);

  // Empty state — don't print a grid of dashes if there's no staff data
  // in scope (e.g. stale outputs from before headcount metrics existed).
  const anyStaff = STAFF_ROWS.some(row =>
    grouped.some((_, i) => (staff[row.role]?.[i]?.cost || 0) !== 0 || (fteByRoleGroup[row.role]?.[i] || 0) !== 0));
  if (!anyStaff) {
    doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.setTextColor(MUTED);
    doc.text('No staff cost data in scope for this scenario — recompute the forecast to populate this page.', MARGIN.left, 44);
    return;
  }

  // Multi-row header. Right-align both rows so they line up with the
  // numeric body cells underneath.
  const head1 = [{ content: 'Role', styles: { halign: 'left' } }];
  const head2 = [{ content: '', styles: { halign: 'left' } }];
  for (const h of headers) {
    head1.push({ content: h, colSpan: 2, styles: { halign: 'center' } });
    head2.push({ content: 'FTE', styles: { halign: 'right' } });
    head2.push({ content: 'Cost £', styles: { halign: 'right' } });
  }

  const body = [];
  const groupHeaderStyle = { fontStyle: 'bold', fillColor: '#eef2f7', textColor: INK, halign: 'left' };
  const sectionRow = (label) => [{ content: label, colSpan: 1 + 2 * grouped.length, styles: groupHeaderStyle }];

  const pushRoleRow = (row) => {
    const cells = [row.label];
    for (let i = 0; i < grouped.length; i++) {
      cells.push({ content: fmtFte(fteByRoleGroup[row.role]?.[i] ?? 0), styles: { halign: 'right' } });
      cells.push({ content: fmtP(staff[row.role][i].cost), styles: { halign: 'right' } });
    }
    body.push(cells);
  };

  body.push(sectionRow('Management'));
  for (const row of STAFF_ROWS.filter(r => r.group === 'mgmt')) pushRoleRow(row);
  body.push(sectionRow('Setting-level'));
  for (const row of STAFF_ROWS.filter(r => r.group === 'setting')) pushRoleRow(row);
  body.push(sectionRow('Direct staff (ratio-derived)'));
  for (const row of STAFF_ROWS.filter(r => r.group === 'direct')) pushRoleRow(row);

  // Totals row
  const totals = [{ content: 'TOTAL', styles: { halign: 'left', fontStyle: 'bold' } }];
  for (let i = 0; i < grouped.length; i++) {
    let fte = 0, cost = 0;
    for (const row of STAFF_ROWS) {
      fte += fteByRoleGroup[row.role]?.[i] ?? 0;
      cost += staff[row.role][i].cost;
    }
    totals.push({ content: fmtFte(fte), styles: { halign: 'right', fontStyle: 'bold' } });
    totals.push({ content: fmtP(cost), styles: { halign: 'right', fontStyle: 'bold' } });
  }
  body.push(totals);

  autoTable(doc, {
    startY: 38,
    head: [head1, head2],
    body,
    theme: 'plain',
    styles: { font: 'helvetica', fontSize: 7.5, cellPadding: { top: 1.4, right: 2.5, bottom: 1.4, left: 2.5 }, lineColor: BORDER, lineWidth: 0 },
    headStyles: { fontStyle: 'bold', fontSize: 7, textColor: MUTED, fillColor: SOFT, lineWidth: { bottom: 0.3 }, lineColor: INK },
    columnStyles: { 0: { cellWidth: 50, halign: 'left' } },
    didParseCell: (data) => {
      if (data.section === 'body') {
        data.cell.styles.lineWidth = { bottom: 0.05 };
        data.cell.styles.lineColor = BORDER;
      }
    },
    margin: { left: MARGIN.left, right: MARGIN.right },
  });
}

// Compute FTE per role per group: average HC across periods in the group.
function computeFteByRoleGroup(outputs, grouped, entityIds) {
  const inScope = (r) => !entityIds || r.entity_id == null || entityIds.has(r.entity_id);
  const out = {};
  for (const row of STAFF_ROWS) out[row.role] = grouped.map(() => 0);
  grouped.forEach((g, gi) => {
    const setP = new Set(g.periods);
    const hcByRolePeriod = {};
    for (const r of outputs) {
      if (r.nominal_type !== 'staff_cost') continue;
      if (r.module_key === 'pre_opening') continue;
      if (!setP.has(r.period)) continue;
      if (!inScope(r)) continue;
      const role = r.tags?.role; if (!role) continue;
      const hc = Number(r.tags?.headcount) || 0;
      (hcByRolePeriod[role] ||= {});
      hcByRolePeriod[role][r.period] = (hcByRolePeriod[role][r.period] || 0) + hc;
    }
    const denom = g.periods.length || 1;
    for (const row of STAFF_ROWS) {
      const byT = hcByRolePeriod[row.role] || {};
      let s = 0;
      for (const t of g.periods) s += (byT[t] || 0);
      out[row.role][gi] = s / denom;
    }
  });
  return out;
}

function fmtFte(n) {
  if (n == null || !isFinite(n)) return '–';
  if (n === 0) return '–';
  return Number(n).toFixed(1);
}

// ── Premises detail page ───────────────────────────────────────

function drawPremisesPage(doc, { outputs, grouped, headers, entityIds, header }) {
  drawHeader(doc, header);
  drawSectionHeading(doc, 'Premises & overheads detail', 'Cost lines by category, per period');

  // Split rows into ongoing (recurring overheads + capex + depreciation)
  // vs pre-opening so each block is grouped under its own banner.
  // Raw outputs only — the scoped aggregate has no per-line labels; the
  // location filter is applied via entityIds.
  const src = outputs;
  const allRows = buildPremisesMatrix(src, grouped, entityIds);

  const inScope = (r) => !entityIds || r.entity_id == null || entityIds.has(r.entity_id);
  // Build a separate per-(entity, label) pre-opening matrix so each
  // location's pre-opening lines surface as their own row.
  const preOpenMap = new Map();
  for (const r of src) {
    if (!inScope(r)) continue;
    if (r.module_key !== 'pre_opening' && !/^Pre-opening/i.test(r.line_label || '')) continue;
    if (r.nominal_type !== 'overhead' && r.nominal_type !== 'staff_cost') continue;
    const lbl = r.line_label || '(unlabelled)';
    const key = `${r.entity_id || 'group'}::${lbl}`;
    if (!preOpenMap.has(key)) preOpenMap.set(key, { label: lbl, kind: r.nominal_type, values: grouped.map(() => 0) });
    const ref = preOpenMap.get(key);
    grouped.forEach((g, gi) => {
      if (g.periods.includes(r.period)) ref.values[gi] += r.amount_p;
    });
  }
  const preOpenRows = Array.from(preOpenMap.values())
    .filter(r => r.values.some(v => v !== 0));

  // Pre-opening line labels to filter OUT of the ongoing matrix (so we
  // don't double-count). buildPremisesMatrix doesn't include pre-opening
  // currently, but defensively strip it.
  const ongoingRows = allRows.filter(r =>
    !/^Pre-opening/i.test(r.label || '')
  );

  const totalAcrossRows = (rs, gi) => rs.reduce((s, r) => s + r.values[gi], 0);

  // Empty state — skip the dash-grid when nothing is in scope.
  const anyPremises = grouped.some((_, gi) =>
    totalAcrossRows(ongoingRows, gi) !== 0 || totalAcrossRows(preOpenRows, gi) !== 0);
  if (!anyPremises) {
    doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.setTextColor(MUTED);
    doc.text('No premises or overhead cost data in scope for this scenario — recompute the forecast to populate this page.', MARGIN.left, 44);
    return;
  }

  const body = [];
  const sectionRow = (label) => [{
    content: label, colSpan: 2 + grouped.length,
    styles: { halign: 'left', fontStyle: 'bold', fontSize: 7, textColor: MUTED, fillColor: '#eef2f7' },
  }];

  // Ongoing block
  body.push(sectionRow('Ongoing operating costs'));
  for (const r of ongoingRows) {
    body.push([
      { content: `${r.label}`, styles: { fontStyle: 'normal' } },
      { content: r.kind, styles: { textColor: MUTED, fontSize: 6.5 } },
      ...r.values.map(v => ({ content: fmtP(v), styles: { halign: 'right' } })),
    ]);
  }
  body.push([
    { content: 'Subtotal — ongoing', styles: { fontStyle: 'bold', fillColor: SOFT } },
    { content: '', styles: { fillColor: SOFT } },
    ...grouped.map((_, gi) => ({
      content: fmtP(totalAcrossRows(ongoingRows, gi)),
      styles: { halign: 'right', fontStyle: 'bold', fillColor: SOFT },
    })),
  ]);

  // Pre-opening block
  body.push(sectionRow('Pre-opening (one-off setup)'));
  if (preOpenRows.length === 0) {
    body.push([
      { content: '— none in scope —', colSpan: 2 + grouped.length, styles: { halign: 'left', textColor: MUTED, fontStyle: 'italic' } },
    ]);
  } else {
    for (const r of preOpenRows) {
      body.push([
        { content: `${r.label}`, styles: { fontStyle: 'normal' } },
        { content: r.kind, styles: { textColor: MUTED, fontSize: 6.5 } },
        ...r.values.map(v => ({ content: fmtP(v), styles: { halign: 'right' } })),
      ]);
    }
    body.push([
      { content: 'Subtotal — pre-opening', styles: { fontStyle: 'bold', fillColor: SOFT } },
      { content: '', styles: { fillColor: SOFT } },
      ...grouped.map((_, gi) => ({
        content: fmtP(totalAcrossRows(preOpenRows, gi)),
        styles: { halign: 'right', fontStyle: 'bold', fillColor: SOFT },
      })),
    ]);
  }

  // Grand total
  body.push([
    { content: 'TOTAL', styles: { fontStyle: 'bold', fillColor: '#0f172a', textColor: '#fff' } },
    { content: '', styles: { fillColor: '#0f172a' } },
    ...grouped.map((_, gi) => ({
      content: fmtP(totalAcrossRows(ongoingRows, gi) + totalAcrossRows(preOpenRows, gi)),
      styles: { halign: 'right', fontStyle: 'bold', fillColor: '#0f172a', textColor: '#fff' },
    })),
  ]);

  const premisesHeadRow = [
    { content: 'Line', styles: { halign: 'left' } },
    { content: 'Type', styles: { halign: 'left' } },
    ...headers.map(h => ({ content: h, styles: { halign: 'right' } })),
  ];

  autoTable(doc, {
    startY: 38,
    head: [premisesHeadRow],
    body,
    theme: 'plain',
    styles: { font: 'helvetica', fontSize: 8, cellPadding: { top: 1.4, right: 3, bottom: 1.4, left: 3 }, lineColor: BORDER, lineWidth: 0 },
    headStyles: { fontStyle: 'bold', fontSize: 7, textColor: MUTED, fillColor: SOFT, lineWidth: { bottom: 0.3 }, lineColor: INK },
    columnStyles: { 0: { cellWidth: 60, halign: 'left' }, 1: { cellWidth: 18, halign: 'left' } },
    didParseCell: (data) => {
      if (data.section === 'body') {
        data.cell.styles.lineWidth = { bottom: 0.05 };
        data.cell.styles.lineColor = BORDER;
      }
    },
    margin: { left: MARGIN.left, right: MARGIN.right },
  });
}

// ── Income page ───────────────────────────────────────────────

function drawIncomePage(doc, { incomeRows, year, header }) {
  drawHeader(doc, header);
  drawSectionHeading(doc, 'Income analysis', `LA-first hours allocation by age band — Y${year}`);

  // Match the new on-screen cascade: Capacity → Children → Hours
  // (Max / LA / Private / Total) → Rates (LA / Private) → Revenue (LA / Private)
  const head = [{
    Role: 'Age band', cap: 'Capacity', occ: 'Avg occ.', kids: 'Children',
    maxH: 'Max hrs/yr', laH: 'LA hrs/yr', pvtH: 'Private hrs/yr', totH: 'Total hrs/yr',
    laR: 'LA £/hr', pvtR: 'Private £/hr',
    laRev: 'LA rev', pvtRev: 'Private rev', totRev: 'Total rev',
  }];

  const headRow = [
    { content: 'Age band', styles: { halign: 'left' } },
    { content: 'Capacity',  styles: { halign: 'right' } },
    { content: 'Avg occ.',  styles: { halign: 'right' } },
    { content: 'Children',  styles: { halign: 'right' } },
    { content: 'Max hrs/yr', styles: { halign: 'right' } },
    { content: 'LA hrs/yr',  styles: { halign: 'right', textColor: '#7c3aed' } },
    { content: 'Private hrs/yr', styles: { halign: 'right', textColor: ACCENT } },
    { content: 'Total hrs/yr',   styles: { halign: 'right' } },
    { content: 'LA £/hr',     styles: { halign: 'right', textColor: '#7c3aed' } },
    { content: 'Private £/hr',styles: { halign: 'right', textColor: ACCENT } },
    { content: 'LA rev',      styles: { halign: 'right', textColor: '#7c3aed' } },
    { content: 'Private rev', styles: { halign: 'right', textColor: ACCENT } },
    { content: 'Total rev',   styles: { halign: 'right' } },
  ];

  const body = incomeRows.map(r => [
    { content: r.label, styles: { fontStyle: 'bold', halign: 'left' } },
    { content: fmtN(r.capacity), styles: { halign: 'right' } },
    { content: fmtPct(r.avgOccPct), styles: { halign: 'right' } },
    { content: fmtN(r.children, 1), styles: { halign: 'right' } },
    { content: fmtN(r.annualMax), styles: { halign: 'right' } },
    { content: fmtN(r.annualLA), styles: { halign: 'right', textColor: '#7c3aed' } },
    { content: fmtN(r.annualPrivate), styles: { halign: 'right', textColor: ACCENT } },
    { content: fmtN(r.annualTotal), styles: { halign: 'right', fontStyle: 'bold' } },
    { content: fmtRateP(r.laRateP), styles: { halign: 'right', textColor: '#7c3aed' } },
    { content: fmtRateP(r.hourlyPrivateP), styles: { halign: 'right', textColor: ACCENT } },
    { content: fmtP(r.revenueLA), styles: { halign: 'right', textColor: '#7c3aed' } },
    { content: fmtP(r.revenuePrivate), styles: { halign: 'right', textColor: ACCENT } },
    { content: fmtP(r.revenueTotal), styles: { halign: 'right', fontStyle: 'bold' } },
  ]);

  const T = incomeRows.reduce((acc, r) => ({
    capacity: acc.capacity + (r.capacity || 0),
    children: acc.children + (r.children || 0),
    annualMax: acc.annualMax + (r.annualMax || 0),
    annualLA: acc.annualLA + (r.annualLA || 0),
    annualPrivate: acc.annualPrivate + (r.annualPrivate || 0),
    annualTotal: acc.annualTotal + (r.annualTotal || 0),
    revLA: acc.revLA + (r.revenueLA || 0),
    revPvt: acc.revPvt + (r.revenuePrivate || 0),
    revTot: acc.revTot + (r.revenueTotal || 0),
  }), { capacity: 0, children: 0, annualMax: 0, annualLA: 0, annualPrivate: 0, annualTotal: 0, revLA: 0, revPvt: 0, revTot: 0 });

  body.push([
    { content: 'All bands', styles: { fontStyle: 'bold', fillColor: SOFT, halign: 'left' } },
    { content: fmtN(T.capacity), styles: { halign: 'right', fontStyle: 'bold', fillColor: SOFT } },
    { content: '—', styles: { halign: 'right', fillColor: SOFT } },
    { content: fmtN(T.children, 1), styles: { halign: 'right', fontStyle: 'bold', fillColor: SOFT } },
    { content: fmtN(T.annualMax), styles: { halign: 'right', fontStyle: 'bold', fillColor: SOFT } },
    { content: fmtN(T.annualLA), styles: { halign: 'right', fontStyle: 'bold', fillColor: SOFT, textColor: '#7c3aed' } },
    { content: fmtN(T.annualPrivate), styles: { halign: 'right', fontStyle: 'bold', fillColor: SOFT, textColor: ACCENT } },
    { content: fmtN(T.annualTotal), styles: { halign: 'right', fontStyle: 'bold', fillColor: SOFT } },
    { content: '—', styles: { halign: 'right', fillColor: SOFT } },
    { content: '—', styles: { halign: 'right', fillColor: SOFT } },
    { content: fmtP(T.revLA), styles: { halign: 'right', fontStyle: 'bold', fillColor: SOFT, textColor: '#7c3aed' } },
    { content: fmtP(T.revPvt), styles: { halign: 'right', fontStyle: 'bold', fillColor: SOFT, textColor: ACCENT } },
    { content: fmtP(T.revTot), styles: { halign: 'right', fontStyle: 'bold', fillColor: SOFT } },
  ]);

  autoTable(doc, {
    startY: 38,
    head: [headRow], body, theme: 'plain',
    styles: { font: 'helvetica', fontSize: 7, cellPadding: { top: 1.4, right: 2, bottom: 1.4, left: 2 }, lineColor: BORDER, lineWidth: 0 },
    headStyles: { fontStyle: 'bold', fontSize: 6.5, textColor: MUTED, fillColor: SOFT, lineWidth: { bottom: 0.3 }, lineColor: INK },
    columnStyles: { 0: { cellWidth: 22, halign: 'left' } },
    didParseCell: (data) => {
      if (data.section === 'body') {
        data.cell.styles.lineWidth = { bottom: 0.05 };
        data.cell.styles.lineColor = BORDER;
      }
    },
    margin: { left: MARGIN.left, right: MARGIN.right },
  });

  // Revenue mix by age band — private vs LA funded, stacked.
  const mixRows = incomeRows
    .filter(r => (r.revenuePrivate || 0) + (r.revenueLA || 0) > 0)
    .map(r => ({ label: r.label, parts: [r.revenuePrivate || 0, r.revenueLA || 0] }));
  if (mixRows.length > 0) {
    drawStackedBars(doc, {
      x: MARGIN.left, y: doc.lastAutoTable.finalY + 8,
      w: (PAGE.w - MARGIN.left - MARGIN.right) * 0.62,
      h: 10 + mixRows.length * 9,
      title: `Revenue mix by age band — Y${year}`,
      rows: mixRows,
      series: [
        { label: 'Private fees', color: SERIES[0] },
        { label: 'LA funded', color: SERIES[1] },
      ],
    });
  }
}

// ── Executive summary — the story ─────────────────────────────
//
// The page a lender or investor reads first: four headline tiles, two
// charts (income build-up, cash position) and an auto-written narrative
// derived from the numbers — steady state, break-even, cash trough,
// funding need, end state.

function computeStory({ src, rawOutputs, periods, openingPeriod, entities, entityIds }) {
  const n = periods.length;
  const revenue = new Array(n).fill(0);
  const costs = new Array(n).fill(0);
  const ebitda = new Array(n).fill(0);
  const cash = new Array(n).fill(null);
  let openingCash = null;
  for (const r of src) {
    const t = r.period;
    if (t == null || t < 0 || t >= n) continue;
    switch (r.nominal_type) {
      case 'pnl.revenue_total': revenue[t] += r.amount_p; break;
      case 'pnl.cost_total':    costs[t]   += -r.amount_p; break;
      case 'pnl.ebitda':        ebitda[t]  += r.amount_p; break;
      case 'bs.cash':           cash[t]     = r.amount_p; break;
      case 'cf.opening_cash':   if (t === 0) openingCash = r.amount_p; break;
    }
  }

  // Capacity-weighted group occupancy from the engine's persisted rows —
  // per-entity rows only exist on the RAW outputs, not the scoped aggregate.
  const occIdx = buildOccupancyIndex(rawOutputs || src);
  const inScope = entities.filter(e => !entityIds || entityIds.has(e.id));
  const occ = new Array(n).fill(null);
  for (let t = 0; t < n; t++) {
    let wsum = 0, w = 0;
    for (const e of inScope) {
      const caps = e.config?.capacity_by_age_band || {};
      for (const band of Object.keys(caps)) {
        const c = caps[band] || 0;
        if (!c) continue;
        const o = occIdx.get(occKey(e.id, band, t));
        if (o == null) continue;
        wsum += c * o; w += c;
      }
    }
    if (w > 0) occ[t] = wsum / w;
  }

  // Steady state: first month within half a point of the occupancy peak.
  let steadyMonth = null;
  const occMax = Math.max(...occ.map(v => v ?? -1));
  if (occMax > 0) steadyMonth = occ.findIndex(v => v != null && v >= occMax - 0.5);

  // EBITDA-positive: first month positive and staying positive next 2.
  let ebitdaPosMonth = null;
  for (let t = 0; t < n; t++) {
    if (ebitda[t] > 0 && (t + 1 >= n || ebitda[t + 1] > 0) && (t + 2 >= n || ebitda[t + 2] > 0)) { ebitdaPosMonth = t; break; }
  }

  let cashMin = Infinity, cashMinIdx = null, cashEnd = null;
  for (let t = 0; t < n; t++) {
    if (cash[t] == null) continue;
    if (cash[t] < cashMin) { cashMin = cash[t]; cashMinIdx = t; }
    cashEnd = cash[t];
  }
  if (!isFinite(cashMin)) { cashMin = null; }

  // One-off investment in the first 12 months (capex + pre-opening) —
  // line-level rows live on the RAW outputs; scope via entityIds.
  const rowInScope = (r) => !entityIds || r.entity_id == null || entityIds.has(r.entity_id);
  let oneOff12 = 0;
  for (const r of (rawOutputs || src)) {
    if (r.period == null || r.period >= Math.min(12, n)) continue;
    if (!rowInScope(r)) continue;
    if (r.nominal_type === 'capex') oneOff12 += r.amount_p;
    else if ((r.module_key === 'pre_opening' || /^Pre-opening/i.test(r.line_label || '')) &&
             (r.nominal_type === 'overhead' || r.nominal_type === 'staff_cost')) oneOff12 += r.amount_p;
  }

  // Headcount / site metrics are group-level — only meaningful (and only
  // read) when the export isn't filtered to a subset of locations.
  const lastNT = (nt) => {
    if (entityIds) return null;
    let bestT = -1, bestV = null;
    for (const r of (rawOutputs || src)) if (r.nominal_type === nt && r.period > bestT) { bestT = r.period; bestV = r.amount_p; }
    return bestV;
  };

  return {
    revenue, costs, ebitda, cash, occ,
    openingCash, steadyMonth, ebitdaPosMonth,
    cashMin, cashMinIdx, cashEnd, oneOff12,
    headcountEnd: lastNT('metric.headcount_total'),
    locationsEnd: lastNT('metric.locations_active'),
  };
}

function drawExecutiveSummary(doc, { outputs, scopedOutputs, periods, openingPeriod, entities, entityIds, header }) {
  drawHeader(doc, header);
  drawSectionHeading(doc, 'Executive summary', 'The plan at a glance — build-up, profitability and cash');

  const src = scopedOutputs || outputs;
  const story = computeStory({ src, rawOutputs: outputs, periods, openingPeriod, entities, entityIds });
  const n = periods.length;
  const mLabel = (t) => monthLabel(t, openingPeriod);

  // ── KPI tiles ────────────────────────────────────────────────
  const steady = story.steadyMonth;
  const steadyRevenueYr = steady != null ? story.revenue[Math.min(steady, n - 1)] * 12 : null;
  let steadyMarginPct = null;
  if (steady != null) {
    let r12 = 0, e12 = 0;
    for (let t = steady; t < Math.min(steady + 12, n); t++) { r12 += story.revenue[t]; e12 += story.ebitda[t]; }
    if (r12 > 0) steadyMarginPct = (e12 / r12) * 100;
  }
  const kpis = [
    { label: 'Steady-state revenue', value: steadyRevenueYr != null ? fmtMoney(steadyRevenueYr) + '/yr' : '—',
      hint: steady != null ? `run-rate from ${mLabel(steady)}` : null },
    { label: 'EBITDA margin at steady state', value: steadyMarginPct != null ? steadyMarginPct.toFixed(1) + '%' : '—',
      hint: story.ebitdaPosMonth != null ? `profitable from ${mLabel(story.ebitdaPosMonth)}` : null },
    { label: 'Lowest cash point', value: story.cashMin != null ? fmtMoney(story.cashMin) : '—',
      hint: story.cashMinIdx != null ? `in ${mLabel(story.cashMinIdx)}${entityIds ? ' · scope capital only' : ''}` : null },
    { label: `Cash at end of plan`, value: story.cashEnd != null ? fmtMoney(story.cashEnd) : '—',
      hint: entityIds ? 'from capital attributed to this scope' : `${mLabel(n - 1)} · ${Math.round(n / 12)}-year horizon` },
  ];
  const stripY = 38;
  const colW = (PAGE.w - MARGIN.left - MARGIN.right) / kpis.length;
  kpis.forEach((k, i) => {
    const x = MARGIN.left + i * colW;
    doc.setDrawColor(BORDER); doc.setLineWidth(0.3);
    doc.rect(x + 1, stripY, colW - 2, 22);
    doc.setFillColor(ACCENT);
    doc.rect(x + 1, stripY, 1.1, 22, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(MUTED);
    doc.text(k.label.toUpperCase(), x + 5, stripY + 5.5);
    doc.setFont('times', 'normal'); doc.setFontSize(15); doc.setTextColor(INK);
    doc.text(k.value, x + 5, stripY + 14);
    if (k.hint) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(MUTED);
      doc.text(k.hint, x + 5, stripY + 19);
    }
  });

  // ── Charts ───────────────────────────────────────────────────
  const chartY = stripY + 28;
  const chartH = 62;
  const chartW = (PAGE.w - MARGIN.left - MARGIN.right - 8) / 2;
  const xLabelAt = (i) => (i % 12 === 0 || i === n - 1) ? mLabel(i) : null;

  const annotations1 = [];
  if (steady != null && steady > 0 && steady < n - 1) {
    annotations1.push({ series: 0, index: steady, text: `steady state · ${mLabel(steady)}` });
  }
  drawLineChart(doc, {
    x: MARGIN.left, y: chartY, w: chartW, h: chartH,
    title: 'Income build-up — monthly revenue vs operating costs',
    series: [
      { label: 'Revenue', color: SERIES[0], values: story.revenue },
      { label: 'Operating costs', color: SERIES[1], values: story.costs },
    ],
    xLabelAt, fillFirst: true, annotations: annotations1,
  });

  const annotations2 = [];
  if (story.cashMinIdx != null && story.cashMin != null) {
    annotations2.push({ series: 0, index: story.cashMinIdx, text: `low point ${fmtMoney(story.cashMin)}`, below: story.cashMin >= 0 ? false : true });
  }
  drawLineChart(doc, {
    x: MARGIN.left + chartW + 8, y: chartY, w: chartW, h: chartH,
    title: 'Cash position — closing balance by month',
    series: [{ label: 'Closing cash', color: SERIES[2], values: story.cash.map(v => v ?? 0) }],
    xLabelAt, fillFirst: true, annotations: annotations2,
  });

  // ── The story — auto-written narrative ───────────────────────
  const storyY = chartY + chartH + 8;
  doc.setDrawColor(INK); doc.setLineWidth(0.4);
  doc.line(MARGIN.left, storyY, PAGE.w - MARGIN.right, storyY);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(MUTED);
  doc.text('THE STORY IN THE NUMBERS', MARGIN.left, storyY + 6);

  const bullets = [];
  if (story.occ[0] != null && steady != null) {
    bullets.push({
      title: 'Build-up',
      text: `The group opens at ${story.occ[0].toFixed(0)}% average occupancy and reaches its steady ${(Math.max(...story.occ.map(v => v ?? 0))).toFixed(0)}% by ${mLabel(steady)}.`,
    });
  }
  if (steady != null) {
    bullets.push({
      title: 'Income',
      text: `Monthly income builds from ${fmtMoney(story.revenue[0])} at opening to ${fmtMoney(story.revenue[Math.min(steady, n - 1)])} a month at steady state — ${fmtMoney(steadyRevenueYr)} a year.`,
    });
  }
  if (story.ebitdaPosMonth != null) {
    bullets.push({
      title: 'Profitability',
      text: `The plan is EBITDA-positive from ${mLabel(story.ebitdaPosMonth)} (month ${story.ebitdaPosMonth + 1})${steadyMarginPct != null ? ` and margins settle at ~${steadyMarginPct.toFixed(0)}%` : ''}.`,
    });
  }
  if (story.cashMin != null) {
    const basis = entityIds ? ' Basis: capital attributed to these locations; central / unallocated cash excluded.' : '';
    bullets.push({
      title: 'Cash & funding',
      text: (story.cashMin < 0
        ? `Cash bottoms out at ${fmtMoney(story.cashMin)} in ${mLabel(story.cashMinIdx)} — this scope needs ${fmtMoney(-story.cashMin)} of funding.`
        : `Cash never goes below ${fmtMoney(story.cashMin)} (${mLabel(story.cashMinIdx)}) — the plan self-funds.`) + basis,
    });
  }
  if (story.oneOff12 > 0) {
    bullets.push({
      title: 'Investment',
      text: `One-off setup spend of ${fmtMoney(story.oneOff12)} in the first 12 months (fit-out, equipment and pre-opening costs).`,
    });
  }
  if (story.cashEnd != null) {
    const endBits = [`${fmtMoney(story.cashEnd)} cash`];
    if (story.headcountEnd) endBits.push(`${Math.round(story.headcountEnd)} staff`);
    if (story.locationsEnd) endBits.push(`${Math.round(story.locationsEnd)} site${story.locationsEnd === 1 ? '' : 's'}`);
    bullets.push({
      title: 'End state',
      text: `By ${mLabel(n - 1)} the group holds ${endBits.join(', ')}.`,
    });
  }

  const cols = 3;
  const cellW = (PAGE.w - MARGIN.left - MARGIN.right - (cols - 1) * 8) / cols;
  bullets.slice(0, 6).forEach((b, i) => {
    const cx = MARGIN.left + (i % cols) * (cellW + 8);
    const cy = storyY + 12 + Math.floor(i / cols) * 20;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(ACCENT);
    doc.text(b.title.toUpperCase(), cx, cy);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(INK);
    const wrapped = doc.splitTextToSize(b.text, cellW);
    doc.text(wrapped.slice(0, 4), cx, cy + 4);
  });
}

// ── Executive dashboard page ──────────────────────────────────
//
// One-pager partner-level summary: per-year revenue / EBITDA / NPAT /
// closing cash + a small KPI strip up top. No tables of monthly cells.

function drawExecutiveDashboard(doc, { outputs, scopedOutputs, periods, openingPeriod, year, header }) {
  drawHeader(doc, header);
  drawSectionHeading(doc, 'Executive dashboard', 'Headline metrics across the forecast horizon');

  const src = scopedOutputs || outputs;
  const horizonMonths = periods.length;
  const horizonYears = Math.max(1, Math.ceil(horizonMonths / 12));
  const yearGroups = [];
  for (let y = 0; y < horizonYears; y++) {
    const start = y * 12;
    const end = Math.min(start + 12, horizonMonths);
    if (end <= start) break;
    yearGroups.push({ label: `Y${y + 1}`, periods: periods.slice(start, end), startIdx: start, endIdx: end });
  }

  const sumNT = (nt, ps) => {
    const setP = new Set(ps); let s = 0;
    for (const r of src) if (r.nominal_type === nt && setP.has(r.period)) s += r.amount_p;
    return s;
  };
  const lastNT = (nt, ps) => {
    let bestT = -1, bestV = null; const setP = new Set(ps);
    for (const r of src) if (r.nominal_type === nt && setP.has(r.period) && r.period > bestT) { bestT = r.period; bestV = r.amount_p; }
    return bestV;
  };

  // KPI strip: Y3 revenue / EBITDA % / closing cash / horizon
  const yIdx = Math.min(year, horizonYears) - 1;
  const yPeriods = yearGroups[yIdx]?.periods || [];
  const revY = sumNT('pnl.revenue_total', yPeriods);
  const ebitdaY = sumNT('pnl.ebitda', yPeriods);
  const closingCash = lastNT('bs.cash', periods);
  const headcountEnd = lastNT('metric.headcount_total', periods);
  const locationsEnd = lastNT('metric.locations_active', periods);
  const ebitdaPct = revY > 0 ? (ebitdaY / revY) * 100 : null;

  const kpis = [
    { label: `Revenue Y${year}`, value: fmtMoney(revY) },
    { label: `EBITDA Y${year}`, value: fmtMoney(ebitdaY), hint: ebitdaPct != null ? ebitdaPct.toFixed(1) + '% margin' : null },
    { label: 'Closing cash', value: fmtMoney(closingCash) },
    // End-state only when the engine emitted the metrics (stale outputs
    // from an old recompute won't have them — show horizon instead).
    (headcountEnd != null || locationsEnd != null)
      ? { label: 'End-state', value: `${Math.round(headcountEnd ?? 0)} staff · ${Math.round(locationsEnd ?? 0)} site${(locationsEnd ?? 0) === 1 ? '' : 's'}` }
      : { label: 'Horizon', value: `${horizonYears} years` },
  ];

  const stripY = 40;
  const colW = (PAGE.w - MARGIN.left - MARGIN.right) / kpis.length;
  kpis.forEach((k, i) => {
    const x = MARGIN.left + i * colW;
    doc.setDrawColor(BORDER); doc.setLineWidth(0.3);
    doc.rect(x + 1, stripY, colW - 2, 24);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(MUTED);
    doc.text((k.label || '').toUpperCase(), x + 5, stripY + 6);
    doc.setFont('times', 'normal'); doc.setFontSize(15); doc.setTextColor(INK);
    doc.text(k.value || '—', x + 5, stripY + 16);
    if (k.hint) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(MUTED);
      doc.text(k.hint, x + 5, stripY + 21);
    }
  });

  // Per-year table
  const headRow = [
    { content: 'Metric', styles: { halign: 'left' } },
    ...yearGroups.map(g => ({ content: g.label, styles: { halign: 'right' } })),
  ];

  const ROWS = [
    { label: 'Revenue',                fn: g => sumNT('pnl.revenue_total', g.periods),     bold: true },
    { label: '  of which: private',    fn: g => sumNT('pnl.revenue_private', g.periods) },
    { label: '  of which: LA funded',  fn: g => sumNT('pnl.revenue_la_funded', g.periods) },
    { label: 'Operating costs',        fn: g => sumNT('pnl.cost_total', g.periods) },
    { label: 'EBITDA',                 fn: g => sumNT('pnl.ebitda', g.periods), bold: true },
    { label: '  EBITDA %',             fn: g => { const r = sumNT('pnl.revenue_total', g.periods); const e = sumNT('pnl.ebitda', g.periods); return r > 0 ? (e / r) * 100 : null; }, isPct: true },
    { label: 'NPAT',                   fn: g => sumNT('pnl.npat', g.periods), bold: true },
    { label: '  NPAT %',               fn: g => { const r = sumNT('pnl.revenue_total', g.periods); const n = sumNT('pnl.npat', g.periods); return r > 0 ? (n / r) * 100 : null; }, isPct: true },
    { label: 'Closing cash',           fn: g => lastNT('bs.cash', g.periods), bold: true },
    { label: 'Total debt (period end)',fn: g => lastNT('bs.debt', g.periods) },
    { label: 'Headcount (period end)', fn: g => lastNT('metric.headcount_total', g.periods), isCount: true },
    { label: 'Active locations',       fn: g => lastNT('metric.locations_active', g.periods), isCount: true },
  ];

  const body = ROWS.map(r => {
    const cells = [{ content: r.label, styles: { halign: 'left', fontStyle: r.bold ? 'bold' : 'normal' } }];
    for (const g of yearGroups) {
      const v = r.fn(g);
      const txt = r.isPct ? (v == null ? '—' : v.toFixed(1) + '%')
                  : r.isCount ? (v == null ? '—' : Math.round(v).toLocaleString('en-GB'))
                  : fmtMoney(v);
      cells.push({ content: txt, styles: { halign: 'right', fontStyle: r.bold ? 'bold' : 'normal' } });
    }
    return cells;
  });

  autoTable(doc, {
    startY: stripY + 32,
    head: [headRow], body, theme: 'plain',
    styles: { font: 'helvetica', fontSize: 8, cellPadding: { top: 1.8, right: 3, bottom: 1.8, left: 3 }, lineColor: BORDER, lineWidth: 0 },
    headStyles: { fontStyle: 'bold', fontSize: 7.5, textColor: MUTED, fillColor: SOFT, lineWidth: { bottom: 0.4 }, lineColor: INK },
    columnStyles: { 0: { cellWidth: 60, halign: 'left' } },
    didParseCell: (data) => {
      if (data.section === 'body') {
        data.cell.styles.lineWidth = { bottom: 0.1 };
        data.cell.styles.lineColor = BORDER;
      }
    },
    margin: { left: MARGIN.left, right: MARGIN.right },
  });

  // Annual revenue vs EBITDA columns — only when there's real room left.
  const chartTop = doc.lastAutoTable.finalY + 6;
  const chartH = PAGE.h - 16 - chartTop;
  if (chartH >= 26) {
    drawColumnChart(doc, {
      x: MARGIN.left, y: chartTop, w: PAGE.w - MARGIN.left - MARGIN.right, h: Math.min(chartH, 46),
      title: 'Revenue vs EBITDA by year',
      groups: yearGroups.map(g => g.label),
      series: [
        { label: 'Revenue', color: SERIES[0], values: yearGroups.map(g => sumNT('pnl.revenue_total', g.periods)) },
        { label: 'EBITDA',  color: SERIES[1], values: yearGroups.map(g => sumNT('pnl.ebitda', g.periods)) },
      ],
    });
  }
}

// ── Road to Market — 12-month investment cashflow ───────────────
//
// A signed-off "what does it cost to get this open" cashflow with
// running cash. Monthly columns for the first 12 periods.

function drawRoadToMarket(doc, { outputs, scopedOutputs, periods, openingPeriod, entityIds, header }) {
  drawHeader(doc, header);
  drawSectionHeading(doc, 'Road to market', 'Executive investment summary — cash flow, first 12 months');

  const src = scopedOutputs || outputs;
  const horizon = Math.min(12, periods.length);
  const monthPeriods = periods.slice(0, horizon);
  const headers = monthPeriods.map(p => monthLabel(p, openingPeriod));

  const sumAt = (nt, t) => {
    let s = 0; for (const r of src) if (r.nominal_type === nt && r.period === t) s += r.amount_p; return s;
  };
  const valAt = (nt, t) => {
    for (const r of src) if (r.nominal_type === nt && r.period === t) return r.amount_p; return 0;
  };

  // Per-month figures.
  // Note: cf.* outputs are signed (in = positive, out = negative). We
  // surface them with consistent +/- so the running cash adds cleanly.
  const startingCashM0 = valAt('cf.opening_cash', monthPeriods[0]);

  // Per-month: read every cash component the engine emits so the
  // displayed rows always reconcile to opening + Σ movements = closing.
  const monthRows = monthPeriods.map(t => {
    const opening   = valAt('cf.opening_cash', t);
    const capex     = -valAt('cf.out.capex', t);                              // positive = outflow magnitude
    const preOpen   = -valAt('cf.out.pre_opening', t);
    const opIncome  = valAt('cf.in.private', t) + valAt('cf.in.la_funded', t);
    // Recurring operating costs ONLY — exclude interest/tax/divs which
    // sit in the financing & tax block below.
    const opCosts   = -(
      valAt('cf.out.staff', t) + valAt('cf.out.premises', t) +
      valAt('cf.out.utilities', t) + valAt('cf.out.other_overhead', t)
    );
    const drawdown  = valAt('cf.in.debt_drawdown', t);
    const interest  = -valAt('cf.out.interest', t);
    const principal = -valAt('cf.out.principal', t);
    const tax       = -valAt('cf.out.tax', t);
    const dividends = -valAt('cf.out.dividends', t);
    const wcMove    = valAt('cf.wc_movement', t);                             // signed (outflow = negative)
    const closing   = valAt('cf.closing_cash', t);
    return { t, opening, capex, preOpen, opIncome, opCosts, drawdown, interest, principal, tax, dividends, wcMove, closing };
  });

  const totals = monthRows.reduce((a, r) => ({
    capex:     a.capex     + r.capex,
    preOpen:   a.preOpen   + r.preOpen,
    opIncome:  a.opIncome  + r.opIncome,
    opCosts:   a.opCosts   + r.opCosts,
    drawdown:  a.drawdown  + r.drawdown,
    interest:  a.interest  + r.interest,
    principal: a.principal + r.principal,
    tax:       a.tax       + r.tax,
    dividends: a.dividends + r.dividends,
    wcMove:    a.wcMove    + r.wcMove,
  }), { capex: 0, preOpen: 0, opIncome: 0, opCosts: 0, drawdown: 0, interest: 0, principal: 0, tax: 0, dividends: 0, wcMove: 0 });

  // Build the row set — sectioned with subtotals so the eye reads down
  // grouped flows. Each non-header row contributes signed £ to net movement;
  // the engine's closing_cash row sits at the bottom and ties to the sum.
  const ROWS = [
    { label: 'Opening cash',          vals: monthRows.map(r => r.opening),   bold: true, fill: '#f1f5f9' },

    { label: 'One-off cash out',      section: true },
    { label: 'Capex',                 vals: monthRows.map(r => -r.capex),    neg: true, indent: true },
    { label: 'Pre-opening',           vals: monthRows.map(r => -r.preOpen),  neg: true, indent: true },
    { label: 'Total one-off',         vals: monthRows.map(r => -r.capex - r.preOpen), bold: true, neg: true },

    { label: 'Recurring operating',   section: true },
    { label: 'Operating income',      vals: monthRows.map(r => r.opIncome),  indent: true },
    { label: 'Operating costs',       vals: monthRows.map(r => -r.opCosts),  neg: true, indent: true },
    { label: 'Total recurring',       vals: monthRows.map(r => r.opIncome - r.opCosts), bold: true },

    { label: 'Financing & tax',       section: true },
    { label: 'Debt drawdown',         vals: monthRows.map(r => r.drawdown),   indent: true },
    { label: 'Interest',              vals: monthRows.map(r => -r.interest),  neg: true, indent: true },
    { label: 'Principal repayments',  vals: monthRows.map(r => -r.principal), neg: true, indent: true },
    { label: 'Tax paid',              vals: monthRows.map(r => -r.tax),       neg: true, indent: true },
    { label: 'Dividends',             vals: monthRows.map(r => -r.dividends), neg: true, indent: true },
    { label: 'Total financing & tax', vals: monthRows.map(r => r.drawdown - r.interest - r.principal - r.tax - r.dividends), bold: true },

    // r.wcMove is the engine's `cf.wc_movement` value, already signed
    // (outflow = negative). Display it as-is and ADD it to the net.
    { label: 'Working capital movement', vals: monthRows.map(r => r.wcMove) },

    { label: 'Net cash movement',     vals: monthRows.map(r =>
      -r.capex - r.preOpen + r.opIncome - r.opCosts +
      r.drawdown - r.interest - r.principal - r.tax - r.dividends + r.wcMove
    ), bold: true, fill: SOFT },
    { label: 'Closing cash',          vals: monthRows.map(r => r.closing), bold: true, isClose: true, fill: '#f1f5f9' },
  ];

  // Starting-cash assumption banner at top of table — single tight line
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(MUTED);
  doc.text('STARTING CASH', MARGIN.left, 37);
  doc.setFont('times', 'normal');
  doc.setFontSize(12);
  doc.setTextColor(INK);
  doc.text(fmtMoneyExact(startingCashM0), MARGIN.left + 30, 37);
  if (entityIds) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7);
    doc.setTextColor(MUTED);
    doc.text('capital attributed to the filtered locations; central / unallocated cash excluded', MARGIN.left + 55, 37);
  }

  const headRow = [
    { content: 'Cashflow', styles: { halign: 'left' } },
    ...headers.map(h => ({ content: h, styles: { halign: 'right' } })),
    { content: '12-mo total', styles: { halign: 'right', fontStyle: 'bold' } },
  ];

  const body = ROWS.map(r => {
    if (r.section) {
      return [{ content: r.label, colSpan: 2 + monthRows.length, styles: {
        halign: 'left', fontStyle: 'bold', fontSize: 6.5, textColor: MUTED, fillColor: '#eef2f7',
      } }];
    }
    const cells = [{ content: r.label, styles: {
      halign: 'left',
      fontStyle: r.bold ? 'bold' : 'normal',
      cellPadding: { top: 1.0, right: 2.5, bottom: 1.0, left: r.indent ? 6 : 2.5 },
    } }];
    for (const v of r.vals) {
      cells.push({ content: fmtMoneyExact(v), styles: {
        halign: 'right',
        fontStyle: r.bold ? 'bold' : 'normal',
        textColor: r.neg ? '#b91c1c' : INK,
      }});
    }
    let totalTxt;
    if (r.isClose) {
      totalTxt = fmtMoneyExact(monthRows[monthRows.length - 1]?.closing);
    } else if (r.label === 'Opening cash') {
      totalTxt = fmtMoneyExact(monthRows[0]?.opening);
    } else {
      const sum = r.vals.reduce((a, x) => a + (x || 0), 0);
      totalTxt = fmtMoneyExact(sum);
    }
    cells.push({ content: totalTxt, styles: {
      halign: 'right', fontStyle: 'bold',
      textColor: r.neg ? '#b91c1c' : INK,
      fillColor: SOFT,
    }});
    return cells;
  });

  autoTable(doc, {
    startY: 42,
    head: [headRow], body, theme: 'plain',
    styles: { font: 'helvetica', fontSize: 6.5, cellPadding: { top: 0.9, right: 2, bottom: 0.9, left: 2 }, lineColor: BORDER, lineWidth: 0 },
    headStyles: { fontStyle: 'bold', fontSize: 6.5, textColor: MUTED, fillColor: SOFT, lineWidth: { bottom: 0.4 }, lineColor: INK },
    columnStyles: { 0: { cellWidth: 38, halign: 'left' } },
    didParseCell: (data) => {
      if (data.section === 'body') {
        data.cell.styles.lineWidth = { bottom: 0.05 };
        data.cell.styles.lineColor = BORDER;
        const rowDef = ROWS[data.row.index];
        if (rowDef && !rowDef.section && rowDef.fill) {
          data.cell.styles.fillColor = rowDef.fill;
        }
      }
    },
    margin: { left: MARGIN.left, right: MARGIN.right },
  });

  // Investment summary callout below the table
  const drawY = doc.lastAutoTable.finalY + 8;
  doc.setDrawColor(INK); doc.setLineWidth(0.4);
  doc.line(MARGIN.left, drawY, PAGE.w - MARGIN.right, drawY);

  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(MUTED);
  doc.text('12-MONTH INVESTMENT REQUIREMENT', MARGIN.left, drawY + 7);

  const peakDeficit = Math.min(...monthRows.map(r => r.closing));
  const trough = monthRows.findIndex(r => r.closing === peakDeficit);
  const headroom = startingCashM0 - peakDeficit;

  const callouts = [
    { label: 'Total fixed asset spend',  value: fmtMoneyExact(-totals.capex) },
    { label: 'Total pre-startup spend',  value: fmtMoneyExact(-totals.preOpen) },
    { label: 'Lowest cash balance',      value: fmtMoneyExact(peakDeficit), hint: trough >= 0 ? `at ${headers[trough]}` : '' },
    { label: 'Funding headroom required',value: peakDeficit < 0 ? fmtMoneyExact(-peakDeficit) : '£0', hint: peakDeficit < 0 ? 'on top of starting cash' : 'starting cash sufficient' },
  ];

  const cw = (PAGE.w - MARGIN.left - MARGIN.right) / callouts.length;
  callouts.forEach((c, i) => {
    const x = MARGIN.left + i * cw;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(MUTED);
    doc.text(c.label.toUpperCase(), x, drawY + 14);
    doc.setFont('times', 'normal'); doc.setFontSize(13); doc.setTextColor(INK);
    doc.text(c.value, x, drawY + 22);
    if (c.hint) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(MUTED);
      doc.text(c.hint, x, drawY + 27);
    }
  });

  // ── Itemised breakdown (lighter text) ──────────────────────────
  // Lists each capex / pre-opening line item that hits within the first
  // 12 months, with its £ total. Two columns side-by-side under the
  // callout strip.
  const itemY = drawY + 34;
  const monthSet = new Set(monthPeriods);
  // Line-item labels only exist on the RAW outputs — the scoped aggregate
  // carries summary lines with no labels. Scope by entityIds here.
  const inScopeRow = (r) => !entityIds || r.entity_id == null || entityIds.has(r.entity_id);

  const sumByLabel = (filterFn) => {
    const m = new Map();
    for (const r of outputs) {
      if (!filterFn(r)) continue;
      if (!monthSet.has(r.period)) continue;
      const lbl = r.line_label || '(unlabelled)';
      m.set(lbl, (m.get(lbl) || 0) + r.amount_p);
    }
    return Array.from(m.entries())
      .filter(([, v]) => v !== 0)
      .sort(([, a], [, b]) => b - a);
  };

  const capexItems = sumByLabel(r =>
    r.nominal_type === 'capex' && inScopeRow(r)
  );
  const preOpenItems = sumByLabel(r =>
    (r.module_key === 'pre_opening' || /^Pre-opening/i.test(r.line_label || '')) &&
    (r.nominal_type === 'overhead' || r.nominal_type === 'staff_cost') &&
    inScopeRow(r)
  );

  const colW = (PAGE.w - MARGIN.left - MARGIN.right) / 2;
  const drawItemList = (xLeft, title, items) => {
    let y = itemY;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(MUTED);
    doc.text(title.toUpperCase(), xLeft, y);
    y += 4;
    doc.setDrawColor(RULE); doc.setLineWidth(0.15);
    doc.line(xLeft, y - 2, xLeft + colW - 6, y - 2);

    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor('#94a3b8');   // lighter
    if (items.length === 0) {
      doc.text('— none in first 12 months —', xLeft, y + 2);
      return;
    }
    for (const [lbl, amt] of items) {
      doc.text(lbl, xLeft, y + 2);
      const amtTxt = fmtMoneyExact(amt);
      doc.text(amtTxt, xLeft + colW - 8, y + 2, { align: 'right' });
      y += 4;
      if (y > PAGE.h - MARGIN.bottom - 14) break;   // don't overflow into footer
    }
  };

  // Cap asset spend at the top 3 by amount — keeps the page tight and
  // surfaces the headline buys; smaller categories roll into "Other".
  const topAssets = capexItems.slice(0, 3);
  const otherAssetsTotal = capexItems.slice(3).reduce((a, [, v]) => a + v, 0);
  if (otherAssetsTotal !== 0) topAssets.push([`Other (${capexItems.length - 3})`, otherAssetsTotal]);

  drawItemList(MARGIN.left,                  'Top 3 asset spend',         topAssets);
  drawItemList(MARGIN.left + colW,           'Pre-opening itemised',      preOpenItems);
}

// ── Capacities page ───────────────────────────────────────────

function drawCapacitiesPage(doc, { entities, entityIds, outputs, scopedOutputs, periods, header, ramp = {} }) {
  drawHeader(doc, header);
  drawSectionHeading(doc, 'Capacities', 'Per-location capacity, space compliance and ramp');

  const inScope = entityIds ? entities.filter(e => entityIds.has(e.id)) : entities;
  const SQM_PER_CHILD = { babies: 3.7, twos: 2.8, three_to_five: 2.3, after_school: 1.86 };
  const SQFT_PER_SQM = 10.7639;
  const BANDS = [
    { key: 'babies', label: '0-2' },
    { key: 'twos',  label: '2-3' },
    { key: 'three_to_five', label: '3-5' },
    { key: 'after_school',  label: 'After-school' },
  ];

  const headRow = [
    { content: 'Location', styles: { halign: 'left' } },
    { content: 'Opens',    styles: { halign: 'right' } },
    ...BANDS.map(b => ({ content: b.label, styles: { halign: 'right' } })),
    { content: 'Total',    styles: { halign: 'right', fontStyle: 'bold' } },
    { content: 'Sq ft',    styles: { halign: 'right' } },
    { content: 'Sq ft / child', styles: { halign: 'right' } },
    { content: 'Required sq ft', styles: { halign: 'right' } },
    { content: 'Compliant', styles: { halign: 'center' } },
  ];

  let aggCap = 0, aggSqft = 0, nonCompliant = 0;
  const body = inScope.map(e => {
    const cfg = e.config || {};
    const cap = cfg.capacity_by_age_band || {};
    const total = BANDS.reduce((a, b) => a + (cap[b.key] || 0), 0);
    const sqft = Number(cfg.sq_ft) || 0;
    let required = 0;
    for (const b of BANDS) required += (cap[b.key] || 0) * SQM_PER_CHILD[b.key] * SQFT_PER_SQM;
    required = Math.round(required);
    const sqftPerChild = total > 0 ? sqft / total : 0;
    const compliant = sqft >= required;
    aggCap += total; aggSqft += sqft;
    if (!compliant) nonCompliant += 1;

    return [
      { content: e.label || '—', styles: { halign: 'left', fontStyle: 'bold' } },
      { content: `M${cfg.opening_month_offset ?? 0}`, styles: { halign: 'right' } },
      ...BANDS.map(b => ({ content: String(cap[b.key] || 0), styles: { halign: 'right' } })),
      { content: String(total), styles: { halign: 'right', fontStyle: 'bold' } },
      { content: sqft.toLocaleString('en-GB'), styles: { halign: 'right' } },
      { content: total > 0 ? sqftPerChild.toFixed(1) : '—', styles: { halign: 'right' } },
      { content: required.toLocaleString('en-GB'), styles: { halign: 'right' } },
      { content: compliant ? '✓' : '✗', styles: { halign: 'center', textColor: compliant ? '#16a34a' : '#b91c1c', fontStyle: 'bold' } },
    ];
  });

  // Totals row
  body.push([
    { content: 'TOTAL', styles: { halign: 'left', fontStyle: 'bold', fillColor: SOFT } },
    { content: '', styles: { fillColor: SOFT } },
    ...BANDS.map(b => ({ content: String(inScope.reduce((a, e) => a + (e.config?.capacity_by_age_band?.[b.key] || 0), 0)), styles: { halign: 'right', fontStyle: 'bold', fillColor: SOFT } })),
    { content: String(aggCap), styles: { halign: 'right', fontStyle: 'bold', fillColor: SOFT } },
    { content: aggSqft.toLocaleString('en-GB'), styles: { halign: 'right', fontStyle: 'bold', fillColor: SOFT } },
    { content: aggCap > 0 ? (aggSqft / aggCap).toFixed(1) : '—', styles: { halign: 'right', fontStyle: 'bold', fillColor: SOFT } },
    { content: '', styles: { fillColor: SOFT } },
    { content: nonCompliant === 0 ? '✓' : `${inScope.length - nonCompliant}/${inScope.length}`, styles: { halign: 'center', fontStyle: 'bold', fillColor: SOFT, textColor: nonCompliant === 0 ? '#16a34a' : '#b91c1c' } },
  ]);

  autoTable(doc, {
    startY: 38,
    head: [headRow], body, theme: 'plain',
    styles: { font: 'helvetica', fontSize: 8, cellPadding: { top: 1.8, right: 2.5, bottom: 1.8, left: 2.5 }, lineColor: BORDER, lineWidth: 0 },
    headStyles: { fontStyle: 'bold', fontSize: 7, textColor: MUTED, fillColor: SOFT, lineWidth: { bottom: 0.4 }, lineColor: INK },
    columnStyles: { 0: { cellWidth: 42, halign: 'left' } },
    didParseCell: (data) => {
      if (data.section === 'body') {
        data.cell.styles.lineWidth = { bottom: 0.05 };
        data.cell.styles.lineColor = BORDER;
      }
    },
    margin: { left: MARGIN.left, right: MARGIN.right },
  });

  // Note on Care Inspectorate benchmarks
  let noteY = doc.lastAutoTable.finalY + 5;
  doc.setFont('helvetica', 'italic'); doc.setFontSize(7); doc.setTextColor(MUTED);
  doc.text(
    'Required sq ft uses Care Inspectorate (Scotland) minimums: 0-2 = 3.7 m²/child · 2-3 = 2.8 m² · 3-5 = 2.3 m² · After-school = 1.86 m².',
    MARGIN.left, noteY
  );

  // ── Year-by-year ramp matrix ─────────────────────────────────
  //
  // Effective children per location at the end of each year, derived from
  // the entity's per-band ramp curve and capacity. Useful to see how the
  // estate is filling up.
  const horizonYears = Math.max(1, Math.ceil(periods.length / 12));
  const yearLabels = Array.from({ length: horizonYears }, (_, i) => `Y${i + 1}`);

  // Engine-emitted occupancy (metric.occupancy_pct rows) — the same
  // numbers the P&L was computed from, including August cohort dips.
  // Fall back to the shared curve (lib/occupancy.js) if outputs predate
  // occupancy persistence (stale recompute).
  const occIdx = buildOccupancyIndex(outputs);
  const occupancyForEntity = (e, band, period) => {
    const fromEngine = occIdx.get(occKey(e.id, band, period));
    if (fromEngine != null) return fromEngine;
    const groupCurve = {
      opening: ramp.opening?.[band] != null ? Number(ramp.opening[band]) : defaultBandOpening(band),
      target:  ramp.target?.[band]  != null ? Number(ramp.target[band])  : defaultBandTarget(band),
      phase:   ramp.phaseMonths?.[band] != null ? Number(ramp.phaseMonths[band]) : 6,
    };
    return occupancyOnCurve(
      curveForBand(e, band, groupCurve),
      e?.config?.opening_month_offset ?? 0,
      period,
    );
  };

  // ── Occupancy ramp chart — per site (≤3) or group total ─────
  // Capacity-weighted occupancy per month, straight from the engine.
  const weightedOcc = (ents, t) => {
    let wsum = 0, w = 0;
    for (const e of ents) {
      const caps = e.config?.capacity_by_age_band || {};
      for (const b of BANDS) {
        const c = caps[b.key] || 0;
        if (!c) continue;
        wsum += c * occupancyForEntity(e, b.key, t);
        w += c;
      }
    }
    return w > 0 ? wsum / w : null;
  };
  const chartSeries = (inScope.length > 0 && inScope.length <= 3)
    ? inScope.map((e, i) => ({
        label: e.label || e.key, color: SERIES[i],
        values: periods.map(t => weightedOcc([e], t) ?? 0),
      }))
    : [{ label: 'Group', color: SERIES[0], values: periods.map(t => weightedOcc(inScope, t) ?? 0) }];
  const chartTop = noteY + 4;
  const chartHeight = 48;
  drawLineChart(doc, {
    x: MARGIN.left, y: chartTop, w: PAGE.w - MARGIN.left - MARGIN.right, h: chartHeight,
    title: 'Occupancy ramp — capacity-weighted, by month',
    series: chartSeries,
    xLabelAt: (i) => (i % 12 === 0 || i === periods.length - 1) ? monthLabel(i, header?.forecast?.opening_period) : null,
    yFormat: (v) => `${Math.round(v)}%`,
  });
  noteY = chartTop + chartHeight;

  const rampHeadRow = [
    { content: 'Location', styles: { halign: 'left' } },
    { content: 'Capacity', styles: { halign: 'right' } },
    ...yearLabels.flatMap(y => [
      { content: `${y} children`, styles: { halign: 'right' } },
      { content: `${y} util.`,    styles: { halign: 'right' } },
    ]),
  ];

  const rampBody = inScope.map(e => {
    const cap = e.config?.capacity_by_age_band || {};
    const totalCap = BANDS.reduce((a, b) => a + (cap[b.key] || 0), 0);

    const cells = [
      { content: e.label || '—', styles: { halign: 'left', fontStyle: 'bold' } },
      { content: String(totalCap), styles: { halign: 'right' } },
    ];

    for (let y = 0; y < horizonYears; y++) {
      const endPeriod = Math.min((y + 1) * 12 - 1, periods.length - 1);
      let children = 0;
      for (const b of BANDS) {
        const occ = occupancyForEntity(e, b.key, endPeriod);
        children += (cap[b.key] || 0) * occ / 100;
      }
      const util = totalCap > 0 ? (children / totalCap) * 100 : 0;
      cells.push({ content: children.toFixed(1), styles: { halign: 'right' } });
      cells.push({ content: util.toFixed(0) + '%', styles: { halign: 'right', textColor: MUTED } });
    }
    return cells;
  });

  // Aggregate row
  const aggCells = [
    { content: 'TOTAL', styles: { halign: 'left', fontStyle: 'bold', fillColor: SOFT } },
    { content: String(inScope.reduce((a, e) => a + BANDS.reduce((s, b) => s + (e.config?.capacity_by_age_band?.[b.key] || 0), 0), 0)),
      styles: { halign: 'right', fontStyle: 'bold', fillColor: SOFT } },
  ];
  for (let y = 0; y < horizonYears; y++) {
    const endPeriod = Math.min((y + 1) * 12 - 1, periods.length - 1);
    let totalChildren = 0, totalCap = 0;
    for (const e of inScope) {
      const cap = e.config?.capacity_by_age_band || {};
      for (const b of BANDS) {
        totalChildren += (cap[b.key] || 0) * occupancyForEntity(e, b.key, endPeriod) / 100;
        totalCap += (cap[b.key] || 0);
      }
    }
    const util = totalCap > 0 ? (totalChildren / totalCap) * 100 : 0;
    aggCells.push({ content: totalChildren.toFixed(1), styles: { halign: 'right', fontStyle: 'bold', fillColor: SOFT } });
    aggCells.push({ content: util.toFixed(0) + '%',    styles: { halign: 'right', fontStyle: 'bold', fillColor: SOFT, textColor: MUTED } });
  }
  rampBody.push(aggCells);

  // Section heading for the ramp matrix
  const rampHeadingY = noteY + 6;
  doc.setDrawColor(RULE);
  doc.setLineWidth(0.2);
  doc.line(MARGIN.left, rampHeadingY, PAGE.w - MARGIN.right, rampHeadingY);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(MUTED);
  doc.text('YEAR-BY-YEAR RAMP', MARGIN.left, rampHeadingY + 5);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(MUTED);
  doc.text('Effective children at year-end (capacity × engine occupancy, incl. August cohort dips) and total utilisation', MARGIN.left, rampHeadingY + 9);

  autoTable(doc, {
    startY: rampHeadingY + 12,
    head: [rampHeadRow], body: rampBody, theme: 'plain',
    styles: { font: 'helvetica', fontSize: 8, cellPadding: { top: 1.6, right: 2.5, bottom: 1.6, left: 2.5 }, lineColor: BORDER, lineWidth: 0 },
    headStyles: { fontStyle: 'bold', fontSize: 7, textColor: MUTED, fillColor: SOFT, lineWidth: { bottom: 0.4 }, lineColor: INK },
    columnStyles: { 0: { cellWidth: 42, halign: 'left' }, 1: { cellWidth: 18, halign: 'right' } },
    didParseCell: (data) => {
      if (data.section === 'body') {
        data.cell.styles.lineWidth = { bottom: 0.05 };
        data.cell.styles.lineColor = BORDER;
      }
    },
    margin: { left: MARGIN.left, right: MARGIN.right },
  });
}

function defaultBandOpening(band) {
  switch (band) {
    case 'babies':        return 30;
    case 'twos':          return 40;
    case 'three_to_five': return 60;
    case 'after_school':  return 30;
    default: return 40;
  }
}
function defaultBandTarget(band) {
  switch (band) {
    case 'babies':        return 85;
    case 'twos':          return 90;
    case 'three_to_five': return 95;
    case 'after_school':  return 70;
    default: return 85;
  }
}

// Helpers for the new pages

// Compact formatter for the Executive dashboard (where space is tight and
// amounts are usually large). Loses precision below £1m; do NOT use for
// month-level cashflow detail — see fmtMoneyExact below.
function fmtMoney(p) {
  if (p == null || !isFinite(p)) return '–';
  if (p === 0) return '£0';
  const sign = p < 0 ? '-' : '';
  const abs = Math.abs(p) / 100;
  if (abs >= 1_000_000) return sign + '£' + (abs / 1_000_000).toFixed(2) + 'm';
  if (abs >= 10_000)    return sign + '£' + (abs / 1_000).toFixed(0) + 'k';
  return sign + '£' + Math.round(abs).toLocaleString('en-GB');
}

// Precise pound-level formatter — used on Road to Market and other pages
// where small month-to-month movements need to be visible. £m only kicks
// in at very large numbers; below that, full pounds with a thousands
// separator so a £6,250 swing doesn't disappear into "£100k".
function fmtMoneyExact(p) {
  if (p == null || !isFinite(p)) return '–';
  if (p === 0) return '£0';
  const sign = p < 0 ? '-' : '';
  const abs = Math.abs(p) / 100;
  if (abs >= 10_000_000) return sign + '£' + (abs / 1_000_000).toFixed(1) + 'm';
  return sign + '£' + Math.round(abs).toLocaleString('en-GB');
}

function monthLabel(period, openingPeriod) {
  if (!openingPeriod) return `M${period}`;
  const d = new Date(openingPeriod);
  if (isNaN(d.getTime())) return `M${period}`;
  const m = new Date(d.getFullYear(), d.getMonth() + period, 1);
  return m.toLocaleString('en-GB', { month: 'short', year: '2-digit' });
}

// ── Public entry ───────────────────────────────────────────────

export function buildPdfPack({
  forecast, scenario, periods, openingPeriod,
  outputs, scopedOutputs,
  entities = [], entityIds = null,
  granularity = 'annual',
  year = 3,
  scopeLabel = 'all',
  selectedPages = ['cover', 'exec_summary', 'exec_dashboard', 'road_to_market', 'pnl', 'bs', 'cf', 'income', 'staff', 'premises', 'capacities'],
  headlineKpis = [],
  incomeContext = null,    // { weeklyRate, laRate, eligiblePct, takeupPct, hoursPerWeek, openingPct, targetPct, phaseMonths, weeksPerYear }
  notes = '',
  preparedFor = '',
  preparedBy = '',
}) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const grouped = groupPeriods(periods, granularity, openingPeriod);
  const headers = grouped.map(g => g.label);
  const headerCtx = { forecast, scenario, scopeLabel, granularity };

  let firstPage = true;
  const startPage = () => { if (!firstPage) doc.addPage(); firstPage = false; };

  // Cover
  if (selectedPages.includes('cover')) {
    const PAGE_TITLES = {
      exec_summary: 'Executive summary', exec_dashboard: 'Executive dashboard',
      road_to_market: 'Road to market', pnl: 'Profit & loss', bs: 'Balance sheet',
      cf: 'Cashflow', income: 'Income analysis', staff: 'Staff detail',
      premises: 'Premises & overheads', capacities: 'Capacities',
    };
    const contents = Object.keys(PAGE_TITLES)
      .filter(k => selectedPages.includes(k) && (k !== 'income' || incomeContext))
      .map(k => PAGE_TITLES[k]);
    startPage();
    drawCover(doc, {
      forecast, scenario, scopeLabel, granularity, year,
      kpis: headlineKpis, notes, preparedFor, preparedBy, contents,
    });
  }

  // Executive summary — story + charts
  if (selectedPages.includes('exec_summary')) {
    startPage();
    drawExecutiveSummary(doc, {
      outputs, scopedOutputs, periods, openingPeriod, entities, entityIds, header: headerCtx,
    });
  }

  // Executive dashboard — partner-level summary
  if (selectedPages.includes('exec_dashboard')) {
    startPage();
    drawExecutiveDashboard(doc, {
      outputs, scopedOutputs, periods, openingPeriod, year, header: headerCtx,
    });
  }

  // Road to Market — 12-month investment cashflow
  if (selectedPages.includes('road_to_market')) {
    startPage();
    drawRoadToMarket(doc, {
      outputs, scopedOutputs, periods, openingPeriod, entityIds, header: headerCtx,
    });
  }

  // Statements
  const statementMap = {
    pnl: { title: 'Profit & loss',  lines: PNL_LINES, subtitle: `Operating performance — ${granularity}` },
    bs:  { title: 'Balance sheet',  lines: BS_LINES,  subtitle: `Period-end balances — ${granularity}` },
    cf:  { title: 'Cashflow',       lines: CF_LINES,  subtitle: `Direct method — ${granularity}` },
  };
  for (const k of ['pnl', 'bs', 'cf']) {
    if (!selectedPages.includes(k)) continue;
    startPage();
    drawStatementPage(doc, {
      ...statementMap[k],
      outputs, scopedOutputs, grouped, headers, header: headerCtx,
    });
  }

  // Income — tagged per-entity revenue rows only exist on the raw
  // outputs; buildIncomeMatrix scopes itself via entityIds.
  if (selectedPages.includes('income') && incomeContext) {
    startPage();
    const incomeRows = buildIncomeMatrix({
      outputs,
      occupancySource: outputs,   // per-entity occupancy rows live on the raw outputs
      year, entities, entityIds, ...incomeContext,
    });
    drawIncomePage(doc, { incomeRows, year, header: headerCtx });
  }

  // Staff
  if (selectedPages.includes('staff')) {
    startPage();
    drawStaffPage(doc, { outputs, grouped, headers, entityIds, header: headerCtx });
  }

  // Premises
  if (selectedPages.includes('premises')) {
    startPage();
    drawPremisesPage(doc, { outputs, grouped, headers, entityIds, header: headerCtx });
  }

  // Capacities
  if (selectedPages.includes('capacities')) {
    startPage();
    drawCapacitiesPage(doc, {
      entities, entityIds, outputs, scopedOutputs, periods, header: headerCtx,
      ramp: {
        opening:     incomeContext?.openingPct,
        target:      incomeContext?.targetPct,
        phaseMonths: incomeContext?.phaseMonths,
      },
    });
  }

  // Footers — paint after all pages exist
  const total = doc.internal.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    if (p === 1 && selectedPages.includes('cover')) continue;   // skip footer on cover
    drawFooter(doc, p, total);
  }

  return doc;
}

export function downloadPdfPack(doc, filename = 'forecast-pack.pdf') {
  doc.save(filename);
}
