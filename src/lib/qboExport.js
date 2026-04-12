/**
 * QBO Export Utility
 * Generates QBO-compatible CSV files for import into QuickBooks Online.
 */

/**
 * Generate a QBO-compatible CSV for recurring invoice import.
 * @param {string} clientName - The customer/client name
 * @param {Array} lineItems - Array of { description, qty, rate, amount }
 * @param {boolean} isRecurring - Whether this is for a recurring invoice template
 * @returns {string} CSV content string
 */
export function generateQboImportCsv(clientName, lineItems, isRecurring = true) {
  const headers = ['Customer', 'Product/Service', 'Description', 'Qty', 'Rate', 'Amount'];
  const rows = (lineItems || []).map((item) => {
    const desc = (item.description || '').replace(/"/g, '""');
    const service = (item.service_id || item.description || '').replace(/"/g, '""');
    const qty = item.qty != null ? item.qty : 1;
    const rate = item.rate != null ? item.rate : (item.monthly_amount || item.amount || 0);
    const amount = item.amount != null ? item.amount : (item.monthly_amount || 0);
    return [
      `"${clientName.replace(/"/g, '""')}"`,
      `"${service}"`,
      `"${desc}"`,
      qty,
      Number(rate).toFixed(2),
      Number(amount).toFixed(2),
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Trigger a CSV file download in the browser.
 * @param {string} csvContent - The CSV string
 * @param {string} filename - Desired filename
 */
export function downloadCsv(csvContent, filename) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || 'qbo-import.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Generate and download a QBO import CSV.
 * @param {string} clientName
 * @param {Array} lineItems
 * @param {boolean} isRecurring
 */
export function exportQboCsv(clientName, lineItems, isRecurring = true) {
  const csv = generateQboImportCsv(clientName, lineItems, isRecurring);
  const safeName = (clientName || 'client').replace(/[^a-zA-Z0-9]/g, '_');
  downloadCsv(csv, `qbo_import_${safeName}_${new Date().toISOString().slice(0, 10)}.csv`);
}
