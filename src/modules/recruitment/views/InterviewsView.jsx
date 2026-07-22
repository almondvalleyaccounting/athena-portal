import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, ChevronRight } from 'lucide-react';
import { upcomingInterviews } from '../api';
import { font, card, INTERVIEW_KINDS, fmtNoteTime } from '../recruitmentShared';

const KIND_MAP = Object.fromEntries(INTERVIEW_KINDS.map((k) => [k.key, k.label]));

// Cross-vacancy schedule of upcoming (status = scheduled) interviews.
export default function InterviewsView() {
  const navigate = useNavigate();
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    upcomingInterviews().then(setItems).catch((e) => setError(e.message));
  }, []);

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <CalendarDays size={20} color="#0e7fe0" />
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>Interviews</h1>
      </div>
      <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 16px' }}>Upcoming interviews across all open vacancies.</p>

      {error && <div style={{ fontSize: 13, color: '#b91c1c', marginBottom: 12 }}>{error}</div>}
      {items === null && <div style={{ ...card, padding: 18, textAlign: 'center', fontSize: 13, color: '#94a3b8' }}>Loading…</div>}
      {items !== null && items.length === 0 && (
        <div style={{ ...card, padding: '30px 18px', textAlign: 'center', fontSize: 13.5, color: '#94a3b8' }}>No interviews scheduled.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(items || []).map((iv) => {
          const appl = iv.application;
          return (
            <div key={iv.id} onClick={() => appl?.vacancy_id && navigate(`/recruitment/${appl.vacancy_id}`)}
              style={{ ...card, padding: '13px 16px', cursor: appl?.vacancy_id ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ textAlign: 'center', minWidth: 64 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0e7fe0' }}>
                  {iv.scheduled_at ? fmtNoteTime(iv.scheduled_at) : 'TBC'}
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>{iv.duration_mins}m</div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>
                  {appl?.candidate?.full_name || 'Candidate'}
                </div>
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  {KIND_MAP[iv.kind]} · {appl?.vacancy?.title || 'Vacancy'}
                </div>
              </div>
              <ChevronRight size={18} color="#cbd5e1" />
            </div>
          );
        })}
      </div>
    </div>
  );
}
