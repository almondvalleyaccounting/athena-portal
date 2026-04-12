/**
 * Export utilities for CSV and PDF downloads.
 */

/**
 * Download data as a CSV file.
 * @param {string} filename - The filename (should end in .csv)
 * @param {string[]} headers - Column header labels
 * @param {string[][]} rows - Array of rows, each row is an array of cell values
 */
export function downloadCSV(filename, headers, rows) {
  const escape = (v) => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/**
 * Download data as a simple PDF table.
 * @param {string} title - Title shown at the top of the PDF
 * @param {string[]} headers - Column header labels
 * @param {string[][]} rows - Array of rows
 */
export async function downloadTablePdf(title, headers, rows) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 10;
  const usable = pageWidth - margin * 2;
  const colWidth = usable / headers.length;
  const rowHeight = 7;
  let y = 15;

  // Title
  doc.setFontSize(14);
  doc.text(title, margin, y);
  y += 10;

  // Header row
  doc.setFontSize(8);
  doc.setFont(undefined, 'bold');
  headers.forEach((h, i) => {
    doc.text(String(h), margin + i * colWidth, y);
  });
  doc.setFont(undefined, 'normal');
  y += 2;
  doc.setDrawColor(180);
  doc.line(margin, y, pageWidth - margin, y);
  y += rowHeight - 2;

  // Data rows
  doc.setFontSize(7);
  rows.forEach((row) => {
    if (y > doc.internal.pageSize.getHeight() - 15) {
      doc.addPage();
      y = 15;
    }
    row.forEach((cell, i) => {
      doc.text(String(cell ?? ''), margin + i * colWidth, y);
    });
    y += rowHeight;
  });

  doc.save(title.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_') + '.pdf');
}
