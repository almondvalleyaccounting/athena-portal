import { TEAM_COLOURS, STATUSES } from './constants';

// ── Team colour from UUID hash ──
// Deterministic: same UUID always gets the same colour
export function teamColour(uuid) {
  if (!uuid) return '#94a3b8';
  let hash = 0;
  for (let i = 0; i < uuid.length; i++) {
    hash = ((hash << 5) - hash + uuid.charCodeAt(i)) | 0;
  }
  return TEAM_COLOURS[Math.abs(hash) % TEAM_COLOURS.length];
}

// ── Initials from full name ──
export function initials(name) {
  if (!name) return '?';
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

// ── Duration formatting ──
// 15 → "15m", 60 → "1h", 90 → "1h 30m", 180 → "3h"
export function durFmt(mins) {
  if (!mins && mins !== 0) return '';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ── Date formatting ──
export function formatDateShort(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function formatDateFull(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function formatISO(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().slice(0, 10);
}

export function formatTime(h, m) {
  return `${String(h).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`;
}

// ── Date arithmetic ──
export function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function addMonths(d, n) {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

export function startOfWeek(d) {
  const r = new Date(d);
  const day = r.getDay();
  r.setDate(r.getDate() - (day === 0 ? 6 : day - 1));
  r.setHours(0, 0, 0, 0);
  return r;
}

export function sameDay(a, b) {
  if (!a || !b) return false;
  const da = a instanceof Date ? a : new Date(a);
  const db = b instanceof Date ? b : new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

export function today() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// ── Due badge logic ──
export function dueBadge(dateStr) {
  if (!dateStr) return null;
  const now = today();
  const due = new Date(dateStr);
  due.setHours(0, 0, 0, 0);
  const diff = Math.ceil((due - now) / 86400000);
  if (diff < 0) return { text: 'Overdue', colour: '#dc2626', bg: '#fef2f2' };
  if (diff === 0) return { text: 'Today', colour: '#0e7fe0', bg: '#dbeafe' };
  if (diff === 1) return { text: 'Tmrw', colour: '#0e7fe0', bg: '#dbeafe' };
  return { text: formatDateShort(due), colour: '#64748b', bg: '#f1f5f9' };
}

// ── Status lookup ──
export function getStatus(id) {
  return STATUSES.find((s) => s.id === id) || null;
}

// ── Apply filters ──
export function applyFilters(list, { teamFilter, clientFilter, serviceFilter, statusFilter } = {}) {
  let result = list;
  if (teamFilter) result = result.filter((t) => t.assignee_id === teamFilter);
  if (clientFilter) result = result.filter((t) => t.entity_id === clientFilter);
  if (serviceFilter) result = result.filter((t) => t.service === serviceFilter);
  if (statusFilter) result = result.filter((t) => t.status === statusFilter);
  return result;
}

// ── Name lookups with fallbacks ──
export function staffName(id, staffMap) {
  if (!id || !staffMap) return 'Unassigned';
  const s = staffMap[id];
  return s ? s.full_name || s.name || 'Unknown' : 'Former staff';
}

export function staffFirstName(id, staffMap) {
  const name = staffName(id, staffMap);
  return name.split(' ')[0];
}

export function clientName(id, entityMap) {
  if (!id || !entityMap) return '';
  const e = entityMap[id];
  return e ? e.name || 'Unknown' : 'Removed client';
}
