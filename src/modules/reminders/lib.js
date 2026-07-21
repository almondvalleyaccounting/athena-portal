// Client Reminders — shared helpers: CSV parsing (TaxCalc exports),
// name normalisation/matching, and email previews that mirror what the
// reminders-send edge function actually sends (the function owns the
// real copy; keep the two in step when either changes).

// ── CSV ───────────────────────────────────────────────────────────────
// Small robust parser: quoted fields, escaped quotes (""), CRLF / LF /
// lone CR line endings, commas inside quotes. Returns array of rows
// (arrays of strings), blank lines dropped.
export function parseCsv(text) {
  const src = String(text ?? '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
    } else if (c === '\r') {
      row.push(field); field = ''; rows.push(row); row = [];
      if (src[i + 1] === '\n') i++;
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

// Best-guess column indexes from header names. Returns -1 when nothing
// plausible — the user picks manually in the mapping dropdowns.
export function guessColumns(headers) {
  const h = headers.map((x) => String(x ?? '').toLowerCase());
  const find = (patterns) => {
    for (const p of patterns) {
      const idx = h.findIndex((name) => p.test(name));
      if (idx !== -1) return idx;
    }
    return -1;
  };
  const forename = find([/fore\s*name/, /first\s*name/, /^first$/, /given/]);
  const surname = find([/sur\s*name/, /last\s*name/, /^last$/, /family/]);
  const name = find([/client\s*name/, /taxpayer/, /^client$/, /client/, /\bname\b/]);
  const amount = find([/payment[s]?\s*on\s*account/, /amount\s*due/, /\bpoa\b/, /amount/, /\bdue\b/, /total/, /£/]);
  const reference = find([/unique\s*tax\s*reference/, /\butr\b/, /reference/, /\bref\b/]);
  return { name, forename, surname, amount, reference };
}

// '£1,234.50 ' → 1234.5; returns null when unparseable.
export function parseAmount(raw) {
  const s = String(raw ?? '').replace(/[£,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ── Name matching ────────────────────────────────────────────────────
// Lowercase, strip punctuation, collapse whitespace.
export function normaliseName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Exact normalised match first; then a "contains" pass that only
// commits when exactly one candidate survives (an ambiguous contains
// match is worse than no match). Returns entity id or null.
export function matchEntityByName(rawName, entities) {
  const target = normaliseName(rawName);
  if (!target) return null;
  const exact = entities.filter((e) => normaliseName(e.name) === target);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return null;
  const contains = entities.filter((e) => {
    const n = normaliseName(e.name);
    return n && (n.includes(target) || target.includes(n));
  });
  return contains.length === 1 ? contains[0].id : null;
}

// Safe match for tax-payment emails (data protection): the UTR must match
// EXACTLY one active client, and that client's name must contain the
// surname as a cross-check. Anything else returns no match with a reason
// so the row is skipped, never mis-delivered. entities need { id, name, utr }.
// Returns { id: string|null, reason: 'ok'|'no-utr'|'utr-not-found'|'utr-ambiguous'|'surname-mismatch' }.
const utrDigits = (v) => String(v ?? '').replace(/\D/g, '').slice(0, 10);

// The bare 10-digit UTR (ignore-list key), or '' if fewer than 10 digits.
export function utr10(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(0, 10) : '';
}

export function matchEntityByUtrSurname(utrRaw, surnameRaw, entities) {
  const u = utrDigits(utrRaw);
  if (u.length < 10) return { id: null, reason: 'no-utr' };
  const cands = entities.filter((e) => utrDigits(e.utr) === u);
  if (cands.length === 0) return { id: null, reason: 'utr-not-found' };
  if (cands.length > 1) return { id: null, reason: 'utr-ambiguous' };
  const ent = cands[0];
  const sur = normaliseName(surnameRaw);
  if (sur && !normaliseName(ent.name).includes(sur)) return { id: null, reason: 'surname-mismatch' };
  return { id: ent.id, reason: 'ok' };
}

// ── Formatting ───────────────────────────────────────────────────────
export function fmtMoney(amount) {
  if (amount == null || !Number.isFinite(Number(amount))) return '—';
  return Number(amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// '2026-07-31' → '31 July 2026'
export function fmtDateLong(iso) {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (isNaN(d)) return String(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function fmtDateTimeShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// ── Email templates (render + preview) ───────────────────────────────
// The reminders-send edge function is the single source of the copy; it
// renders the comm_templates row for (comm_type, kind). These helpers
// mirror that rendering so the on-screen preview matches what is sent.
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function greetingName(name) {
  const n = String(name ?? '').trim();
  if (!n) return 'there';
  if (/\b(ltd|limited|llp|plc|lp|partnership|associates|company|co\.)\b/i.test(n)) return n;
  return n.split(/\s+/)[0];
}

const SHELL_OPEN = `<div style="max-width:640px;padding:14px 6px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;background:#ffffff;">`;

export const PAY_URL = 'https://www.gov.uk/pay-self-assessment-tax-bill'; // how to pay
export const PTA_URL = 'https://www.gov.uk/personal-tax-account';          // view balance/payments

// UTR → Self Assessment payment reference: the 10-digit UTR followed by
// 'K'. Mirrors reminders-send; '' when no 10-digit UTR is present.
export function taxPaymentRef(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? `${digits.slice(0, 10)}K` : '';
}

// {{token}} substitution. Values destined for HTML are pre-escaped by the
// caller (buildEmailPreview); text/subject render raw.
export function renderTemplate(s, vars) {
  return String(s ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (k in vars ? String(vars[k] ?? '') : ''));
}

// Render a comm_templates row for on-screen preview. body_html is the
// inner HTML (wrapped in the plain email shell, matching the sender).
export function buildEmailPreview(template, vars) {
  if (!template) {
    return { subject: '(no template configured)', html: `${SHELL_OPEN}<p style="color:#b91c1c;">No template found.</p></div>` };
  }
  const htmlVars = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, esc(v)]));
  return {
    subject: renderTemplate(template.subject || '', vars),
    html: `${SHELL_OPEN}${renderTemplate(template.body_html || '', htmlVars)}</div>`,
  };
}

// Placeholder values for the template editor's live preview.
export function sampleTemplateVars() {
  return {
    first_name: 'Alex',
    amount: '2,450.00',
    due_date: '31 July 2026',
    payment_ref: '1234567890K',
    opt_in_url: '#opt-in',
    opt_out_url: '#opt-out',
    pay_url: PAY_URL,
    pta_url: PTA_URL,
  };
}
