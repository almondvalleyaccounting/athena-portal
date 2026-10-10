// Fields for the email template library (sql/373).
//
// A template names its fields as {{key}}. Each key here says how it is
// filled: `auto` reads it from the client, the contact, the sender or a
// constant; `def` pre-fills a value the sender can still change; anything
// else is typed in the modal. A key not listed is a plain fill-in labelled
// from its name, so a template added in the modal can use any field.

export const PORTAL_URL = 'https://clients.almondvalleyaccounting.co.uk';

const longDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
const addWorkingDays = (n) => {
  const d = new Date();
  while (n > 0) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) n--; }
  return d;
};
const firstWord = (s) => String(s || '').trim().split(/\s+/)[0] || '';

// kind: text (one line) · long (a sentence or two) · list (one item per line → bullets)
export const FIELDS = {
  first_name:        { label: 'First name', auto: (c) => c.contact?.firstName || '' },
  greeting:          { label: 'First name', auto: (c) => c.contact?.firstName || '' },
  person:            { label: 'Person’s name', auto: (c) => c.contact?.fullName || '' },
  client_name:       { label: 'Client name', auto: (c) => c.entity?.name || '' },
  entity:            { label: 'Client name', auto: (c) => c.entity?.name || '' },
  utr:               { label: 'UTR', auto: (c) => c.entity?.utr || '' },
  vat_number:        { label: 'VAT number', auto: (c) => c.entity?.vat_number || '' },
  company_number:    { label: 'Company number', auto: (c) => c.entity?.company_number || '' },
  paye_ref:          { label: 'PAYE reference', auto: (c) => c.entity?.paye_ref || '' },
  accounts_office_ref: { label: 'Accounts Office reference', auto: (c) => c.entity?.accounts_office_ref || '' },
  sa_payment_ref:    { label: 'SA payment reference', auto: (c) => (c.entity?.utr ? `${String(c.entity.utr).replace(/\s/g, '')}K` : '') },
  portal_url:        { label: 'Portal link', auto: () => PORTAL_URL },
  pta_url:           { label: 'Personal tax account link', auto: () => 'https://www.gov.uk/personal-tax-account' },
  pay_url:           { label: 'HMRC payment page', auto: () => 'https://www.gov.uk/pay-self-assessment-tax-bill' },
  ch_verify_url:     { label: 'Companies House ID link', auto: () => 'https://www.gov.uk/guidance/verify-your-identity-for-companies-house' },
  starter_checklist_url: { label: 'Starter checklist link', auto: () => 'https://www.gov.uk/government/publications/paye-starter-checklist' },
  sender_name:       { label: 'Your name', auto: (c) => c.profile?.name || '' },
  sender_first_name: { label: 'Your first name', auto: (c) => firstWord(c.profile?.name) },
  from_email:        { label: 'Sending address', auto: (c) => c.mailbox || '' },
  // Workflows templates carry the sender's opener and sign-off. Sent from the
  // library, the opener is left out and the signature follows "Kind regards,".
  opener:            { label: 'Opening line', auto: () => '', optional: true },
  signoff:           { label: 'Sign-off', auto: () => 'Kind regards,' },

  ct_payment_ref:    { label: 'CT payment reference', def: (c) => (c.entity?.utr ? String(c.entity.utr).replace(/\s/g, '') : ''), hint: '17 characters from the CT payslip: UTR, then A001 and the period code.' },
  paye_payment_ref:  { label: 'PAYE payment reference', def: (c) => c.entity?.accounts_office_ref || '', hint: 'Accounts Office reference, then the tax year and month, e.g. …2607.' },
  due_by:            { label: 'Due by', def: () => longDate(addDays(14)) },
  reply_by:          { label: 'We’ll reply by', def: () => longDate(addWorkingDays(3)) },
  call_by:           { label: 'Call before', def: () => longDate(addWorkingDays(5)) },
  confirm_by:        { label: 'Confirm by', def: () => longDate(addDays(14)) },
  statement_date:    { label: 'Statement date', def: () => longDate(new Date()) },
  chase_count:       { label: 'Times chased' },
  amount:            { label: 'Amount (£)' },
  due_date:          { label: 'Due date' },
  items:             { label: 'What we need', kind: 'list' },
  questions:         { label: 'Questions', kind: 'list' },
  key_points:        { label: 'Main points', kind: 'list' },
  outcome:           { label: 'What we did', kind: 'long' },
  highlight:         { label: 'Highlight (optional)', kind: 'long', optional: true },
  tax_line:          { label: 'Tax line (optional)', kind: 'long', optional: true },
  call_reason:       { label: 'Why a call', kind: 'long' },
  topic:             { label: 'Topic, e.g. your HMRC letter of 3 October' },
};

export const fieldMeta = (key) => FIELDS[key] || { label: key.replace(/_/g, ' ').replace(/^./, (m) => m.toUpperCase()) };

export const placeholdersIn = (...strs) => {
  const out = [];
  for (const s of strs) {
    for (const m of String(s || '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)) if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
};

export const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A Workflows / Onboarding template is plain text (body_html empty). Show it as
// HTML: blank lines are paragraphs, a field alone on its line stays bare so a
// list can replace it.
export function textToHtml(text) {
  return String(text || '').split(/\n{2,}/).map((para) => {
    const t = para.trim();
    if (/^\{\{\s*\w+\s*\}\}$/.test(t)) return t;
    return `<p>${escapeHtml(t).replace(/\n/g, '<br>')}</p>`;
  }).join('');
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<li[^>]*>/gi, '\n- ').replace(/<\/(p|div|ul|ol|h\d)>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const listHtml = (v) => {
  const items = String(v || '').split('\n').map((s) => s.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
  return items.length ? `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : '';
};

// The email as it will be sent. A field with no value shows as an amber
// marker, which the modal refuses to send.
export function renderHtml(html, values) {
  return String(html || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => {
    const meta = fieldMeta(k);
    const v = values[k];
    if ((v == null || v === '') && !meta.optional) {
      return `<span data-missing="${k}" style="background:#fef3c7;color:#92400e;padding:0 3px;border-radius:3px;">[${escapeHtml(meta.label)}]</span>`;
    }
    if (meta.kind === 'list') return listHtml(v);
    return escapeHtml(v ?? '').replace(/\n/g, '<br>');
  }).replace(/<p>\s*<\/p>/g, '');
}

export const renderText = (s, values) =>
  String(s || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (values[k] ?? '') || `[${fieldMeta(k).label}]`);

// Editing: {{key}} ↔ a chip that can't be half-deleted.
export const chipHtml = (k) =>
  `<span data-field="${k}" contenteditable="false" style="background:#e2e8f0;color:#334155;border-radius:4px;padding:0 4px;font-size:12.5px;font-family:monospace;">{{${k}}}</span>`;
export const toChips = (html) => String(html || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => chipHtml(k));
export function fromChips(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('span[data-field]').forEach((s) => s.replaceWith(document.createTextNode(`{{${s.getAttribute('data-field')}}}`)));
  // A field that ended up inside a paragraph on its own is a block (a list).
  return div.innerHTML.replace(/<p>\s*(\{\{\s*(items|questions|key_points)\s*\}\})\s*<\/p>/g, '$1');
}
