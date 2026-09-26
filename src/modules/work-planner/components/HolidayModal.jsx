import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { callJobPlan } from '../plan/planQueries';
import { formatISO, addDays } from '../lib/helpers';
import { generateInstances } from '../lib/instanceEngine';
import { useWorkPlanner } from '../WorkPlannerModule';
import EmailModal from './EmailModal';
import { BTN } from '../../../lib/buttonStyles';

// Holidays (sql/317, sql/320): book days off, then hand over task by task.
// A holiday picks up every task of the person's inside the dates; each gets
// one decision — covered by a colleague, done before I go, moved to after
// I'm back, or can wait. A deadline inside the dates cannot wait. Cover is
// temporary and the owner stays the owner. Handover emails go per colleague
// when the owner presses Send handovers; they are due two full working days
// before the person goes.

const font = "'Outfit', sans-serif";
const input = { padding: '6px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6 };
const fmt = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const KINDS = [{ id: 'holiday', label: 'Holiday' }, { id: 'sick', label: 'Sick' }, { id: 'other', label: 'Other' }];
const DECISIONS = [
  { id: 'covered', label: 'Covered by…' },
  { id: 'done_before', label: 'Done before I go' },
  { id: 'moved_after', label: 'Moved to after I’m back' },
  { id: 'can_wait', label: 'Can wait' },
];
const dkey = (t) => `${t.type}:${t.id}${t.occurrence_date ? `:${t.occurrence_date}` : ''}`;

// One holiday's task list with its decisions.
function HandoverPanel({ holiday, staffList, staffMap, profile, onSent }) {
  const { scheduledTasks, overridesMap, completedKeys } = useWorkPlanner();
  const [tasks, setTasks] = useState(null);
  const [decisions, setDecisions] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // task key being saved
  const [drafts, setDrafts] = useState(null); // remaining handover drafts to send
  const [pending, setPending] = useState({}); // key -> { decision, cover, date }

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await callJobPlan({ action: 'holiday_tasks', holiday_id: holiday.id });
      // Blocks: the browser holds the occurrence engine.
      const blocks = [];
      const from = new Date(`${holiday.date_from}T12:00:00`), to = new Date(`${holiday.date_to}T12:00:00`);
      scheduledTasks.filter((m) => m.assignee_id === holiday.staff_id && m.planned_date).forEach((m) => {
        generateInstances(m, from, to, overridesMap, completedKeys).forEach((inst) => {
          blocks.push({ type: 'block', id: m.id, occurrence_date: formatISO(inst._date), date: formatISO(inst._date), deadline: null, title: m.title, client: null, hours: (m.duration || 0) / 60 });
        });
      });
      setTasks([...res.tasks, ...blocks].sort((a, b) => String(a.date).localeCompare(String(b.date))));
      setDecisions(res.decisions);
    } catch (e) { setError(e.message || String(e)); }
  }, [holiday.id, holiday.staff_id, holiday.date_from, holiday.date_to, scheduledTasks, overridesMap, completedKeys]);
  useEffect(() => { load(); }, [load]);

  const decisionFor = (t) => decisions.find((d) => d.task_type === t.type && d.task_id === t.id && (d.occurrence_date || null) === (t.occurrence_date || null));
  const insideDeadline = (t) => t.deadline && t.deadline >= holiday.date_from && t.deadline <= holiday.date_to;

  const save = async (t, choice) => {
    const key = dkey(t);
    setBusy(key); setError(null);
    try {
      await callJobPlan({ action: 'set_handover', holiday_id: holiday.id, task: { type: t.type, id: t.id, occurrence_date: t.occurrence_date || null }, decision: choice.decision, cover_staff_id: choice.cover || null, new_date: choice.date || null });
      setPending((p) => { const n = { ...p }; delete n[key]; return n; });
      await load();
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(null); }
  };

  const startSend = async () => {
    setError(null);
    try {
      const res = await callJobPlan({ action: 'handover_drafts', holiday_id: holiday.id });
      if (!res.drafts.length) { setError('Nothing to send: no covered tasks waiting for a handover.'); return; }
      setDrafts(res.drafts);
    } catch (e) { setError(e.message || String(e)); }
  };
  const sentOne = async (d) => {
    try { await callJobPlan({ action: 'mark_handover_sent', holiday_id: holiday.id, cover_staff_id: d.cover_staff_id }); } catch (e) { setError(e.message || String(e)); }
    setDrafts((list) => { const rest = list.slice(1); return rest.length ? rest : null; });
    await load(); onSent && onSent();
  };

  const undecided = (tasks || []).filter((t) => !decisionFor(t));
  const unsent = decisions.filter((d) => d.decision === 'covered' && d.cover_staff_id && !d.sent_at);
  const today = formatISO(new Date());
  const overdue = holiday.handover_due && today > holiday.handover_due && unsent.length > 0;

  return (
    <div style={{ marginTop: 6, borderTop: '1px solid #f1f5f9', paddingTop: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6, fontSize: 12.5 }}>
        <span style={{ fontWeight: 700, color: undecided.length ? '#9a3412' : '#166534' }}>{tasks ? `${undecided.length} task${undecided.length === 1 ? '' : 's'} with no plan` : 'Loading…'}</span>
        {holiday.handover_due && <span style={{ color: overdue ? '#b91c1c' : '#64748b', fontWeight: overdue ? 700 : 500 }}>{overdue ? 'Handover overdue' : `Handovers due by close of business ${fmt(holiday.handover_due)}`}</span>}
        {unsent.length > 0 && <span style={{ color: '#64748b' }}>· {unsent.length} covered, not yet sent</span>}
        <span style={{ flex: 1 }} />
        {holiday.staff_id === profile?.id && <button onClick={startSend} disabled={!unsent.length} style={{ ...BTN.primary.sm, opacity: unsent.length ? 1 : 0.5 }}>Send handovers</button>}
      </div>
      {error && <div style={{ padding: '6px 10px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 12.5, marginBottom: 6 }}>{error}</div>}
      {tasks && tasks.length === 0 && <div style={{ fontSize: 12.5, color: '#94a3b8' }}>Nothing falls inside these dates.</div>}
      {(tasks || []).map((t) => {
        const key = dkey(t);
        const d = decisionFor(t);
        const p = pending[key] || { decision: d?.decision || '', cover: d?.cover_staff_id || '', date: d?.new_date || '' };
        const set = (patch) => setPending((all) => ({ ...all, [key]: { ...p, ...patch } }));
        const dirty = !!pending[key];
        const needsDate = p.decision === 'done_before' || p.decision === 'moved_after';
        const canSave = p.decision && (p.decision !== 'covered' || p.cover) && (!needsDate || p.date);
        return (
          <div key={key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'center', padding: '6px 8px', borderBottom: '1px solid #f1f5f9', background: d ? '#fff' : '#fffbeb', fontSize: 13 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.client ? `${t.client} · ` : ''}{t.title}</div>
              <div style={{ fontSize: 11.5, color: '#64748b' }}>
                {fmt(t.date)}{t.hours ? ` · ${Math.round(t.hours * 10) / 10}h` : ''}{t.deadline ? ` · deadline ${fmt(t.deadline)}` : ''}{insideDeadline(t) ? <span style={{ color: '#b91c1c', fontWeight: 600 }}> · cannot wait</span> : ''}
                {d?.sent_at ? <span style={{ color: '#166534' }}> · handover sent</span> : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <select value={p.decision} onChange={(e) => set({ decision: e.target.value })} style={{ ...input, padding: '4px 6px', fontSize: 12.5 }}>
                <option value="">Decide…</option>
                {DECISIONS.map((x) => <option key={x.id} value={x.id} disabled={x.id === 'can_wait' && insideDeadline(t)}>{x.label}</option>)}
              </select>
              {p.decision === 'covered' && (
                <select value={p.cover} onChange={(e) => set({ cover: e.target.value })} style={{ ...input, padding: '4px 6px', fontSize: 12.5 }}>
                  <option value="">Who?</option>
                  {staffList.filter((s) => s.id !== holiday.staff_id).map((s) => <option key={s.id} value={s.id}>{s.name.split(' ')[0]}</option>)}
                </select>
              )}
              {needsDate && (
                <input type="date" value={p.date} min={p.decision === 'moved_after' ? formatISO(addDays(new Date(`${holiday.date_to}T12:00:00`), 1)) : undefined} max={p.decision === 'done_before' ? formatISO(addDays(new Date(`${holiday.date_from}T12:00:00`), -1)) : (t.deadline || undefined)} onChange={(e) => set({ date: e.target.value })} style={{ ...input, padding: '4px 6px', fontSize: 12.5 }} />
              )}
              {(dirty || !d) && <button onClick={() => save(t, p)} disabled={!canSave || busy === key} style={{ ...BTN.primary.sm, padding: '3px 8px' }}>{busy === key ? '…' : 'Save'}</button>}
              {d && !dirty && <span style={{ fontSize: 11.5, color: '#166534', fontWeight: 600 }}>{d.decision === 'covered' ? `${staffMap[d.cover_staff_id]?.name?.split(' ')[0] || ''} covers` : d.decision === 'done_before' ? `before, ${fmt(d.new_date)}` : d.decision === 'moved_after' ? `after, ${fmt(d.new_date)}` : 'can wait'}</span>}
            </div>
          </div>
        );
      })}
      {drafts && drafts.length > 0 && (
        <EmailModal key={drafts[0].cover_staff_id} ctx={{ entity_id: null, entity_name: null, task_label: `Handover (${drafts.length} to send)` }} staffList={staffList} profile={profile}
          preset={{ mode: 'team', staffId: drafts[0].cover_staff_id, to: drafts[0].to, subject: drafts[0].subject, text: drafts[0].text }}
          onClose={() => setDrafts(null)} onSent={() => sentOne(drafts[0])} />
      )}
    </div>
  );
}

export default function HolidayModal({ holidays, staffList, staffMap, profile, canManage, onChanged, onClose }) {
  const [staffId, setStaffId] = useState(profile?.id || '');
  const [from, setFrom] = useState(formatISO(new Date()));
  const [to, setTo] = useState(formatISO(new Date()));
  const [kind, setKind] = useState('holiday');
  const [half, setHalf] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null); // holiday id with the handover panel open
  const [email, setEmail] = useState(null);
  const todayISO = formatISO(new Date());
  const viewing = canManage ? staffId : profile?.id;
  const mine = useMemo(() => holidays.filter((h) => h.staff_id === viewing && h.date_to >= todayISO).sort((a, b) => a.date_from.localeCompare(b.date_from)), [holidays, viewing, todayISO]);
  const others = useMemo(() => holidays.filter((h) => h.staff_id !== profile?.id && h.date_to >= todayISO).sort((a, b) => a.date_from.localeCompare(b.date_from)).slice(0, 12), [holidays, profile?.id, todayISO]);

  const add = async () => {
    setBusy(true); setError(null);
    try {
      const res = await callJobPlan({ action: 'save_holiday', staff_id: staffId || null, date_from: from, date_to: to, kind, half_day: half, note: note || null });
      setNote(''); await onChanged(); setOpen(res.id);
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };
  const remove = async (h) => {
    if (!window.confirm(`Remove ${fmt(h.date_from)}${h.date_to !== h.date_from ? ` to ${fmt(h.date_to)}` : ''}? Any handover decisions go with it.`)) return;
    try { await callJobPlan({ action: 'delete_holiday', id: h.id }); await onChanged(); }
    catch (e) { setError(e.message || String(e)); }
  };
  const askCover = async (h) => {
    setBusy(true); setError(null);
    try {
      const res = await callJobPlan({ action: 'handover_preview', mode: 'cover', date_from: h.date_from, date_to: h.date_to });
      const team = staffList.filter((s) => s.id !== profile?.id && s.email && s.work_planner !== false).map((s) => s.email).join(', ');
      setEmail({ mode: 'other', to: team, subject: res.subject, text: res.text, task_label: 'Cover request' });
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.25)', zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, width: 820, maxWidth: '96vw', maxHeight: '90vh', overflow: 'auto', padding: 18, fontFamily: font, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 17, fontWeight: 700, flex: 1 }}>Holidays</div>
          <button onClick={onClose} style={BTN.secondary.sm}>Close</button>
        </div>
        <div style={{ fontSize: 12.5, color: '#64748b', margin: '2px 0 12px' }}>Book the days first. Every task of yours inside the dates then needs one decision: covered by a colleague, done before you go, moved to after you're back, or can wait. Handovers go per colleague when you press Send handovers, and are due two full working days before you go.</div>
        {error && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13, marginBottom: 8 }}>{error}</div>}

        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, marginBottom: 12, background: '#f8fafc' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 6 }}>Book</div>
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
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" style={{ ...input, flex: 1, minWidth: 140 }} />
            <button onClick={add} disabled={busy} style={BTN.primary.sm}>{busy ? 'Saving…' : 'Book'}</button>
          </div>
        </div>

        <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 4 }}>{canManage && staffId !== profile?.id ? `${staffMap[staffId]?.name?.split(' ')[0] || ''}’s upcoming` : 'Your upcoming'} · {mine.length}</div>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 12 }}>
          {mine.length === 0 && <div style={{ padding: 10, fontSize: 12.5, color: '#cbd5e1' }}>Nothing booked.</div>}
          {mine.map((h) => (
            <div key={h.id} style={{ padding: '7px 10px', borderBottom: '1px solid #f1f5f9', fontSize: 13 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 500 }}>{fmt(h.date_from)}{h.date_to !== h.date_from ? ` – ${fmt(h.date_to)}` : ''}</span>
                  <span style={{ color: '#64748b' }}> · {KINDS.find((k) => k.id === h.kind)?.label}{h.half_day ? ' · half day' : ''}{h.note ? ` · ${h.note}` : ''}</span>
                </div>
                <button onClick={() => setOpen(open === h.id ? null : h.id)} style={BTN.secondary.sm}>{open === h.id ? 'Hide tasks' : 'Handover…'}</button>
                {h.staff_id === profile?.id && <button onClick={() => askCover(h)} disabled={busy} style={BTN.secondary.sm}>Ask who’s covering…</button>}
                <button onClick={() => remove(h)} style={BTN.danger.sm}>Remove</button>
              </div>
              {open === h.id && <HandoverPanel holiday={h} staffList={staffList} staffMap={staffMap} profile={profile} onSent={onChanged} />}
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
                  <span style={{ color: '#64748b' }}> · {fmt(h.date_from)}{h.date_to !== h.date_from ? ` – ${fmt(h.date_to)}` : ''}</span>
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
