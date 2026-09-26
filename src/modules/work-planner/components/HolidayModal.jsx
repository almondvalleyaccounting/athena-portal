import React, { useState } from 'react';
import { callJobPlan } from '../plan/planQueries';
import { formatISO } from '../lib/helpers';
import EmailModal from './EmailModal';
import { BTN } from '../../../lib/buttonStyles';

// Holidays (sql/317): block out days on the Planner, and the handover
// feature — ask the team who is covering, or hand unfinished work to a
// colleague — with the email prefilled from the system and editable.

const font = "'Outfit', sans-serif";
const input = { padding: '6px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6 };
const fmt = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const KINDS = [{ id: 'holiday', label: 'Holiday' }, { id: 'sick', label: 'Sick' }, { id: 'other', label: 'Other' }];

export default function HolidayModal({ holidays, staffList, staffMap, profile, canManage, onChanged, onClose }) {
  const [staffId, setStaffId] = useState(profile?.id || '');
  const [from, setFrom] = useState(formatISO(new Date()));
  const [to, setTo] = useState(formatISO(new Date()));
  const [kind, setKind] = useState('holiday');
  const [half, setHalf] = useState(false);
  const [note, setNote] = useState('');
  const [cover, setCover] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [email, setEmail] = useState(null); // EmailModal preset
  const todayISO = formatISO(new Date());
  const mine = holidays.filter((h) => h.staff_id === (canManage ? staffId : profile?.id) && h.date_to >= todayISO).sort((a, b) => a.date_from.localeCompare(b.date_from));
  const others = holidays.filter((h) => h.staff_id !== profile?.id && h.date_to >= todayISO).sort((a, b) => a.date_from.localeCompare(b.date_from)).slice(0, 12);

  const add = async () => {
    setBusy(true); setError(null);
    try {
      await callJobPlan({ action: 'save_holiday', staff_id: staffId || null, date_from: from, date_to: to, kind, half_day: half, note: note || null, cover_staff_id: cover || null });
      setNote(''); await onChanged();
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };
  const remove = async (h) => {
    if (!window.confirm(`Remove ${fmt(h.date_from)}${h.date_to !== h.date_from ? ` to ${fmt(h.date_to)}` : ''}?`)) return;
    try { await callJobPlan({ action: 'delete_holiday', id: h.id }); await onChanged(); }
    catch (e) { setError(e.message || String(e)); }
  };

  // The two emails: prefilled from the system, edited before sending.
  const draft = async (mode, h) => {
    setBusy(true); setError(null);
    try {
      const res = await callJobPlan({ action: 'handover_preview', mode, date_from: h.date_from, date_to: h.date_to });
      if (mode === 'cover') {
        const team = staffList.filter((s) => s.id !== profile?.id && s.email && s.work_planner !== false).map((s) => s.email).join(', ');
        setEmail({ mode: 'other', to: team, subject: res.subject, text: res.text, task_label: 'Cover request' });
      } else {
        setEmail({ mode: 'team', staffId: h.cover_staff_id || '', subject: res.subject, text: res.text, task_label: 'Handover' });
      }
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.25)', zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, width: 680, maxWidth: '96vw', maxHeight: '90vh', overflow: 'auto', padding: 18, fontFamily: font, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 17, fontWeight: 700, flex: 1 }}>Holidays</div>
          <button onClick={onClose} style={BTN.secondary.sm}>Close</button>
        </div>
        <div style={{ fontSize: 12.5, color: '#64748b', margin: '2px 0 12px' }}>Days off block out the Planner and Day plan (capacity 0) and flag the Overview. From each holiday you can ask the team who is covering, or hand your open work to a colleague.</div>
        {error && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13, marginBottom: 8 }}>{error}</div>}

        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, marginBottom: 12, background: '#f8fafc' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 6 }}>Add</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {canManage && (
              <select value={staffId} onChange={(e) => setStaffId(e.target.value)} style={input}>
                {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
            <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }} style={input} />
            <span style={{ fontSize: 12.5, color: '#64748b' }}>to</span>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} style={input} />
            <select value={kind} onChange={(e) => setKind(e.target.value)} style={input}>{KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select>
            <label style={{ fontSize: 12.5, display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={half} onChange={(e) => setHalf(e.target.checked)} />Half day</label>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" style={{ ...input, flex: 1 }} />
            <select value={cover} onChange={(e) => setCover(e.target.value)} style={input} title="Who is covering">
              <option value="">Cover: not decided</option>
              {staffList.filter((s) => s.id !== staffId).map((s) => <option key={s.id} value={s.id}>Cover: {s.name.split(' ')[0]}</option>)}
            </select>
            <button onClick={add} disabled={busy} style={BTN.primary.sm}>{busy ? 'Saving…' : 'Add'}</button>
          </div>
        </div>

        <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 4 }}>{canManage && staffId !== profile?.id ? `${staffMap[staffId]?.name?.split(' ')[0] || ''}’s upcoming` : 'Your upcoming'} · {mine.length}</div>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 12 }}>
          {mine.length === 0 && <div style={{ padding: 10, fontSize: 12.5, color: '#cbd5e1' }}>Nothing booked.</div>}
          {mine.map((h) => (
            <div key={h.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 10px', borderBottom: '1px solid #f1f5f9', fontSize: 13 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 500 }}>{fmt(h.date_from)}{h.date_to !== h.date_from ? ` – ${fmt(h.date_to)}` : ''}</span>
                <span style={{ color: '#64748b' }}> · {KINDS.find((k) => k.id === h.kind)?.label}{h.half_day ? ' · half day' : ''}{h.cover_staff_id ? ` · cover ${staffMap[h.cover_staff_id]?.name?.split(' ')[0] || ''}` : ''}{h.note ? ` · ${h.note}` : ''}</span>
              </div>
              {h.staff_id === profile?.id && <button onClick={() => draft('cover', h)} disabled={busy} style={BTN.secondary.sm}>Ask who’s covering…</button>}
              {h.staff_id === profile?.id && <button onClick={() => draft('handover', h)} disabled={busy} style={BTN.secondary.sm}>Hand over…</button>}
              <button onClick={() => remove(h)} style={BTN.danger.sm}>Remove</button>
            </div>
          ))}
        </div>

        {others.length > 0 && (
          <>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 4 }}>Team, coming up</div>
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 8 }}>
              {others.map((h) => (
                <div key={h.id} style={{ padding: '5px 10px', borderBottom: '1px solid #f1f5f9', fontSize: 12.5 }}>
                  <span style={{ fontWeight: 500 }}>{staffMap[h.staff_id]?.name?.split(' ')[0] || 'Someone'}</span>
                  <span style={{ color: '#64748b' }}> · {fmt(h.date_from)}{h.date_to !== h.date_from ? ` – ${fmt(h.date_to)}` : ''}{h.cover_staff_id ? ` · cover ${staffMap[h.cover_staff_id]?.name?.split(' ')[0] || ''}` : ''}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      {email && <EmailModal ctx={{ entity_id: null, entity_name: null, task_label: email.task_label }} preset={email} staffList={staffList} profile={profile} onClose={() => setEmail(null)} />}
    </div>
  );
}
