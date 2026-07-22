// Excel export — produces a multi-sheet workbook with the forecast pack.

import * as XLSX from 'xlsx';
import { PNL_LINES, BS_LINES, CF_LINES } from '../../views/statementLines';
import {
  groupPeriods, sumLine, buildStatementMatrix,
  buildStaffMatrix, STAFF_ROWS,
  buildPremisesMatrix,
  pToGbp,
} from './aggregations';

const SHEETS = {
  pnl:      { label: 'P&L',              lines: PNL_LINES },
  bs:       { label: 'Balance sheet',    lines: BS_LINES },
  cf:       { label: 'Cashflow',         lines: CF_LINES },
  staff:    { label: 'Staff detail',     custom: true },
  premises: { label: 'Premises detail',  custom: true },
};

export function buildExcelPack({
  forecast, scenario, periods, openingPeriod,
  outputs, scopedOutputs,                       // optional: pre-scoped rows
  entities = [], entityIds = null,
  granularity = 'annual',
  selectedSheets = ['pnl', 'bs', 'cf', 'staff', 'premises'],
}) {
  const wb = XLSX.utils.book_new();
  const grouped = groupPeriods(periods, granularity, openingPeriod);
  const periodHeaders = grouped.map(g => g.label);

  // ── Cover sheet ────────────────────────────────────────────────
  {
    const meta = [
      ['Forecast pack',           ''],
      ['Forecast',                forecast?.name || ''],
      ['Client',                  forecast?.client_name || ''],
      ['Scenario',                scenario?.name || ''],
      ['Vertical pack',           forecast?.vertical_pack || ''],
      ['Horizon (months)',        forecast?.horizon_months || ''],
      ['Opening period',          openingPeriod || ''],
      ['Granularity',             granularity],
      ['Generated',               new Date().toISOString().slice(0, 16).replace('T', ' ')],
    ];
    const ws = XLSX.utils.aoa_to_sheet(meta);
    ws['!cols'] = [{ wch: 22 }, { wch: 40 }];
    // Bold the title row
    if (ws['A1']) ws['A1'].s = { font: { bold: true, sz: 14 } };
    XLSX.utils.book_append_sheet(wb, ws, 'Cover');
  }

  // ── Statement sheets (P&L / BS / CF) ───────────────────────────
  for (const key of ['pnl', 'bs', 'cf']) {
    if (!selectedSheets.includes(key)) continue;
    const def = SHEETS[key];
    const matrix = buildStatementMatrix(outputs, def.lines, grouped, scopedOutputs);

    const aoa = [];
    aoa.push([def.label, ...periodHeaders]);
    for (const { line, values } of matrix) {
      const indent = line.indent ? '   ' : '';
      const row = [indent + line.label, ...values.map(pToGbp)];
      aoa.push(row);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 38 }, ...grouped.map(() => ({ wch: 14 }))];
    ws['!freeze'] = { xSplit: 1, ySplit: 1 };
    // Currency format for numeric columns
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = 1; R <= range.e.r; R++) {
      for (let C = 1; C <= range.e.c; C++) {
        const addr = XLSX.utils.encode_cell({ r: R, c: C });
        if (ws[addr]) ws[addr].z = '#,##0;[Red](#,##0);"–"';
      }
    }
    XLSX.utils.book_append_sheet(wb, ws, def.label.slice(0, 31));
  }

  // ── Staff detail ───────────────────────────────────────────────
  // Raw outputs only — the scoped aggregate carries no tagged per-entity
  // staff_cost rows; the location filter is applied via entityIds.
  if (selectedSheets.includes('staff')) {
    const staff = buildStaffMatrix(outputs, grouped, entityIds);
    const aoa = [];
    aoa.push(['Staff detail', ...periodHeaders.flatMap(h => [h + ' — HC', h + ' — Cost £'])]);
    for (const row of STAFF_ROWS) {
      const cells = [row.label];
      for (let i = 0; i < grouped.length; i++) {
        cells.push(staff[row.role][i].hc);
        cells.push(pToGbp(staff[row.role][i].cost));
      }
      aoa.push(cells);
    }
    // Totals row
    const totals = ['TOTAL'];
    for (let i = 0; i < grouped.length; i++) {
      let hc = 0, cost = 0;
      for (const row of STAFF_ROWS) { hc += staff[row.role][i].hc; cost += staff[row.role][i].cost; }
      totals.push(hc); totals.push(pToGbp(cost));
    }
    aoa.push(totals);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 28 }, ...grouped.flatMap(() => [{ wch: 8 }, { wch: 14 }])];
    ws['!freeze'] = { xSplit: 1, ySplit: 1 };
    XLSX.utils.book_append_sheet(wb, ws, 'Staff detail');
  }

  // ── Premises detail ────────────────────────────────────────────
  // Raw outputs only — same reason as the staff sheet above.
  if (selectedSheets.includes('premises')) {
    const rows = buildPremisesMatrix(outputs, grouped, entityIds);
    const aoa = [];
    aoa.push(['Premises & overheads detail', ...periodHeaders]);
    for (const r of rows) {
      aoa.push([`${r.label} (${r.kind})`, ...r.values.map(pToGbp)]);
    }
    // Total
    const total = ['TOTAL', ...grouped.map((_, gi) => {
      let s = 0; for (const r of rows) s += r.values[gi]; return pToGbp(s);
    })];
    aoa.push(total);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 38 }, ...grouped.map(() => ({ wch: 14 }))];
    ws['!freeze'] = { xSplit: 1, ySplit: 1 };
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = 1; R <= range.e.r; R++) {
      for (let C = 1; C <= range.e.c; C++) {
        const addr = XLSX.utils.encode_cell({ r: R, c: C });
        if (ws[addr]) ws[addr].z = '#,##0;[Red](#,##0);"–"';
      }
    }
    XLSX.utils.book_append_sheet(wb, ws, 'Premises detail');
  }

  return wb;
}

export function downloadExcelPack(wb, filename = 'forecast-pack.xlsx') {
  XLSX.writeFile(wb, filename);
}
