import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { callJobPlan } from '../plan/planQueries';
import { rescheduleTask } from '../setup/queries';
import { kindOf, cadenceLabel } from '../lib/blocksApi';
import { formatISO } from '../lib/helpers';
import { MinutesModal, shortTask } from './PlannerBits';
import EmailModal from './EmailModal';
import { BTN } from '../../../lib/buttonStyles';

// One task modal for every kind of task (Bobby, 2026-09-26): a plan stage,
// a BrightManager job, a quick task or a block occurrence. Details that
// matter for that kind, the actions, and a comment thread (sql/315). A
// comment notifies everyone else on the thread by email.

const font = "'Outfit', sans-serif";
const fmt = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fmtTs = (ts) => new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const TYPE_LABEL = { ms: 'Plan stage', bm: 'BrightManager job', quick: 'Quick task', block: 'Block' };
const RISK = { urgent: 'Urgent', at_risk: 'At risk', waiting_on_client: 'Waiting on client', slipped: 'Slipped' };

function Field({ label, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 13.5, color: '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{children ?? '—'}</div>
    </div>
  );
}

export default function TaskModal({ task, staffMap, staffList, entityMap, profile, quickTasks = [], scheduledTasks = [], blockItemsMap = {}, onClose, onChanged, onEditQuick, onQuickDone, onQuickNotRequired, onCompleteBlock, onEditBlock }) {
  const navigate = useNavigate();
  const [detail, setDetail] = useState(null);
  const [comments, setComments] = useState([]);
  const [legacyNotes, setLegacyNotes] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ask, setAsk] = useState(null);
  const [email, setEmail] = useState(false);
  const { type, id, occurrence_date: occ } = task;

  const load = useCallback(async () => {
    setError(null);
    try {
      if (type === 'ms') {
        const { data, error: e } = await supabase.from('job_milestones').select('*, job_plans(id, entity_id, period_end, status, risk, risk_reason, ch_deadline, entities(name))').eq('id', id).maybeSingle();
        if (e) throw e; setDetail(data);
      } else if (type === 'bm') {
        const { data, error: e } = await supabase.from('bm_task_schedule_with_progress').select('id, bm_task_id, bm_task_name, service, entity_id, assignee_id, bm_assignee_name, scheduled_for_date, scheduled_hours, logged_hours, remaining_hours, state, status, bm_deadline, bm_target_date, bm_status, bm_latest_action_date, manually_overridden_at').eq('id', id).maybeSingle();
        if (e) throw e; setDetail(data);
      } else if (type === 'quick') {
        const local = quickTasks.find((q) => q.id === id);
        if (local) setDetail(local);
        else { const { data } = await supabase.from('quick_tasks').select('*').eq('id', id).maybeSingle(); setDetail(data); }
      } else {
        const local = scheduledTasks.find((m) => m.id === id);
        if (local) setDetail(local);
        else { const { data } = await supabase.from('scheduled_tasks').select('*').eq('id', id).maybeSingle(); setDetail(data); }
      }
      const [{ data: cs }, notes] = await Promise.all([
        supabase.from('task_comments').select('*').eq('task_type', type).eq('task_id', id).order('created_at').limit(500),
        type === 'quick' || type === 'block'
          ? supabase.from('task_progress_notes').select('*').eq('task_type', type === 'quick' ? 'quick' : 'scheduled').eq('task_id', id).order('created_at').limit(200).then((r) => r.data || [])
          : Promise.resolve([]),
      ]);
      setComments(cs || []);
      setLegacyNotes(notes || []);
    } catch (e) { setError(e.message || String(e)); }
  }, [type, id, quickTasks, scheduledTasks]);
  useEffect(() => { load(); }, [load]);

  const entityId = detail?.job_plans?.entity_id || detail?.entity_id || null;
  const entityName = detail?.job_plans?.entities?.name || (entityId ? entityMap?.[entityId]?.name : null) || null;
  const label = type === 'ms' ? detail?.label : type === 'bm' ? shortTask(detail?.bm_task_name) : detail?.title;
  const changed = async () => { await load(); onChanged && onChanged(); };
  const act = async (payload) => { await callJobPlan(payload); await changed(); };
  const todayISO = formatISO(new Date());

  const post = async () => {
    const body = text.trim();
    if (!body) return;
    setBusy(true); setError(null);
    try {
      const res = await callJobPlan({ action: 'add_comment', task: { type, id, occurrence_date: occ || null }, body, entity_id: entityId, task_label: label });
      setText('');
      await load();
      if (res.notified) setError(null);
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const thread = useMemo(() => {
    const a = comments.map((c) => ({ id: c.id, at: c.created_at, who: staffMap?.[c.author_id]?.name || 'Someone', body: c.body, kind: c.kind, to: c.to_staff_id ? staffMap?.[c.to_staff_id]?.name : c.to_email }));
    const b = legacyNotes.map((n) => ({ id: `n${n.id}`, at: n.created_at, who: n.created_by_name || 'Someone', body: n.note, kind: n.is_completion ? 'completion' : 'note' }));
    return [...a, ...b].sort((x, y) => new Date(x.at) - new Date(y.at));
  }, [comments, legacyNotes, staffMap]);

  // ── Per-type details and actions ──
  let details = null, actions = null;
  if (detail && type === 'ms') {
    const p = detail.job_plans;
    const pending = detail.status === 'pending';
    details = (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        <Field label="Client">{entityName}</Field>
        <Field label="Year end">{fmt(p?.period_end)}</Field>
        <Field label="Due">{fmt(detail.due_date)}</Field>
        <Field label="Owner">{staffMap?.[detail.owner_id]?.name || detail.owner_role}</Field>
        <Field label="Status">{detail.status}{detail.pinned_by ? ' · pinned' : ''}</Field>
        <Field label="Hours">{detail.hours ? `${Number(detail.hours)}h` : '—'}</Field>
        <Field label="Job risk">{RISK[p?.risk] || 'On track'}{p?.risk_reason ? ` · ${p.risk_reason}` : ''}</Field>
        <Field label="Client email">{detail.comms_sent_at ? `sent ${fmt(detail.comms_sent_at)} to ${detail.comms_to}` : 'not sent'}</Field>
        <Field label="CH deadline">{fmt(p?.ch_deadline)}</Field>
        {detail.note && <div style={{ gridColumn: '1 / -1', fontSize: 12.5, color: '#475569', whiteSpace: 'pre-wrap' }}>{detail.note}</div>}
      </div>
    );
    actions = (
      <>
        <button onClick={() => navigate(`/planner/plan/${p.entity_id}/${p.period_end}`)} style={BTN.secondary.sm}>Open the plan</button>
        {pending && <button onClick={() => setAsk({ title: detail.label, subtitle: entityName, defaultMins: detail.hours ? Math.round(Number(detail.hours) * 60) : null, run: (m) => act({ action: 'mark_done', milestone_id: id, minutes: m }) })} style={BTN.primary.sm}>Done…</button>}
        {pending && <button onClick={() => { if (window.confirm(`Skip "${detail.label}" on this job?`)) act({ action: 'skip', milestone_id: id }).catch((e) => setError(e.message)); }} style={BTN.secondary.sm}>Not required</button>}
        {pending && detail.due_date !== todayISO && <button onClick={() => act({ action: 'move_milestone', milestone_id: id, due_date: todayISO }).catch((e) => setError(e.message))} style={BTN.secondary.sm}>Move to today</button>}
        {!pending && <button onClick={() => act({ action: 'reopen', milestone_id: id }).catch((e) => setError(e.message))} style={BTN.secondary.sm}>Reopen</button>}
      </>
    );
  } else if (detail && type === 'bm') {
    details = (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        <Field label="Client">{entityName}</Field>
        <Field label="Task">{detail.bm_task_name}</Field>
        <Field label="Service">{detail.service}</Field>
        <Field label="BM status">{detail.bm_status || '—'}{detail.bm_latest_action_date ? ` · ${fmt(detail.bm_latest_action_date)}` : ''}</Field>
        <Field label="Statutory deadline">{fmt(detail.bm_deadline)}</Field>
        <Field label="BM target">{fmt(detail.bm_target_date)}</Field>
        <Field label="Planned for">{fmt(detail.scheduled_for_date)}{detail.manually_overridden_at ? ' · pinned' : ''}</Field>
        <Field label="Assignee">{staffMap?.[detail.assignee_id]?.name || detail.bm_assignee_name}</Field>
        <Field label="Hours">{Number(detail.logged_hours || 0)}h logged of {Number(detail.scheduled_hours || 0)}h</Field>
      </div>
    );
    actions = (
      <>
        {entityId && <button onClick={() => navigate(`/clients/${entityId}`)} style={BTN.secondary.sm}>Open the client</button>}
        <button onClick={() => setAsk({ title: shortTask(detail.bm_task_name), subtitle: entityName, cta: 'Mark complete', defaultMins: detail.remaining_hours != null ? Math.round(Number(detail.remaining_hours) * 60) : null, note: 'The minutes go to your timesheet. The job then sits on your "Update in BrightManager" list on Overview until the next import confirms it.', run: (m) => act({ action: 'complete_bm_job', schedule_id: id, minutes: m }) })} style={BTN.primary.sm}>Mark complete…</button>
        {detail.scheduled_for_date !== todayISO && <button onClick={async () => { try { await rescheduleTask(id, todayISO); await changed(); } catch (e) { setError(e.message); } }} style={BTN.secondary.sm}>Move to today</button>}
      </>
    );
  } else if (detail && type === 'quick') {
    details = (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        <Field label="Client">{entityName || 'General'}</Field>
        <Field label="Service">{detail.service}</Field>
        <Field label="Assignee">{staffMap?.[detail.assignee_id]?.name}</Field>
        <Field label="Planned for">{detail.planned_date ? fmt(detail.planned_date) : 'unplanned'}</Field>
        <Field label="Due">{detail.due_date ? fmt(detail.due_date) : '—'}</Field>
        <Field label="Duration">{detail.duration ? `${detail.duration} min` : '—'}</Field>
        {detail.notes && <div style={{ gridColumn: '1 / -1', fontSize: 12.5, color: '#475569', whiteSpace: 'pre-wrap' }}>{detail.notes}</div>}
      </div>
    );
    actions = (
      <>
        <button onClick={() => { onClose(); onEditQuick && onEditQuick(detail); }} style={BTN.secondary.sm}>Edit</button>
        <button onClick={() => { onClose(); onQuickDone && onQuickDone(detail); }} style={BTN.primary.sm}>Done…</button>
        <button onClick={() => { onClose(); onQuickNotRequired && onQuickNotRequired(detail); }} style={BTN.secondary.sm}>Not required</button>
      </>
    );
  } else if (detail && type === 'block') {
    const items = blockItemsMap[id] || [];
    details = (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        <Field label="Kind">{kindOf(detail.block_kind).label}</Field>
        <Field label="Client">{entityName || 'Generic'}</Field>
        <Field label="Person">{staffMap?.[detail.assignee_id]?.name}</Field>
        <Field label="This occurrence">{fmt(occ)}</Field>
        <Field label="When">{cadenceLabel(detail)}</Field>
        <Field label="Minutes">{detail.duration} per day</Field>
        <Field label="If not done">{detail.carry_over ? 'Carries over' : 'Explained, not carried'}</Field>
        {items.length > 0 && <div style={{ gridColumn: '1 / -1', fontSize: 12.5, color: '#475569' }}>{items.length} clients: {items.map((it) => entityMap?.[it.entity_id]?.name || it.label).filter(Boolean).join(', ')}</div>}
      </div>
    );
    actions = (
      <>
        <button onClick={() => { onClose(); onEditBlock && onEditBlock(detail); }} style={BTN.secondary.sm}>Edit the block</button>
        {occ && <button onClick={() => { onClose(); onCompleteBlock && onCompleteBlock({ _instance: true, _masterId: id, _date: new Date(`${occ}T12:00:00`), title: detail.title, block_kind: detail.block_kind, carry_over: detail.carry_over, duration: detail.duration }); }} style={BTN.primary.sm}>Complete / log time…</button>}
      </>
    );
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.25)', zIndex: 105, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, width: 720, maxWidth: '96vw', maxHeight: '90vh', overflow: 'auto', padding: 18, fontFamily: font, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3 }}>{TYPE_LABEL[type]}</div>
            <div style={{ fontSize: 17, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label || 'Loading…'}{entityName ? <span style={{ color: '#64748b', fontWeight: 500 }}> · {entityName}</span> : null}</div>
          </div>
          <button onClick={onClose} style={BTN.secondary.sm}>Close</button>
        </div>
        {error && <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13 }}>{error}</div>}
        {!detail && !error && <div style={{ padding: 16, color: '#94a3b8', fontSize: 13 }}>Loading…</div>}
        {detail && (
          <>
            <div style={{ marginTop: 12, padding: 12, border: '1px solid #e5e7eb', borderRadius: 8, background: '#f8fafc' }}>{details}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
              {actions}
              <button onClick={() => setEmail(true)} style={BTN.secondary.sm}>Email…</button>
            </div>

            <div style={{ marginTop: 14, fontSize: 12.5, fontWeight: 700, color: '#475569' }}>Comments <span style={{ fontWeight: 500, color: '#94a3b8' }}>· {thread.length}</span></div>
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, marginTop: 4, maxHeight: 260, overflowY: 'auto' }}>
              {thread.length === 0 && <div style={{ padding: 10, fontSize: 12.5, color: '#cbd5e1' }}>No comments yet.</div>}
              {thread.map((c) => (
                <div key={c.id} style={{ padding: '7px 10px', borderBottom: '1px solid #f1f5f9', fontSize: 13 }}>
                  <div style={{ fontSize: 11.5, color: '#94a3b8', marginBottom: 2 }}>
                    <b style={{ color: '#475569' }}>{c.who.split(' ')[0]}</b> · {fmtTs(c.at)}
                    {c.kind === 'email' && <span style={{ marginLeft: 6, padding: '0 6px', borderRadius: 8, background: '#eff6ff', color: '#0e7fe0', fontWeight: 600 }}>emailed {c.to || ''}</span>}
                    {c.kind === 'completion' && <span style={{ marginLeft: 6, color: '#059669' }}>completion note</span>}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', color: '#1e293b' }}>{c.body}</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'flex-start' }}>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Add a comment — everyone on this thread gets it by email"
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) post(); }}
                style={{ flex: 1, padding: '7px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6, resize: 'vertical' }} />
              <button onClick={post} disabled={busy || !text.trim()} style={BTN.primary.sm}>{busy ? 'Posting…' : 'Post'}</button>
            </div>
          </>
        )}
      </div>
      {ask && <MinutesModal ask={ask} onClose={() => setAsk(null)} />}
      {email && <EmailModal ctx={{ entity_id: entityId, entity_name: entityName, task_label: label, task: { type, id, occurrence_date: occ || null } }} staffList={staffList} profile={profile} onClose={() => setEmail(false)} onSent={load} />}
    </div>
  );
}
