import React, { useEffect, useState } from 'react';
import { CalendarPlus, CalendarDays, Trash2, Star, Download } from 'lucide-react';
import { listInterviews, createInterview, updateInterview, deleteInterview } from '../../api';
import {
  font, input, fieldLabel, btn, card,
  INTERVIEW_KINDS, INTERVIEW_STATUSES, INTERVIEW_STATUS_MAP,
  interviewIcs, downloadIcs, fmtNoteTime,
} from '../../recruitmentShared';

const KIND_MAP = Object.fromEntries(INTERVIEW_KINDS.map((k) => [k.key, k.label]));

export default function InterviewsPanel({ app, vacancyTitle, staffList, staffMap, profileId }) {
  const [items, setItems] = useState(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);

  const load = () => listInterviews(app.id).then(setItems).catch((e) => setError(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [app.id]);

  async function add(patch) {
    try {
      const iv = await createInterview({ ...patch, application_id: app.id }, profileId);
      setItems((prev) => [...(prev || []), iv].sort((a, b) => (a.scheduled_at || '') < (b.scheduled_at || '') ? -1 : 1));
      setAdding(false);
    } catch (e) { setError(e.message); }
  }
  async function patch(id, p) {
    setItems((prev) => (prev || []).map((i) => (i.id === id ? { ...i, ...p } : i)));
    try { await updateInterview(id, p); } catch (e) { setError(e.message); load(); }
  }
  async function remove(id) {
    if (!window.confirm('Delete this interview?')) return;
    setItems((prev) => (prev || []).filter((i) => i.id !== id));
    try { await deleteInterview(id); } catch (e) { setError(e.message); load(); }
  }

  function addToCalendar(iv) {
    const ics = interviewIcs({
      title: `Interview — ${app.candidate?.full_name || 'candidate'} (${vacancyTitle})`,
      start: iv.scheduled_at, durationMins: iv.duration_mins,
      location: iv.location, description: `${KIND_MAP[iv.kind]} interview`,
    });
    downloadIcs('interview.ics', ics);
  }

  return (
    <div>
      {error && <div style={{ fontSize: 12, color: '#b91c1c', marginBottom: 10 }}>{error}</div>}
      {items === null && <div style={{ fontSize: 12.5, color: '#94a3b8' }}>Loading…</div>}
      {items !== null && items.length === 0 && !adding && (
        <div style={{ fontSize: 12.5, color: '#94a3b8', marginBottom: 10 }}>No interviews scheduled.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(items || []).map((iv) => {
          const st = INTERVIEW_STATUS_MAP[iv.status];
          return (
            <div key={iv.id} style={{ ...card, padding: '11px 13px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <CalendarDays size={14} color="#0e7fe0" />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{KIND_MAP[iv.kind]}</span>
                <span style={{ fontSize: 12, color: '#64748b' }}>{iv.scheduled_at ? fmtNoteTime(iv.scheduled_at) : 'Unscheduled'} · {iv.duration_mins}m</span>
                <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: st.tone.bg, color: st.tone.fg, border: `1px solid ${st.tone.border}` }}>{st.label}</span>
              </div>
              {iv.location && <div style={{ fontSize: 12, color: '#475569', marginTop: 5 }}>{iv.location}</div>}
              {(iv.interviewers || []).length > 0 && (
                <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 4 }}>
                  With: {iv.interviewers.map((id) => staffMap[id]).filter(Boolean).join(', ')}
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <select value={iv.status} onChange={(e) => patch(iv.id, { status: e.target.value })}
                  style={{ ...input, width: 'auto', padding: '4px 8px', fontSize: 12 }}>
                  {INTERVIEW_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
                <span style={{ display: 'inline-flex', gap: 1 }}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} onClick={() => patch(iv.id, { score: iv.score === n ? null : n })}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 1, display: 'flex' }}>
                      <Star size={15} fill={n <= (iv.score || 0) ? '#f59e0b' : 'none'} color={n <= (iv.score || 0) ? '#f59e0b' : '#cbd5e1'} />
                    </button>
                  ))}
                </span>
                {iv.scheduled_at && (
                  <button onClick={() => addToCalendar(iv)} style={{ ...btn('ghost'), padding: '4px 8px' }} title="Download .ics">
                    <Download size={12} /> Calendar
                  </button>
                )}
                <button onClick={() => remove(iv.id)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#cbd5e1', cursor: 'pointer', display: 'flex' }}>
                  <Trash2 size={14} />
                </button>
              </div>
              <textarea value={iv.feedback || ''} onChange={(e) => patch(iv.id, { feedback: e.target.value })}
                rows={2} placeholder="Feedback…" style={{ ...input, marginTop: 8, resize: 'vertical', fontSize: 12.5 }} />
            </div>
          );
        })}
      </div>

      {adding
        ? <InterviewForm staffList={staffList} onCancel={() => setAdding(false)} onSave={add} />
        : <button onClick={() => setAdding(true)} style={{ ...btn('secondary'), marginTop: 12 }}><CalendarPlus size={13} /> Schedule interview</button>}
    </div>
  );
}

function InterviewForm({ staffList, onCancel, onSave }) {
  const [kind, setKind] = useState('video');
  const [when, setWhen] = useState('');
  const [duration, setDuration] = useState(45);
  const [location, setLocation] = useState('');
  const [interviewers, setInterviewers] = useState([]);

  function toggleInterviewer(id) {
    setInterviewers((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }
  function save() {
    onSave({
      kind, duration_mins: Number(duration) || 45, location: location.trim() || null,
      interviewers, scheduled_at: when ? new Date(when).toISOString() : null,
    });
  }

  return (
    <div style={{ ...card, padding: '13px 15px', marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <label style={fieldLabel}>Type</label>
          <select value={kind} onChange={(e) => setKind(e.target.value)} style={input}>
            {INTERVIEW_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </div>
        <div style={{ width: 90 }}>
          <label style={fieldLabel}>Mins</label>
          <input type="number" value={duration} onChange={(e) => setDuration(e.target.value)} style={input} />
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <label style={fieldLabel}>Date & time</label>
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} style={input} />
      </div>
      <div style={{ marginTop: 10 }}>
        <label style={fieldLabel}>Location or link</label>
        <input value={location} onChange={(e) => setLocation(e.target.value)} style={input} placeholder="Office, or a video link" />
      </div>
      <div style={{ marginTop: 10 }}>
        <label style={fieldLabel}>Interviewers</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {staffList.map((s) => (
            <button key={s.id} onClick={() => toggleInterviewer(s.id)}
              style={{
                padding: '4px 10px', fontSize: 12, fontFamily: font, borderRadius: 999, cursor: 'pointer',
                background: interviewers.includes(s.id) ? '#dbeafe' : '#fff',
                color: interviewers.includes(s.id) ? '#0c4a6e' : '#64748b',
                border: `1px solid ${interviewers.includes(s.id) ? '#93c5fd' : '#e5e7eb'}`,
              }}>{s.name}</button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button onClick={onCancel} style={btn('ghost')}>Cancel</button>
        <button onClick={save} style={btn('primary')}>Schedule</button>
      </div>
    </div>
  );
}
