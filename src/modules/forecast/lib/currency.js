// Forecast currency.
//
// A forecast is denominated in ONE currency (fc_forecast.currency). Amounts
// are stored the same way regardless — integer minor units, the `_p` suffix
// everywhere — only the symbol and locale change.
//
// The active currency is module-level state set by ForecastModule when a
// forecast loads, so the ~20 views that call fmtP() need no changes and the
// childcare pack keeps behaving exactly as before (default GBP).
//
// No view imports here: the engine can use formatMoney() in findings.

export const CURRENCIES = [
  { code: 'GBP', symbol: '£', locale: 'en-GB', label: 'GBP — pounds' },
  { code: 'USD', symbol: '$', locale: 'en-US', label: 'USD — US dollars' },
  { code: 'EUR', symbol: '€', locale: 'en-IE', label: 'EUR — euro' },
];

const BY_CODE = Object.fromEntries(CURRENCIES.map(c => [c.code, c]));
const FALLBACK = BY_CODE.GBP;

let active = 'GBP';

export function setActiveCurrency(code) {
  active = BY_CODE[code] ? code : 'GBP';
}

export function activeCurrency() {
  return active;
}

export function currencyMeta(code) {
  return BY_CODE[code || active] || FALLBACK;
}

export function currencySymbol(code) {
  return currencyMeta(code).symbol;
}

/** Minor units → display string, e.g. 123456 → "£1,235". */
export function formatMoney(minorUnits, code, opts = {}) {
  if (minorUnits == null) return '';
  const { symbol, locale } = currencyMeta(code);
  const major = minorUnits / 100;
  const sign = major < 0 ? '-' : '';
  const abs = Math.abs(major);
  if (opts.compact && abs >= 1_000_000) return `${sign}${symbol}${(abs / 1_000_000).toFixed(2)}m`;
  if (opts.compact && abs >= 1_000) return `${sign}${symbol}${(abs / 1_000).toFixed(0)}k`;
  return sign + symbol + abs.toLocaleString(locale, {
    maximumFractionDigits: opts.dp ?? 0,
    minimumFractionDigits: opts.dp ?? 0,
  });
}
