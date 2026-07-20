import { Mail, Phone, Users, ClipboardList } from 'lucide-react';

// Shared styles + action-plan helpers for the Triage module.

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
export const smallInput = { ...input, width: 'auto', padding: '5px 7px', fontSize: 12, borderRadius: 7 };

// ---- Action plan ----------------------------------------------------------

export const ACTION_TYPES = [
  { key: 'email', label: 'Email', icon: Mail },
  { key: 'call', label: 'Call', icon: Phone },
  { key: 'meeting', label: 'Meeting', icon: Users },
  { key: 'other', label: 'Other', icon: ClipboardList },
];
export const ACTION_TYPE_MAP = Object.fromEntries(ACTION_TYPES.map((t) => [t.key, t]));

export const ACTION_STATUS = {
  not_started: { label: 'Not started', fg: '#64748b', bg: '#f1f5f9', border: '#e2e8f0' },
  in_progress: { label: 'In progress', fg: '#b45309', bg: '#fffbeb', border: '#fde68a' },
  done: { label: 'Done', fg: '#166534', bg: '#f0fdf4', border: '#bbf7d0' },
  cancelled: { label: 'Cancelled', fg: '#94a3b8', bg: '#f8fafc', border: '#e5e7eb' },
};

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

export function localDateStr(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
export function addDaysStr(days) {
  const d = new Date();
  d.setDate(d.getDate() + (Number(days) || 0));
  return localDateStr(d);
}

export function sortActions(list) {
  return [...(list || [])].sort((a, b) => {
    const sa = a.sort ?? 9999, sb = b.sort ?? 9999;
    if (sa !== sb) return sa - sb;
    const ta = a.target_date || '9999-12-31', tb = b.target_date || '9999-12-31';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return (a.created_at || '') < (b.created_at || '') ? -1 : 1;
  });
}

export function isOpenAction(a) {
  return a.status !== 'done' && a.status !== 'cancelled';
}

// Next open action, preferring the earliest target date (undated last), then sort order.
export function nextOpenAction(list) {
  const open = (list || []).filter(isOpenAction);
  if (!open.length) return null;
  return [...open].sort((a, b) => {
    const ta = a.target_date || '9999-12-31', tb = b.target_date || '9999-12-31';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return (a.sort ?? 9999) - (b.sort ?? 9999);
  })[0];
}

export function isOverdueAction(a) {
  return isOpenAction(a) && !!a.target_date && a.target_date < localDateStr();
}
