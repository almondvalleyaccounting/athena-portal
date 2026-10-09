// Bill line maths — pure functions, no React. Shared by the bill line editor
// (billLines.jsx: the Billing page and "+ Create") and pinned by
// tests/money/billLines.test.js. Moved verbatim out of BillingPage.jsx.

export const VAT_RATE = 0.20;

// A fresh, empty editor line.
// descAuto: the description was pulled through from the QuickBooks product and
// hasn't been touched since, so changing the service may replace it. Stored and
// copied-in lines leave it unset — that text is somebody's own wording.
export function blankLine() { return { service: '', description: '', hours: '', qty: '', rate: '', net: '', vat: '', gross: '', vatManual: false, descAuto: false, touch: [] }; }

// Qty/rate for the editor, falling back to "1 × the amount" for lines
// stored before the split existed (or where it no longer multiplies out).
export function splitOf(qty, rate, net) {
  const n = Number(net) || 0;
  const q = Number(qty), r = Number(rate);
  const ok = Number.isFinite(q) && q > 0 && Number.isFinite(r) && Math.abs(q * r - n) < 0.005;
  return ok ? { qty: fmtNum(q, 4), rate: fmtNum(r, 4) } : { qty: n ? '1' : '', rate: n ? fmtNum(n, 4) : '' };
}

// Trim a number to at most `dp` decimals without leaving trailing zeros —
// 10 stays "10", 33.333333 becomes "33.3333".
export function fmtNum(n, dp) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  const s = v.toFixed(dp);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

// Qty × Rate = Amount. The two boxes you filled in most recently are held
// and the third is worked out, so: type an amount on a fresh line and you
// get 1 × that amount; then type a rate and the quantity falls out of it;
// type a quantity and a rate instead and the amount is calculated.
const CALC_FIELDS = ['qty', 'rate', 'net'];
export function applyCalc(line, field, value) {
  const touch = [field, ...(line.touch || []).filter((f) => f !== field)].slice(0, 3);
  const next = { ...line, [field]: value, touch };
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

  // Which box gives way? Normally the one left untouched longest; on a line
  // that's only had a single figure entered, assume a quantity of one.
  let target = touch.length >= 2 ? CALC_FIELDS.find((f) => f !== touch[0] && f !== touch[1]) : null;
  if (!target) {
    if (field === 'qty') target = num(next.rate) != null ? 'net' : (num(next.net) != null ? 'rate' : null);
    else if (field === 'rate') target = num(next.net) != null ? 'qty' : 'net';
    else target = 'rate';
    if (field !== 'qty' && num(next.qty) == null) next.qty = value === '' ? '' : '1';
  }

  // A rate typed against a blank quantity means one of them — the same
  // "assume a quantity of one" rule the fallback above uses, applied to the
  // touch-driven branch too. Without it a line whose stored amount was £0.00
  // sits there ignoring every rate you type: splitOf only recovers a quantity
  // from a non-zero amount, so the £0.00 placeholders come back with the
  // quantity empty and nothing for the rate to multiply.
  if (target === 'net' && num(next.qty) == null && num(next.rate) != null) next.qty = '1';

  const qty = num(next.qty), rate = num(next.rate), net = num(next.net);
  if (value === '' && field !== 'qty') {
    // Clearing the amount or the rate clears what was derived from it,
    // rather than leaving a stale figure behind.
    if (target === 'net') next.net = '';
    if (target === 'rate') next.rate = '';
  } else if (target === 'net' && qty != null && rate != null) next.net = fmtNum(Math.round(qty * rate * 100) / 100, 2);
  else if (target === 'rate' && net != null && qty) next.rate = fmtNum(net / qty, 4);
  else if (target === 'qty' && net != null && rate) next.qty = fmtNum(net / rate, 4);
  return withVat(next);
}

// Keep VAT + gross in step with the line's amount. A hand-typed VAT figure
// is left alone; otherwise it's the standard rate.
function withVat(line) {
  const net = parseFloat(line.net);
  if (line.net === '' || !Number.isFinite(net)) return { ...line, vat: line.vatManual ? line.vat : '', gross: '' };
  const vat = line.vatManual ? (parseFloat(line.vat) || 0) : Math.round(net * VAT_RATE * 100) / 100;
  return { ...line, vat: line.vatManual ? line.vat : vat.toFixed(2), gross: (net + vat).toFixed(2) };
}

