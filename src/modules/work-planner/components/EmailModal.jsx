import React, { useEffect, useState } from 'react';
import { callJobPlan } from '../plan/planQueries';
import { BTN } from '../../../lib/buttonStyles';

// Email from a task (Bobby, 2026-09-26). First choose who and what: a blank
// email to the client about the task, a blank one to a team member, a blank
// one to anyone, or a records request to the client. Then compose and send
// from your own mailbox. Client-linked sends are logged on the client page.

const font = "'Outfit', sans-serif";
const GRP_LABEL = { company: 'Company records', personal: 'Director’s personal tax', other: 'Other' };
const input = { padding: '6px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6, width: '100%' };

const MODES = [
  { id: 'client',  label: 'Blank email to the client',   needsClient: true },
  { id: 'team',    label: 'Blank email to a team member' },
  { id: 'other',   label: 'Blank email to someone else' },
  { id: 'records', label: 'Ask the client for records',  needsClient: true },
];

export default function EmailModal({ ctx, staffList = [], profile, onClose, onSent }) {
  const [mode, setMode] = useState(null);
  const [preview, setPreview] = useState(null);
  const [to, setTo] = useState('');
  const [staffId, setStaffId] = useState('');
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [picker, setPicker] = useState(null);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const myFirst = (profile?.name || '').split(' ')[0] || '';
  const taskLabel = ctx.task_label || '';
  const hasClient = !!ctx.entity_id;

  const picked = (p = picker) => (p || []).filter((i) => i.ticked).map((i) => (i.key ? { key: i.key } : { text: i.label }));

  const start = async (m) => {
    setMode(m); setError(null);
    if (m === 'client' || m === 'records') {
      try {
        const res = await callJobPlan({ action: 'preview_email', entity_id: ctx.entity_id, kind: m === 'records' ? 'records_request' : 'blank', task_label: taskLabel });
        setPreview(res.preview); setTo(res.preview.to || ''); setSubject(res.preview.subject); setText(res.preview.text);
        if (res.preview.picker) setPicker(res.preview.picker);
      } catch (e) { setError(e.message || String(e)); }
    } else {
      const subj = [ctx.entity_name, taskLabel].filter(Boolean).join(' – ');
      setSubject(subj); setText(`Hi ,\n\n\n\nThanks,\n${myFirst}`); setTo('');
    }
  };

  useEffect(() => {
    if (mode !== 'team' || !staffId) return;
    const s = staffList.find((x) => x.id === staffId);
    if (!s) return;
    setTo(s.email || '');
    setText((t) => t.replace(/^Hi [^,]*,/, `Hi ${(s.name || '').split(' ')[0]},`));
  }, [staffId, mode, staffList]);

  // Records: the text re-renders as the ticks change, then stays editable.
  const rerender = async (next) => {
    setPicker(next);
    try {
      const res = await callJobPlan({ action: 'preview_email', entity_id: ctx.entity_id, kind: 'records_request', task_label: taskLabel, items: picked(next) });
      setText(res.preview.text);
    } catch (e) { setError(e.message || String(e)); }
  };
  const addCustom = () => {
    const t = custom.trim();
    if (!t) return;
    setCustom('');
    rerender([...picker, { key: null, label: t, grp: 'other', ticked: true, remembered: false }]);
  };

  const send = async (test) => {
    setBusy(true); setError(null);
    try {
      const res = await callJobPlan({
        action: 'send_email', entity_id: hasClient ? ctx.entity_id : null, to: test ? profile?.email : to, subject, text, test,
        kind: mode === 'records' ? 'records_request' : 'blank', items: mode === 'records' ? picked() : undefined, period_end: preview?.period_end || null,
        task: ctx.task || null, task_label: taskLabel || null, to_staff_id: mode === 'team' ? staffId || null : null,
      });
      if (test) setNote(`Test copy sent to ${res.to}.`);
      else { onSent && onSent(); onClose(); }
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const groups = picker ? ['company', 'personal', 'other'].filter((g) => picker.some((i) => i.grp === g)) : [];

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.25)', zIndex: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, width: mode === 'records' && picker ? 980 : mode ? 640 : 420, maxWidth: '96vw', maxHeight: '92vh', overflow: 'auto', padding: 18, fontFamily: font, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 2 }}>Email{taskLabel ? ` · ${taskLabel}` : ''}{ctx.entity_name ? ` · ${ctx.entity_name}` : ''}</div>

        {!mode ? (
          <>
            <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 12 }}>What kind of email?</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {MODES.map((m) => (
                <button key={m.id} onClick={() => start(m.id)} disabled={m.needsClient && !hasClient} style={{ ...BTN.secondary.sm, textAlign: 'left', padding: '9px 12px', fontSize: 13.5, opacity: m.needsClient && !hasClient ? 0.45 : 1, cursor: m.needsClient && !hasClient ? 'default' : 'pointer' }}>
                  {m.label}{m.needsClient && !hasClient ? ' (no client on this task)' : ''}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}><button onClick={onClose} style={BTN.secondary.sm}>Cancel</button></div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 10 }}>
              {preview?.from_email ? `Goes from your mailbox (${preview.from_email})` : 'Goes from your mailbox if connected, else the practice mailbox with your name on it'}, plain text{hasClient && mode !== 'team' ? ', and is logged on the client page' : ''}.
              {mode === 'team' && ctx.task ? ' It carries a link back to this task; their reply in Athena comes to you by email.' : ''}
            </div>
            {error && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13, marginBottom: 8 }}>{error}</div>}
            {note && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#dcfce7', color: '#166534', fontSize: 13, marginBottom: 8 }}>{note}</div>}
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              {mode === 'records' && picker && (
                <div style={{ width: 330, flexShrink: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 4 }}>What to ask this client for</div>
                  <div style={{ fontSize: 11.5, color: '#94a3b8', marginBottom: 8 }}>{picker.some((i) => i.remembered) ? 'Pre-ticked from what we asked them for last time.' : 'Pre-ticked defaults.'} Your ticks are remembered for next year.</div>
                  {groups.map((g) => (
                    <div key={g} style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '4px 0' }}>
                        <span style={{ fontSize: 11.5, fontWeight: 600, color: '#475569', flex: 1 }}>{GRP_LABEL[g]}</span>
                        <button onClick={() => rerender(picker.map((x) => (x.grp === g ? { ...x, ticked: true } : x)))} style={{ ...BTN.secondary.sm, padding: '1px 7px', fontSize: 11.5 }}>All</button>
                        <button onClick={() => rerender(picker.map((x) => (x.grp === g ? { ...x, ticked: false } : x)))} style={{ ...BTN.secondary.sm, padding: '1px 7px', fontSize: 11.5 }}>None</button>
                      </div>
                      {picker.map((i, idx) => i.grp === g && (
                        <label key={i.key || `c${idx}`} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12.5, padding: '2px 0', cursor: 'pointer' }}>
                          <input type="checkbox" checked={i.ticked} onChange={(e) => rerender(picker.map((x, n) => (n === idx ? { ...x, ticked: e.target.checked } : x)))} style={{ marginTop: 3 }} />
                          <span>{i.label}{i.remembered && <span style={{ color: '#94a3b8' }}> · last year</span>}</span>
                        </label>
                      ))}
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <input value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addCustom(); }} placeholder="Something specific" style={{ ...input, padding: '5px 8px', fontSize: 12.5 }} />
                    <button onClick={addCustom} style={BTN.secondary.sm}>Add</button>
                  </div>
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', width: 56 }}>To</span>
                  {mode === 'team' ? (
                    <select value={staffId} onChange={(e) => setStaffId(e.target.value)} style={{ ...input, width: 'auto', flex: 1 }}>
                      <option value="">Pick a colleague</option>
                      {staffList.filter((s) => s.id !== profile?.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  ) : (
                    <input value={to} onChange={(e) => setTo(e.target.value)} placeholder={mode === 'other' ? 'name@example.com' : 'No email address on file'} style={input} />
                  )}
                  {preview?.to_reason && mode !== 'team' && mode !== 'other' && <span style={{ fontSize: 11.5, color: '#94a3b8' }}>{preview.to_reason}</span>}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', width: 56 }}>Subject</span>
                  <input value={subject} onChange={(e) => setSubject(e.target.value)} style={input} />
                </div>
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={12} style={{ ...input, fontSize: 13.5, lineHeight: 1.5, resize: 'vertical', background: '#f8fafc', marginBottom: 10 }} />
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  <button onClick={() => { setMode(null); setPicker(null); setPreview(null); }} style={{ ...BTN.secondary.sm, marginRight: 'auto' }}>Back</button>
                  <button onClick={onClose} style={BTN.secondary.sm}>Cancel</button>
                  {profile?.email && <button onClick={() => send(true)} disabled={busy} style={BTN.secondary.sm}>Send a copy to me</button>}
                  <button onClick={() => send(false)} disabled={busy || !to || !subject} style={{ ...BTN.primary.sm, opacity: busy || !to || !subject ? 0.5 : 1 }}>{busy ? 'Sending…' : 'Send'}</button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
