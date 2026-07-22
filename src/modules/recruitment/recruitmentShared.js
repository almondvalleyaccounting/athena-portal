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
