// Shared styles + constants for the Recruitment module (in-house ATS).
// Styling follows the house pattern: inline styles, Outfit font, tone chips.

export const font = "'Outfit', sans-serif";
export const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 };

export function btn(kind) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', fontSize: 12.5, fontWeight: 600,
    fontFamily: font, borderRadius: 8, cursor: 'pointer',
    background: kind === 'primary' ? '#0f172a' : '#fff',
    color: kind === 'primary' ? '#fff' : '#475569',
    border: kind === 'primary' ? 'none' : '1px solid #e5e7eb',
  };
}
export const iconBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 3, padding: '4px 7px', fontFamily: font,
  borderRadius: 7, cursor: 'pointer', background: '#fff', border: '1px solid #e5e7eb', flexShrink: 0,
};
export const backdrop = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
export const modal = { background: '#fff', borderRadius: 12, padding: '20px 22px', fontFamily: font, boxShadow: '0 20px 60px rgba(15,23,42,0.25)' };
export const fieldLabel = { display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 4 };
export const input = {
  width: '100%', padding: '8px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1',
  borderRadius: 8, background: '#fff', color: '#0f172a', boxSizing: 'border-box', outline: 'none',
};

// ── Pipeline stages ──────────────────────────────────────────────────
// The five active columns of the kanban, in order, plus the two exit
// states (kept off the board unless "show archived" is on).
export const STAGES = [
  { key: 'new',       label: 'New',        tone: { fg: '#0369a1', bg: '#f0f9ff', border: '#bae6fd' } },
  { key: 'screening', label: 'Screening',  tone: { fg: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' } },
  { key: 'interview', label: 'Interview',  tone: { fg: '#b45309', bg: '#fffbeb', border: '#fde68a' } },
  { key: 'offer',     label: 'Offer',      tone: { fg: '#0e7490', bg: '#ecfeff', border: '#a5f3fc' } },
  { key: 'hired',     label: 'Hired',      tone: { fg: '#166534', bg: '#f0fdf4', border: '#bbf7d0' } },
];
export const EXIT_STAGES = [
  { key: 'rejected',  label: 'Rejected',   tone: { fg: '#b91c1c', bg: '#fef2f2', border: '#fecaca' } },
  { key: 'withdrawn', label: 'Withdrawn',  tone: { fg: '#64748b', bg: '#f8fafc', border: '#e2e8f0' } },
];
export const ALL_STAGES = [...STAGES, ...EXIT_STAGES];
export const STAGE_MAP = Object.fromEntries(ALL_STAGES.map((s) => [s.key, s]));

export const EMPLOYMENT_TYPES = [
  { key: 'full_time', label: 'Full-time' },
  { key: 'part_time', label: 'Part-time' },
  { key: 'contract', label: 'Contract' },
  { key: 'temporary', label: 'Temporary' },
  { key: 'apprenticeship', label: 'Apprenticeship' },
];
export const WORK_MODES = [
  { key: 'on_site', label: 'On-site' },
  { key: 'hybrid', label: 'Hybrid' },
  { key: 'remote', label: 'Remote' },
];
export const SALARY_PERIODS = [
  { key: 'year', label: 'per year' },
  { key: 'day', label: 'per day' },
  { key: 'hour', label: 'per hour' },
];
export const VACANCY_STATUSES = [
  { key: 'draft', label: 'Draft', tone: { fg: '#64748b', bg: '#f1f5f9', border: '#cbd5e1' } },
  { key: 'open', label: 'Open', tone: { fg: '#166534', bg: '#dcfce7', border: '#86efac' } },
  { key: 'on_hold', label: 'On hold', tone: { fg: '#b45309', bg: '#fef3c7', border: '#fcd34d' } },
  { key: 'filled', label: 'Filled', tone: { fg: '#0e7490', bg: '#ecfeff', border: '#a5f3fc' } },
  { key: 'closed', label: 'Closed', tone: { fg: '#64748b', bg: '#f8fafc', border: '#e2e8f0' } },
];
export const VACANCY_STATUS_MAP = Object.fromEntries(VACANCY_STATUSES.map((s) => [s.key, s]));

export const SOURCES = ['Website', 'Indeed', 'LinkedIn', 'Reed', 'Totaljobs', 'CV-Library', 'Referral', 'Direct', 'Other'];
export const ADVERT_CHANNELS = [
  { key: 'own', label: 'Own careers page' },
  { key: 'reed', label: 'Reed' },
  { key: 'indeed', label: 'Indeed' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'totaljobs', label: 'Totaljobs' },
  { key: 'cv_library', label: 'CV-Library' },
  { key: 'other', label: 'Other' },
];

// ── Formatting helpers ───────────────────────────────────────────────
export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function fmtDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
export function fmtNoteTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
export function daysSince(iso) {
  if (!iso) return 0;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

// ── Draft an advert from a central role profile ──────────────────────
// Requirements are drafted from the profile's weighted skill categories,
// split by target level: 4–5 = essential, 3 = good working knowledge,
// 1–2 = desirable. Fully editable afterwards.
export function draftRequirementsFromProfile(categories) {
  const cats = [...(categories || [])].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  const essential = cats.filter((c) => (c.target_level ?? 0) >= 4).map((c) => c.category);
  const working = cats.filter((c) => (c.target_level ?? 0) === 3).map((c) => c.category);
  const desirable = cats.filter((c) => (c.target_level ?? 0) > 0 && (c.target_level ?? 0) <= 2).map((c) => c.category);
  const lines = [];
  const block = (heading, items) => {
    if (!items.length) return;
    if (lines.length) lines.push('');
    lines.push(heading);
    items.forEach((x) => lines.push(`• ${x}`));
  };
  block('Essential — strong knowledge of:', essential);
  block('Good working knowledge of:', working);
  block('Desirable:', desirable);
  return lines.join('\n');
}

// Draft { description, requirements } from a role profile. Description takes
// the profile narrative; requirements come from the weighted categories.
export function draftFromRoleProfile(rp) {
  if (!rp) return { description: '', requirements: '' };
  const description = (rp.profile_text || rp.description || '').trim();
  return { description, requirements: draftRequirementsFromProfile(rp.categories) };
}

// ── Phase 2–6 constants ──────────────────────────────────────────────
export const INTERVIEW_KINDS = [
  { key: 'phone', label: 'Phone' },
  { key: 'video', label: 'Video call' },
  { key: 'in_person', label: 'In person' },
  { key: 'task', label: 'Task / assessment' },
];
export const INTERVIEW_STATUSES = [
  { key: 'scheduled', label: 'Scheduled', tone: { fg: '#b45309', bg: '#fffbeb', border: '#fde68a' } },
  { key: 'completed', label: 'Completed', tone: { fg: '#166534', bg: '#f0fdf4', border: '#bbf7d0' } },
  { key: 'cancelled', label: 'Cancelled', tone: { fg: '#64748b', bg: '#f8fafc', border: '#e2e8f0' } },
  { key: 'no_show', label: 'No-show', tone: { fg: '#b91c1c', bg: '#fef2f2', border: '#fecaca' } },
];
export const INTERVIEW_STATUS_MAP = Object.fromEntries(INTERVIEW_STATUSES.map((s) => [s.key, s]));

export const OFFER_STATUSES = [
  { key: 'draft', label: 'Draft', tone: { fg: '#64748b', bg: '#f1f5f9', border: '#cbd5e1' } },
  { key: 'sent', label: 'Sent', tone: { fg: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' } },
  { key: 'accepted', label: 'Accepted', tone: { fg: '#166534', bg: '#dcfce7', border: '#86efac' } },
  { key: 'declined', label: 'Declined', tone: { fg: '#b91c1c', bg: '#fef2f2', border: '#fecaca' } },
  { key: 'withdrawn', label: 'Withdrawn', tone: { fg: '#64748b', bg: '#f8fafc', border: '#e2e8f0' } },
];
export const CONTRACT_STATUSES = [
  { key: 'draft', label: 'Draft', tone: { fg: '#64748b', bg: '#f1f5f9', border: '#cbd5e1' } },
  { key: 'sent', label: 'Sent', tone: { fg: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' } },
  { key: 'signed', label: 'Signed', tone: { fg: '#166534', bg: '#dcfce7', border: '#86efac' } },
  { key: 'declined', label: 'Declined', tone: { fg: '#b91c1c', bg: '#fef2f2', border: '#fecaca' } },
];

// Default new-starter induction checklist (seeded on "Start induction").
export const DEFAULT_INDUCTION = [
  'Send welcome email with start date & first-day details',
  'Issue employment contract & collect signed copy',
  'Collect ID, right-to-work & bank details',
  'Add to payroll',
  'Create email account & system logins (manual — separate admin action)',
  'Order equipment / set up desk',
  'Assign a buddy / first-week schedule',
  'Book induction & mandatory training (CPD tracker)',
  'Add to relevant calendars & team channels',
  'Probation review date set',
];

// Editable email presets. {{name}} / {{role}} substituted at compose time.
export const EMAIL_TEMPLATES = [
  {
    key: 'ack', label: 'Application received',
    subject: 'Your application to Almond Valley Accounting',
    body: 'Hi {{name}},\n\nThank you for applying for the {{role}} role. We’ve received your application and are reviewing it now — we’ll be in touch soon with next steps.\n\nKind regards,\nAlmond Valley Accounting',
  },
  {
    key: 'invite', label: 'Invite to interview',
    subject: 'Interview invitation — {{role}}',
    body: 'Hi {{name}},\n\nWe’d like to invite you to an interview for the {{role}} role. Could you let us know your availability over the coming week?\n\nWe look forward to speaking with you.\n\nKind regards,\nAlmond Valley Accounting',
  },
  {
    key: 'reject', label: 'Unsuccessful (post-interview)',
    subject: 'Update on your application — {{role}}',
    body: 'Hi {{name}},\n\nThank you for taking the time to apply for the {{role}} role and for speaking with us. On this occasion we won’t be taking your application further. We wish you the very best in your search.\n\nKind regards,\nAlmond Valley Accounting',
  },
  {
    key: 'offer', label: 'Offer',
    subject: 'Job offer — {{role}} at Almond Valley Accounting',
    body: 'Hi {{name}},\n\nWe’re delighted to offer you the {{role}} role. A formal offer letter and contract will follow. Please let us know if you have any questions in the meantime — we’d love to have you on the team.\n\nKind regards,\nAlmond Valley Accounting',
  },
];

// Build a downloadable .ics for an interview (client-side, no backend — keeps
// calendar handoff a plain file, no doorway into Athena).
export function interviewIcs({ title, start, durationMins = 45, location, description }) {
  const dt = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}00Z`;
  };
  const startD = new Date(start);
  const endD = new Date(startD.getTime() + durationMins * 60000);
  const esc = (s) => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const uid = `${startD.getTime()}-${Math.floor(startD.getTime() / 1000) % 100000}@athena.recruitment`;
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Athena//Recruitment//EN', 'BEGIN:VEVENT',
    `UID:${uid}`, `DTSTART:${dt(startD)}`, `DTEND:${dt(endD)}`,
    `SUMMARY:${esc(title)}`,
    location ? `LOCATION:${esc(location)}` : '',
    description ? `DESCRIPTION:${esc(description)}` : '',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

export function downloadIcs(filename, ics) {
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename || 'interview.ics'; a.click();
  URL.revokeObjectURL(url);
}

// "£28,000 – £34,000 per year" from a vacancy row.
export function fmtSalary(v) {
  if (v == null) return '';
  const { salary_min, salary_max, salary_period } = v;
  if (salary_min == null && salary_max == null) return '';
  const money = (n) => '£' + Number(n).toLocaleString('en-GB');
  const period = (SALARY_PERIODS.find((p) => p.key === salary_period) || {}).label || '';
  let range;
  if (salary_min != null && salary_max != null && Number(salary_min) !== Number(salary_max)) {
    range = `${money(salary_min)} – ${money(salary_max)}`;
  } else {
    range = money(salary_min ?? salary_max);
  }
  return `${range} ${period}`.trim();
}
