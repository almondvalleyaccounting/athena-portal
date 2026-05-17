// Single source of truth for GBP formatting across the app.
//
// fmtGbp(n)            → "£1,234"  (whole pounds; default for headlines and lists)
// fmtGbpDetailed(n)    → "£1,234.56" (two-decimal; for edit views and per-line detail)
// Negatives render with the minus inside the currency: "-£123" not "£-123".

export function fmtGbp(n) {
  const v = Math.round(Number(n) || 0);
  const abs = Math.abs(v).toLocaleString('en-GB');
  return v < 0 ? `-£${abs}` : `£${abs}`;
}

export function fmtGbpDetailed(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-£${abs}` : `£${abs}`;
}
