import React, { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { callJobPlan } from '../plan/planQueries';
import { BTN } from '../../../lib/buttonStyles';

// Progress update (sql/349, 350) — replaces Job Review. On a job (a set of
// accounts or a self assessment): On track, Delayed or Stuck, what's in the
// way (Job Review's reasons), a note, and optionally a new date. The internal
// review date is the job's internal deadline; a new date re-ranks the job on
// the Priority board, which then re-dates the column, so the board and the
// workflow never disagree. Delayed or Stuck is a report: the manager is
// emailed straight away and it stays open on the board until dealt with.
// Nobody is asked for updates; silence means on track (Bobby, 2026-10-07).

const font = "'Outfit', sans-serif";
const fmt = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fmtTs = (ts) => new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const CONFIDENCE = {
  green: { label: 'On track', dot: '#16a34a', bg: '#dcfce7', fg: '#166534' },
  amber: { label: 'Delayed', dot: '#d97706', bg: '#fef3c7', fg: '#92400e' },
  red:   { label: 'Stuck', dot: '#dc2626', bg: '#fee2e2', fg: '#991b1b' },
};

export default function ProgressUpdateModal({ job, staffMap, initialConfidence, onClose, onSaved }) {
  // job: { template_key, entity_id, period_end, client, review_date?, limit? }
  const [reasons, setReasons] = useState([]);
  const [history, setHistory] = useState([]);
  const [confidence, setConfidenceRaw] = useState(initialConfidence || '');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [moveDate, setMoveDate] = useState(initialConfidence === 'amber');
  // Delayed usually means a new date, so it opens the date picker.
  const setConfidence = (k) => { setConfidenceRaw(k); if (k === 'amber') setMoveDate(true); };
  const [date, setDate] = useState(job.review_date || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  useEffect(() => {
    supabase.from('job_review_reason').select('code, label').eq('active', true).order('sort').then(({ data }) => setReasons(data || []));
    callJobPlan({ action: 'progress_history', template: job.template_key, entity_id: job.entity_id, period_end: job.period_end })
      .then((r) => setHistory(r.updates || [])).catch(() => {});
  }, [job.template_key, job.entity_id, job.period_end]);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const res = await callJobPlan({
        action: 'progress_update', template: job.template_key, entity_id: job.entity_id, period_end: job.period_end,
        confidence, reason_code: reason || null, note: note.trim() || null,
        review_date: moveDate && date && date !== job.review_date ? date : null,
      });
      setDone(res);
      onSaved && onSaved(res);
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const label = { fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 4 };
  const input = { padding: '6px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff' };
  const needsWhy = confidence && confidence !== 'green';

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.3)', zIndex: 115, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, width: 560, maxWidth: '96vw', maxHeight: '90vh', overflow: 'auto', padding: 18, fontFamily: font, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3 }}>Progress update</div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{job.client || 'Job'} <span style={{ color: '#64748b', fontWeight: 500 }}>· {job.template_key === 'self_assessment' ? 'Self assessment' : 'Accounts'} {job.period_end ? `YE ${fmt(job.period_end)}` : ''}</span></div>
            <div style={{ fontSize: 12.5, color: '#64748b', marginTop: 2 }}>Internal review (the internal deadline): <b style={{ color: '#0f172a' }}>{fmt(job.review_date)}</b>{job.limit ? <> · latest safe date {fmt(job.limit)}</> : null}</div>
          </div>
          <button onClick={onClose} style={BTN.secondary.sm}>Close</button>
        </div>

        {done ? (
          <div style={{ marginTop: 14, padding: 12, borderRadius: 8, background: '#f0fdf4', border: '1px solid #bbf7d0', fontSize: 13.5, color: '#14532d' }}>
            Update saved.
            {done.review_date && done.update?.review_date_requested && <> Internal review is now <b>{fmt(done.review_date)}</b>{done.review_date !== done.update.review_date_requested ? ` (the nearest the queue allows to ${fmt(done.update.review_date_requested)})` : ''}; the rest of the column has been re-dated.</>}
            {done.update?.status === 'open' && <> The manager has been told.</>}
            <div style={{ marginTop: 10 }}><button onClick={onClose} style={BTN.primary.sm}>Done</button></div>
          </div>
        ) : (
          <>
            <div style={{ marginTop: 14 }}>
              <div style={label}>Will it be ready for review by then?</div>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>Delayed or Stuck tells the manager straight away.</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {Object.entries(CONFIDENCE).map(([k, c]) => (
                  <button key={k} onClick={() => setConfidence(k)} style={{ ...BTN.secondary.sm, display: 'inline-flex', alignItems: 'center', gap: 6, background: confidence === k ? c.bg : '#fff', borderColor: confidence === k ? c.dot : '#cbd5e1', color: confidence === k ? c.fg : '#334155', fontWeight: confidence === k ? 700 : 500 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 5, background: c.dot }} />{c.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <div style={label}>What's in the way{needsWhy ? '' : ' (optional)'}</div>
              <select value={reason} onChange={(e) => setReason(e.target.value)} style={{ ...input, width: '100%' }}>
                <option value="">—</option>
                {reasons.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
              </select>
            </div>
            <div style={{ marginTop: 12 }}>
              <div style={label}>Note</div>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Where it's at, what you're waiting for" style={{ ...input, width: '100%', boxSizing: 'border-box', resize: 'vertical' }} />
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={moveDate} onChange={(e) => setMoveDate(e.target.checked)} />
              Change the internal review date
            </label>
            {moveDate && (
              <div style={{ marginTop: 6, marginLeft: 24, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <input type="date" value={date} max={job.limit || undefined} onChange={(e) => setDate(e.target.value)} style={{ ...input, width: 170 }} />
                <span style={{ fontSize: 12, color: '#64748b' }}>The job moves to that point in the Priority order and the column is re-dated, so the date you get may differ by a day or two.</span>
              </div>
            )}
            {error && <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
              <button disabled={!confidence || busy || (needsWhy && !reason && !note.trim())} onClick={save} style={BTN.primary.sm}>{busy ? 'Saving…' : 'Save update'}</button>
              <button onClick={onClose} style={BTN.secondary.sm}>Cancel</button>
            </div>
          </>
        )}

        <div style={{ marginTop: 16, fontSize: 12.5, fontWeight: 700, color: '#475569' }}>Earlier updates <span style={{ fontWeight: 500, color: '#94a3b8' }}>· {history.length}</span></div>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, marginTop: 4, maxHeight: 220, overflowY: 'auto' }}>
          {history.length === 0 && <div style={{ padding: 10, fontSize: 12.5, color: '#cbd5e1' }}>None yet.</div>}
          {history.map((u) => {
            const c = CONFIDENCE[u.confidence];
            return (
              <div key={u.id} style={{ padding: '7px 10px', borderBottom: '1px solid #f1f5f9', fontSize: 13 }}>
                <div style={{ fontSize: 11.5, color: '#94a3b8', marginBottom: 2, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: c?.dot }} />
                  <b style={{ color: '#475569' }}>{(staffMap?.[u.author_id]?.name || 'Someone').split(' ')[0]}</b> · {fmtTs(u.created_at)} · {c?.label}
                  {u.status === 'open' && <span style={{ padding: '0 6px', borderRadius: 8, background: '#fef3c7', color: '#92400e', fontWeight: 600 }}>open</span>}
                  {u.status === 'dealt_with' && <span style={{ padding: '0 6px', borderRadius: 8, background: '#dcfce7', color: '#166534', fontWeight: 600 }} title={u.dealt_with_note || ''}>dealt with</span>}
                  {u.review_date_requested && <span>· date {fmt(u.review_date_before)} → {fmt(u.review_date_after)}</span>}
                </div>
                {(u.reason_code || u.note) && <div style={{ whiteSpace: 'pre-wrap', color: '#1e293b' }}>{[reasons.find((r) => r.code === u.reason_code)?.label, u.note].filter(Boolean).join(' — ')}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
