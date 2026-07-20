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
  const name = find([/client\s*name/, /taxpayer/, /^client$/, /client/, /\bname\b/]);
  const amount = find([/amount\s*due/, /payment\s*on\s*account/, /\bpoa\b/, /amount/, /\bdue\b/, /total/, /£/]);
  const reference = find([/\butr\b/, /reference/, /\bref\b/]);
  return { name, amount, reference };
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

// ── Email previews (mirror reminders-send) ───────────────────────────
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
const P = `style="margin:0 0 14px;"`;
const SIGN_OFF = `<p style="margin:18px 0 0;">Thanks,<br/>Almond Valley Accounting</p>`;

// Preview of the opt-in invitation. Buttons render but point nowhere —
// the real per-recipient token links are minted inside reminders-send.
export function promoEmailPreviewHtml(name) {
  const hi = esc(greetingName(name));
  return `${SHELL_OPEN}
    <p ${P}>Hi ${hi},</p>
    <p ${P}>We're setting up payment reminders for personal tax &mdash; a short email before each deadline (31 July payments on account, 31 January balancing payments) so nothing gets missed.</p>
    <p ${P}>Because those reminders include your personal tax figures, we'd like your OK first &mdash; we understand not everyone wants tax amounts arriving by email.</p>
    <div style="margin:18px 0;">
      <span style="display:inline-block;padding:10px 20px;background:#0e7fe0;color:#ffffff;border-radius:6px;font-size:14px;">Yes &mdash; send me reminders</span>
      <span style="display:inline-block;padding:10px 20px;background:#ffffff;color:#444444;border:1px solid #cccccc;border-radius:6px;font-size:14px;margin-left:10px;">No thanks</span>
    </div>
    <p ${P}>If the buttons don't work, just reply to this email with yes or no and we'll set it for you.</p>
    ${SIGN_OFF}
  </div>`;
}

export function reminderEmailPreviewHtml(name, amount, dueDateIso) {
  const hi = esc(greetingName(name));
  const due = esc(fmtDateLong(dueDateIso));
  return `${SHELL_OPEN}
    <p ${P}>Hi ${hi},</p>
    <p ${P}>A quick reminder that your personal tax payment on account of <strong>&pound;${fmtMoney(amount)}</strong> is due by ${due}.</p>
    <p ${P}>You can pay HMRC at <a href="https://www.gov.uk/pay-self-assessment-tax-bill" style="color:#0e7fe0;">https://www.gov.uk/pay-self-assessment-tax-bill</a> &mdash; use your UTR as the payment reference.</p>
    <p ${P}>If you've already paid, you can ignore this. If anything looks wrong or you'd like to talk it through, just reply.</p>
    ${SIGN_OFF}
  </div>`;
}

export const PROMO_SUBJECT = 'Tax payment reminders — yes or no?';
export function reminderSubject(dueDateIso) {
  // Matches the edge function: long date with the year trimmed.
  return `Reminder: personal tax payment due ${fmtDateLong(dueDateIso).replace(/\s\d{4}$/, '')}`;
}