// Anything that isn't a plain decimal is treated as a sum to work out.
export function isExpression(raw) {
  const s = String(raw).trim();
  return s !== '' && !/^-?\d*\.?\d*$/.test(s);
}

// Work out "100*10", "(120+30)*4", "=250/3". Hand-rolled rather than eval'd
// so a typo in a billing box can never run anything. Returns null if it
// isn't a sum this understands.
export function evalArithmetic(input) {
  const s = String(input).trim().replace(/^=/, '').replace(/[£,\s]/g, '');
  if (!s || !/^[0-9+\-*/().]+$/.test(s)) return null;
  let i = 0;
  const peek = () => s[i];
  const factor = () => {
    if (peek() === '+') { i++; return factor(); }
    if (peek() === '-') { i++; const v = factor(); return v === null ? null : -v; }
    if (peek() === '(') {
      i++; const v = expr();
      if (peek() !== ')') return null;
      i++; return v;
    }
    const start = i;
    while (i < s.length && /[0-9.]/.test(s[i])) i++;
    if (i === start) return null;
    const n = parseFloat(s.slice(start, i));
    return Number.isFinite(n) ? n : null;
  };
  const term = () => {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = s[i++]; const r = factor();
      if (v === null || r === null || (op === '/' && r === 0)) return null;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++]; const r = term();
      if (v === null || r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  const out = expr();
  return (i === s.length && out !== null && Number.isFinite(out)) ? out : null;
}

// Turn the editor rows into the stored line array + invoice totals + a
// short `service` summary for the list view.
export function buildLinesPayload(formLines) {
  const lines = formLines
    .filter((l) => l.service && l.net !== '')
    .map((l) => {
      const net = parseFloat(l.net) || 0;
      const vat = l.vat !== '' ? (parseFloat(l.vat) || 0) : Math.round(net * VAT_RATE * 100) / 100;
      const gross = Math.round((net + vat) * 100) / 100;
      // Only keep the qty/rate split if it actually multiplies out to the
      // amount — a stale pair would put a line on the QBO invoice that
      // doesn't agree with what was approved here.
      const q = parseFloat(l.qty), r = parseFloat(l.rate);
      const split = Number.isFinite(q) && q > 0 && Number.isFinite(r) && Math.abs(q * r - net) < 0.005;
      const h = parseFloat(l.hours);
      return {
        service: l.service, description: l.description.trim() || null,
        hours: Number.isFinite(h) && h >= 0 ? h : null,
        qty: split ? q : 1, rate: split ? r : net,
        net, vat, gross,
      };
    });
  const totals = lines.reduce((t, l) => ({ net: t.net + l.net, vat: t.vat + l.vat, gross: t.gross + l.gross }), { net: 0, vat: 0, gross: 0 });
  const summary = lines.length === 1 ? lines[0].service : `${lines[0].service} +${lines.length - 1} more`;
  return { lines, totals, summary };
}

// A past QBO invoice's lines as editor lines (review before save).
export function invoiceToLines(inv) {
  const ls = (inv.lines || []).map((l) => {
    const net = Number(l.amount) || 0;
    const vat = Math.round(net * VAT_RATE * 100) / 100;
    // QBO carries the split, so bring the qty/rate across rather than
    // flattening a "12 × £50" line into a bare £600.
    const qty = Number(l.qty) > 0 ? Number(l.qty) : 1;
    const rate = Number(l.unit_price) || (qty ? net / qty : net);
    return {
      service: l.service || '', description: l.description || '', hours: '',
      qty: net ? fmtNum(qty, 4) : '', rate: net ? fmtNum(rate, 4) : '',
      net: net ? String(net) : '', vat: net ? vat.toFixed(2) : '', gross: net ? (net + vat).toFixed(2) : '',
      vatManual: false, touch: ['qty', 'rate'],
    };
  });
  return ls.length ? ls : [blankLine()];
}

