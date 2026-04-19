// Minimal CSV parser: handles quoted fields, embedded commas, escaped
// double-quotes, CRLF/LF line endings. Not RFC-4180-perfect for every
// edge case, but sufficient for BrightManager/TaxCalc exports.
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') {
      row.push(field);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = []; field = ''; i++; continue;
    }
    field += c; i++;
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

export async function previewFile(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.csv')) {
    const text = await file.text();
    const rows = parseCsv(text);
    const header = rows[0] || [];
    const dataRows = rows.slice(1);
    return {
      kind: 'csv',
      rowCount: dataRows.length,
      columnCount: header.length,
      header,
      rows: dataRows,
    };
  }
  return {
    kind: name.endsWith('.xlsx') ? 'xlsx' : 'unknown',
    rowCount: null,
    columnCount: null,
    header: [],
    rows: [],
  };
}
