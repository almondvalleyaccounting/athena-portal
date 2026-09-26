import React, { useEffect, useState } from 'react';
import { BTN } from '../../../lib/buttonStyles';

// Small pieces shared by the Planner (week) and the Day Plan.

const font = "'Outfit', sans-serif";

// Right-click menu. Fixed at the pointer, closes on any click or Escape.
export function ContextMenu({ menu, onClose }) {
  useEffect(() => {
    const off = () => onClose();
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('click', off); window.addEventListener('contextmenu', off); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('click', off); window.removeEventListener('contextmenu', off); window.removeEventListener('keydown', key); };
  }, [onClose]);
  if (!menu) return null;
  return (
    <div onClick={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      style={{ position: 'fixed', left: Math.min(menu.x, window.innerWidth - 210), top: Math.min(menu.y, window.innerHeight - 40 * menu.items.length - 20), zIndex: 130, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.12)', minWidth: 190, padding: 4, fontFamily: font }}>
      <div style={{ padding: '4px 10px 6px', fontSize: 11, color: '#94a3b8', borderBottom: '1px solid #f1f5f9', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 240 }}>{menu.title}</div>
      {menu.items.map((it, i) => (
        <button key={i} onClick={() => { onClose(); it.run(); }} disabled={it.disabled}
          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', fontSize: 13, background: 'none', border: 'none', borderRadius: 6, cursor: it.disabled ? 'default' : 'pointer', color: it.danger ? '#b91c1c' : it.disabled ? '#cbd5e1' : '#0f172a', fontFamily: font }}
          onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = '#f1f5f9'; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

// Minutes before a stage or a BM job is closed. Time goes to the timesheet.
export function MinutesModal({ ask, onClose }) {
  const [mins, setMins] = useState(ask.defaultMins != null ? String(ask.defaultMins) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await ask.run(Number(mins) || 0); onClose(); }
    catch (e) { setErr(e.message || String(e)); setBusy(false); }
  };
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.2)', zIndex: 125, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, padding: 18, width: 360, maxWidth: '92vw', fontFamily: font, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>{ask.title}</div>
        <div style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>{ask.subtitle}</div>
        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#94a3b8', marginBottom: 3 }}>Minutes spent</label>
        <input type="number" min={0} step={5} value={mins} autoFocus onChange={(e) => setMins(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') onClose(); }}
          style={{ width: 120, padding: '7px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 8 }} />
        {ask.note && <div style={{ fontSize: 12, color: '#64748b', marginTop: 8 }}>{ask.note}</div>}
        {err && <div style={{ fontSize: 12.5, color: '#991b1b', marginTop: 8 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={onClose} style={BTN.secondary.sm}>Cancel</button>
          <button onClick={go} disabled={busy} style={BTN.primary.sm}>{busy ? 'Saving…' : ask.cta || 'Log & done'}</button>
        </div>
      </div>
    </div>
  );
}

// Capacity for one person on one day, from working_days and weekly hours.
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export function dayCapacity(person, date) {
  const set = new Set((person?.working_days || 'mon,tue,wed,thu,fri').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
  if (!set.size) ['mon', 'tue', 'wed', 'thu', 'fri'].forEach((d) => set.add(d));
  if (!set.has(DOW[date.getDay()])) return 0;
  const weekly = person?.weekly_capacity_hours != null ? Number(person.weekly_capacity_hours) : set.size * 7.5;
  return weekly / set.size;
}
export const loadColour = (used, cap) => (cap <= 0 ? '#94a3b8' : used > cap * 1.2 ? '#991b1b' : used > cap ? '#9a3412' : used > cap * 0.8 ? '#92400e' : '#166534');
export const shortTask = (name) => String(name || '').replace(/\s*(Year End|Quarterly End|Monthly End|Period End|Tax Year).*$/i, '');
