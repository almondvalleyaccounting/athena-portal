import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle2, ClipboardList, Copy, Download, Plus, X,
  ChevronDown, ChevronRight, MessageSquare, AlertTriangle, Send, CalendarDays, RotateCcw,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../shell/AppShell';
import { commitAllocationDraft } from '../modules/work-planner/lib/allocationsQueries';

const font = "'Outfit', sans-serif";
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 };

/*
  Sophie's workspace — everything from her world on one page:
  - Tasks to key into BrightManager (auto-captured + manual), each with an
    optional deadline, a notes/responses thread, and one-click escalation
    (emails whoever needs to action it).
  - Reallocation proposals from the capacity planner (allocation_changes).
  - A live summary of in-flight onboardings.
  Sections collapse; tasks sort by deadline so the most urgent surface first.

  Completing a task moves it off the open list onto the Completed tab, where
  BM verification shows silently (awaiting check → confirmed) and a task can
  be reopened. Reopening sets reopened_at, which holds off BM auto-confirm
  until the task is completed again — otherwise a reopened task whose value
  BM already holds would vanish straight back to Completed on the next load.
*/

const FIELD_LABELS = { ch_auth_code: 'CH auth code', utr: 'UTR', vat_number: 'VAT number', paye_ref: 'PAYE ref' };

function isoToday() { return new Date().toISOString().slice(0, 10); }
function fmtShort(iso) {
  if (!iso) return '';
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : ''));
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
function fmtNoteTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export default function AdminTasksPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [tasks, setTasks] = useState(null);
  const [completed, setCompleted] = useState(null);
  const [view, setView] = useState('open');
  const [notesByTask, setNotesByTask] = useState({});
  const [drafts, setDrafts] = useState([]);
  const [onboardings, setOnboardings] = useState([]);
  const [entities, setEntities] = useState({});
  const [staffMap, setStaffMap] = useState({});
  const [staffList, setStaffList] = useState([]);
  const [confirmedNow, setConfirmedNow] = useState(0);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [copied, setCopied] = useState(null);

  const [openNotes, setOpenNotes] = useState(() => new Set());
  const [escalateTask, setEscalateTask] = useState(null);
  const [collapsed, setCollapsed] = useState({ bm: false, realloc: false, onboard: false });

  const load = useCallback(async () => {
    try {
      const { data: confirmed } = await supabase.rpc('admin_tasks_confirm_from_bm');
      if (confirmed > 0) setConfirmedNow(confirmed);

      const [{ data: t, error: e1 }, { data: ct }, { data: d }, { data: st }, { data: obs }] = await Promise.all([
        supabase.from('admin_tasks')
          .select('*, entity:entities(id, name)')
          .is('done_at', null).is('confirmed_at', null).is('dismissed_at', null)
          .order('created_at', { ascending: false }),
        supabase.from('admin_tasks')
          .select('*, entity:entities(id, name)')
          .is('dismissed_at', null)
          .or('done_at.not.is.null,confirmed_at.not.is.null')
          .order('done_at', { ascending: false, nullsFirst: false })
          .limit(150),
        supabase.from('allocation_changes').select('*').eq('status', 'draft'),
        supabase.from('staff_profiles').select('id, name, email, is_active'),
        supabase.from('onboardings')
          .select('id, status, target_date, entity:entities(name), owner_id')
          .in('status', ['active', 'issues']),
      ]);
      if (e1) throw e1;
      setTasks(t || []);
      setCompleted(ct || []);
      setDrafts(d || []);
      const st2 = (st || []);
      setStaffMap(Object.fromEntries(st2.map((s) => [s.id, s.name])));
      setStaffList(st2.filter((s) => s.is_active !== false && s.email).sort((a, b) => (a.name || '').localeCompare(b.name || '')));

      // Notes for the open tasks
      const taskIds = (t || []).map((x) => x.id);
      if (taskIds.length) {
        const { data: notes } = await supabase.from('admin_task_notes')
          .select('*').in('task_id', taskIds).order('created_at', { ascending: true });
        const grouped = {};
        for (const n of notes || []) (grouped[n.task_id] ||= []).push(n);
        setNotesByTask(grouped);
      } else {
        setNotesByTask({});
      }

      // Entity names for reallocation drafts
      const entIds = [...new Set((d || []).map((x) => x.entity_id).filter(Boolean))];
      if (entIds.length) {
        const { data: ents } = await supabase.from('entities').select('id, name').in('id', entIds);
        setEntities(Object.fromEntries((ents || []).map((e) => [e.id, e.name])));
      }

      // Onboarding progress from steps
      const obIds = (obs || []).map((o) => o.id);
      let stepRows = [];
      if (obIds.length) {
        const { data: steps } = await supabase.from('onboarding_steps')
          .select('onboarding_id, name, completed_at, group_sort, sort')
          .in('onboarding_id', obIds);
        stepRows = steps || [];
      }
      const byOb = {};
      for (const s of stepRows) (byOb[s.onboarding_id] ||= []).push(s);
      const enriched = (obs || []).map((o) => {
        const steps = (byOb[o.id] || []).slice().sort((a, b) => (a.group_sort - b.group_sort) || (a.sort - b.sort));
        const done = steps.filter((s) => s.completed_at).length;
        const next = steps.find((s) => !s.completed_at);
        return { ...o, total: steps.length, done, nextStep: next?.name || null };
      }).sort((a, b) => (a.status === 'issues' ? -1 : 1) - (b.status === 'issues' ? -1 : 1)
        || (a.target_date || '9999').localeCompare(b.target_date || '9999'));
      setOnboardings(enriched);
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function complete(task) {
    const now = new Date().toISOString();
    // Field-less tasks have nothing BM can verify, so they confirm immediately.
    const patch = { done_at: now, ...(task.field ? {} : { confirmed_at: now }) };
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    setCompleted((prev) => [{ ...task, ...patch }, ...(prev || [])]);
    const { error: err } = await supabase.from('admin_tasks').update(patch).eq('id', task.id);
    if (err) { setError(err.message); load(); }
  }

  async function reopen(task) {
    const patch = { done_at: null, confirmed_at: null, reopened_at: new Date().toISOString() };
    setCompleted((prev) => (prev || []).filter((t) => t.id !== task.id));
    setTasks((prev) => [{ ...task, ...patch }, ...(prev || [])]);
    const { error: err } = await supabase.from('admin_tasks').update(patch).eq('id', task.id);
    if (err) { setError(err.message); load(); }
  }

  async function dismiss(task) {
    if (!window.confirm(`Remove "${task.title}" from the list?`)) return;
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    const { error: err } = await supabase.from('admin_tasks')
      .update({ dismissed_at: new Date().toISOString() }).eq('id', task.id);
    if (err) { setError(err.message); load(); }
  }

  async function setDeadline(task, date) {
    const val = date || null;
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, deadline: val } : t)));
    const { error: err } = await supabase.from('admin_tasks').update({ deadline: val }).eq('id', task.id);
    if (err) { setError(err.message); load(); }
  }

  async function completeRealloc(draft) {
    setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
    try {
      await commitAllocationDraft(draft.id, profile?.id);
    } catch (e) {
      setError(e.message);
      load();
    }
  }

  async function addManual() {
    if (!newTitle.trim()) return;
    const { error: err } = await supabase.from('admin_tasks').insert({
      kind: 'manual', title: newTitle.trim(), source: 'Added manually', created_by: profile?.id || null,
    });
    if (err) { setError(err.message); return; }
    setNewTitle(''); setAdding(false); setView('open'); load();
  }

  async function addNote(taskId, body) {
    const text = (body || '').trim();
    if (!text) return;
    const { data, error: err } = await supabase.from('admin_task_notes')
      .insert({ task_id: taskId, author_id: profile?.id || null, kind: 'note', body: text })
      .select('*').single();
    if (err) { setError(err.message); return; }
    setNotesByTask((prev) => ({ ...prev, [taskId]: [...(prev[taskId] || []), data] }));
  }

  async function submitEscalation(task, toStaffId, note) {
    const { data, error: err } = await supabase.functions.invoke('admin-task-escalate', {
      body: { task_id: task.id, to_staff_id: toStaffId, note },
    });
    if (err || !data?.success) { setError((err?.message) || data?.error || 'Escalation failed'); return false; }
    // Bell notification alongside the email the edge function sends.
    supabase.rpc('notify_staff', {
      p_recipient: toStaffId, p_kind: 'admin_task_escalated',
      p_title: `Admin task escalated to you: ${task.title}`, p_link: '/admin/tasks',
    }).then(({ error: nErr }) => { if (nErr) console.error('[AdminTasks] notify', nErr); });
    setTasks((prev) => prev.map((t) => (t.id === task.id
      ? { ...t, escalated_to: toStaffId, escalated_at: new Date().toISOString(), escalation_note: note || null } : t)));
    // Pull the escalation note the function wrote onto the thread.
    const { data: notes } = await supabase.from('admin_task_notes')
      .select('*').eq('task_id', task.id).order('created_at', { ascending: true });
    setNotesByTask((prev) => ({ ...prev, [task.id]: notes || [] }));
    setOpenNotes((prev) => new Set(prev).add(task.id));
    return true;
  }

  function copyValue(task) {
    navigator.clipboard?.writeText(task.value || '');
    setCopied(task.id);
    setTimeout(() => setCopied(null), 1500);
  }

  function toggleNotes(taskId) {
    setOpenNotes((prev) => {
      const n = new Set(prev);
      n.has(taskId) ? n.delete(taskId) : n.add(taskId);
      return n;
    });
  }

  function exportCsv() {
    const rows = (open).map((t) => ({
      Client: t.entity?.name || '', Task: t.title, Field: FIELD_LABELS[t.field] || t.field || '',
      Value: t.value || '', Deadline: t.deadline || '', Source: t.source || '',
      Added: new Date(t.created_at).toLocaleDateString('en-GB'),
      Escalated: t.escalated_to ? (staffMap[t.escalated_to] || 'yes') : '',
      Status: 'open',
    }));
    const headers = ['Client', 'Task', 'Field', 'Value', 'Deadline', 'Source', 'Added', 'Escalated', 'Status'];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url; a.download = `admin-tasks-${isoToday()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  const open = useMemo(() => {
    const list = (tasks || []).filter((t) => !t.done_at && !t.confirmed_at);
    return list.sort((a, b) => {
      const ad = a.deadline || '9999-12-31', bd = b.deadline || '9999-12-31';
      if (ad !== bd) return ad < bd ? -1 : 1;
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
  }, [tasks]);

  const stats = useMemo(() => {
    const today = isoToday();
    return {
      open: open.length,
      overdue: open.filter((t) => t.deadline && t.deadline < today).length,
      escalated: open.filter((t) => t.escalated_to).length,
      realloc: drafts.length,
      onboarding: onboardings.length,
    };
  }, [open, drafts, onboardings]);

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto', padding: '28px 32px 48px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <ClipboardList size={20} color="#0e7fe0" />
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>Admin task list</h1>

        {/* Stat chips share the header row — width is better spent here than stacked below */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginLeft: 20 }}>
          <Chip label="To key in" value={stats.open} />
          <Chip label="Overdue" value={stats.overdue} tone={stats.overdue ? 'red' : 'muted'} />
          <Chip label="Escalated" value={stats.escalated} tone={stats.escalated ? 'amber' : 'muted'} />
          <Chip label="Reallocations" value={stats.realloc} tone={stats.realloc ? 'blue' : 'muted'} />
          <Chip label="Onboarding" value={stats.onboarding} tone={stats.onboarding ? 'blue' : 'muted'} />
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexShrink: 0 }}>
          <button onClick={exportCsv} disabled={!open.length} style={btn('ghost')}><Download size={13} /> Export CSV</button>
          <button onClick={() => setAdding((v) => !v)} style={btn('primary')}><Plus size={13} /> Add task</button>
        </div>
      </div>

      {confirmedNow > 0 && (
        <div style={{ ...card, borderColor: '#bbf7d0', background: '#f0fdf4', padding: '10px 16px', marginBottom: 16, fontSize: 13, color: '#166534' }}>
          ✓ {confirmedNow} task{confirmedNow === 1 ? '' : 's'} confirmed complete by the latest BrightManager data and moved to Completed.
        </div>
      )}
      {error && <div style={{ fontSize: 13, color: '#b91c1c', marginBottom: 12 }}>{error}</div>}

      {adding && (
        <div style={{ ...card, padding: '12px 16px', marginBottom: 16, display: 'flex', gap: 8 }}>
          <input
            autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addManual(); if (e.key === 'Escape') setAdding(false); }}
            placeholder="e.g. Update year-end date on BM for Smith Ltd"
            style={{ flex: 1, padding: '8px 12px', fontSize: 13, border: '1px solid #cbd5e1', borderRadius: 8, fontFamily: font, outline: 'none' }}
          />
          <button onClick={addManual} disabled={!newTitle.trim()} style={btn('primary')}>Add</button>
        </div>
      )}

      {/* ── To key into BrightManager ── */}
      <Section
        title="To key into BrightManager" count={view === 'open' ? open.length : (completed || []).length}
        collapsed={collapsed.bm} onToggle={() => setCollapsed((c) => ({ ...c, bm: !c.bm }))}
        action={
          <div style={{ display: 'flex', gap: 4 }}>
            <TabBtn active={view === 'open'} onClick={() => setView('open')}>Open ({open.length})</TabBtn>
            <TabBtn active={view === 'completed'} onClick={() => setView('completed')}>Completed ({(completed || []).length})</TabBtn>
          </div>
        }
      >
        {view === 'open' && <>
          {tasks === null && <Empty>Loading…</Empty>}
          {tasks !== null && open.length === 0 && <Empty>Nothing outstanding — Athena and BrightManager are in step. 🎉</Empty>}
          {open.map((t) => (
            <TaskRow
              key={t.id} t={t}
              notes={notesByTask[t.id] || []} notesOpen={openNotes.has(t.id)}
              staffMap={staffMap} copied={copied === t.id}
              onComplete={() => complete(t)}
              onCopy={() => copyValue(t)}
              onDismiss={() => dismiss(t)}
              onDeadline={(d) => setDeadline(t, d)}
              onToggleNotes={() => toggleNotes(t.id)}
              onAddNote={(body) => addNote(t.id, body)}
              onEscalate={() => setEscalateTask(t)}
              onOpenClient={t.entity?.id ? () => navigate(`/clients/${t.entity.id}`) : null}
            />
          ))}
        </>}
        {view === 'completed' && <>
          {completed === null && <Empty>Loading…</Empty>}
          {completed !== null && completed.length === 0 && <Empty>Nothing completed yet.</Empty>}
          {(completed || []).map((t) => (
            <CompletedRow
              key={t.id} t={t}
              onReopen={() => reopen(t)}
              onOpenClient={t.entity?.id ? () => navigate(`/clients/${t.entity.id}`) : null}
            />
          ))}
        </>}
      </Section>

      {/* ── Reallocations (from capacity planner) ── */}
      <Section
        title="Task reallocations to apply in BM" count={drafts.length}
        collapsed={collapsed.realloc} onToggle={() => setCollapsed((c) => ({ ...c, realloc: !c.realloc }))}
        action={<button onClick={() => navigate('/planner/allocations')} style={btn('ghost')}>Open capacity planner →</button>}
      >
        {drafts.length === 0 && <Empty>No reallocation proposals waiting.</Empty>}
        {drafts.map((d) => (
          <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', borderTop: '1px solid #f8fafc', fontSize: 13 }}>
            <span style={{ fontWeight: 600, color: '#0f172a' }}>{entities[d.entity_id] || 'Client'}</span>
            <span style={{ color: '#64748b', flex: 1 }}>{String(d.canonical_service_id || '').replace(/_/g, ' ')}</span>
            <span style={{ color: '#475569', whiteSpace: 'nowrap' }}>→ {staffMap[d.proposed_fee_earner_id] || 'unassigned'}</span>
            <button onClick={() => completeRealloc(d)} title="Mark applied in BM" style={completeBtn(false)}>
              <CheckCircle2 size={13} /> Complete
            </button>
          </div>
        ))}
        {drafts.length > 0 && (
          <div style={{ padding: '8px 16px', borderTop: '1px solid #f1f5f9', fontSize: 11.5, color: '#94a3b8' }}>
            Marking one complete assumes you've made the change in BM. The next BM upload checks it — if the assignee still doesn't match, it reappears here.
          </div>
        )}
      </Section>

      {/* ── Onboarding summary ── */}
      <Section
        title="Onboarding in flight" count={onboardings.length}
        collapsed={collapsed.onboard} onToggle={() => setCollapsed((c) => ({ ...c, onboard: !c.onboard }))}
        action={<button onClick={() => navigate('/onboarding')} style={btn('ghost')}>Open onboarding →</button>}
      >
        {onboardings.length === 0 && <Empty>No onboardings in progress.</Empty>}
        {onboardings.map((o) => {
          const pct = o.total ? Math.round((o.done / o.total) * 100) : 0;
          return (
            <div key={o.id} onClick={() => navigate(`/onboarding/${o.id}`)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 16px', borderTop: '1px solid #f8fafc', fontSize: 13, cursor: 'pointer' }}>
              <span style={{ fontWeight: 600, color: '#0f172a', flex: '0 0 190px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {o.entity?.name || 'Client'}
              </span>
              {o.status === 'issues'
                ? <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 999, background: '#fee2e2', color: '#b91c1c', fontWeight: 600 }}>Issues</span>
                : <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 999, background: '#e0f2fe', color: '#0369a1' }}>Active</span>}
              <div style={{ flex: 1, minWidth: 0, color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {o.nextStep ? <>Next: {o.nextStep}</> : 'All steps done'}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
                <div style={{ width: 70, height: 6, background: '#f1f5f9', borderRadius: 999, overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? '#16a34a' : '#0e7fe0' }} />
                </div>
                <span style={{ color: '#94a3b8', fontVariantNumeric: 'tabular-nums', width: 42, textAlign: 'right' }}>{o.done}/{o.total}</span>
              </div>
            </div>
          );
        })}
      </Section>

      {escalateTask && (
        <EscalateModal
          task={escalateTask}
          staffList={staffList}
          onClose={() => setEscalateTask(null)}
          onSend={submitEscalation}
        />
      )}
    </div>
  );
}

function TaskRow({
  t, notes, notesOpen, staffMap, copied,
  onComplete, onCopy, onDismiss, onDeadline, onToggleNotes, onAddNote, onEscalate, onOpenClient,
}) {
  const [noteDraft, setNoteDraft] = useState('');
  const today = isoToday();
  const overdue = t.deadline && t.deadline < today;

  return (
    <div style={{ borderTop: '1px solid #f8fafc' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            onClick={onOpenClient || undefined}
            style={{
              fontSize: 13.5, fontWeight: 600, color: '#0f172a', cursor: onOpenClient ? 'pointer' : 'default',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
            title={t.title}
          >{t.title}</span>
          {t.escalated_to && (
            <span style={{ fontSize: 10.5, padding: '1px 6px', borderRadius: 999, background: '#fef3c7', color: '#b45309', fontWeight: 600, whiteSpace: 'nowrap' }}>
              → {staffMap[t.escalated_to] || 'escalated'}
            </span>
          )}
        </div>

        {/* Deadline */}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }} title="Set a deadline">
          <CalendarDays size={13} color={overdue ? '#dc2626' : '#94a3b8'} />
          <input
            type="date" value={t.deadline || ''} onChange={(e) => onDeadline(e.target.value)}
            style={{
              fontSize: 11.5, fontFamily: font, padding: '3px 6px', borderRadius: 6,
              border: `1px solid ${overdue ? '#fca5a5' : '#e2e8f0'}`, color: overdue ? '#dc2626' : '#475569',
              background: overdue ? '#fef2f2' : '#fff', outline: 'none',
            }}
          />
        </label>

        {t.value && (
          <button onClick={onCopy} title="Copy the value to paste into BM" style={{ ...btn('ghost'), fontFamily: 'monospace', fontSize: 12, flexShrink: 0 }}>
            {copied ? '✓ copied' : <>{t.value} <Copy size={11} /></>}
          </button>
        )}

        <button onClick={onToggleNotes} title="Notes & responses"
          style={{ ...iconBtn, color: notes.length ? '#0e7fe0' : '#94a3b8', borderColor: notes.length ? '#bae6fd' : '#e5e7eb' }}>
          <MessageSquare size={13} />{notes.length > 0 && <span style={{ fontSize: 11, fontWeight: 700 }}>{notes.length}</span>}
        </button>

        <button onClick={onEscalate} title="Escalate — ask someone to action this" style={{ ...iconBtn, color: '#b45309', borderColor: '#fde68a' }}>
          <AlertTriangle size={13} />
        </button>

        <button
          onClick={onComplete}
          title="Mark as entered into BrightManager — moves to the Completed tab"
          style={completeBtn(false)}
        >
          <CheckCircle2 size={13} /> Complete
        </button>

        <button onClick={onDismiss} title="Remove without completing" style={{ background: 'none', border: 'none', color: '#cbd5e1', cursor: 'pointer', padding: 2, display: 'flex', flexShrink: 0 }}>
          <X size={14} />
        </button>
      </div>

      {notesOpen && (
        <div style={{ padding: '4px 16px 12px 46px', background: '#fafbfc' }}>
          {notes.length === 0 && <div style={{ fontSize: 12, color: '#94a3b8', padding: '4px 0' }}>No notes yet.</div>}
          {notes.map((n) => (
            <div key={n.id} style={{ fontSize: 12.5, color: '#334155', padding: '4px 0', display: 'flex', gap: 8 }}>
              <span style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 4, flexShrink: 0, height: 16, alignSelf: 'flex-start', marginTop: 1,
                background: n.kind === 'escalation' ? '#fef3c7' : '#eef2ff', color: n.kind === 'escalation' ? '#b45309' : '#4338ca',
              }}>{n.kind === 'escalation' ? 'escalation' : 'note'}</span>
              <div>
                <span>{n.body}</span>
                <span style={{ color: '#94a3b8', marginLeft: 6, fontSize: 11 }}>
                  — {staffMap[n.author_id] || 'staff'} · {fmtNoteTime(n.created_at)}
                </span>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <input
              value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && noteDraft.trim()) { onAddNote(noteDraft); setNoteDraft(''); } }}
              placeholder="Add a note or response…"
              style={{ flex: 1, fontSize: 12.5, fontFamily: font, padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: 8, outline: 'none' }}
            />
            <button onClick={() => { if (noteDraft.trim()) { onAddNote(noteDraft); setNoteDraft(''); } }}
              disabled={!noteDraft.trim()} style={{ ...btn('primary'), padding: '6px 12px' }}><Send size={12} /></button>
          </div>
        </div>
      )}
    </div>
  );
}

function CompletedRow({ t, onReopen, onOpenClient }) {
  // Verification status: BM checks tasks with a field silently on each import;
  // field-less tasks confirm the moment they're completed.
  const badge = !t.field
    ? { text: 'Done', bg: '#dcfce7', fg: '#166534', hint: 'Completed — nothing for BrightManager to verify.' }
    : t.confirmed_at
      ? { text: '✓ Confirmed in BM', bg: '#dcfce7', fg: '#166534', hint: 'The BrightManager data now holds this value.' }
      : { text: 'Awaiting BM check', bg: '#fef3c7', fg: '#b45309', hint: 'The next BrightManager upload verifies this silently.' };
  const when = t.confirmed_at || t.done_at;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', borderTop: '1px solid #f8fafc' }}>
      <CheckCircle2 size={14} color="#16a34a" style={{ flexShrink: 0 }} />
      <span
        onClick={onOpenClient || undefined} title={t.title}
        style={{
          flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: '#334155',
          cursor: onOpenClient ? 'pointer' : 'default', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}
      >{t.title}</span>
      {t.value && <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#94a3b8', flexShrink: 0 }}>{t.value}</span>}
      <span title={badge.hint} style={{
        fontSize: 10.5, padding: '2px 8px', borderRadius: 999, background: badge.bg, color: badge.fg,
        fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0, cursor: 'default',
      }}>{badge.text}</span>
      <span style={{ fontSize: 11.5, color: '#94a3b8', whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtShort(when)}</span>
      <button onClick={onReopen} title="Move back to open tasks" style={{ ...btn('ghost'), padding: '5px 10px', fontSize: 12 }}>
        <RotateCcw size={12} /> Reopen
      </button>
    </div>
  );
}

function TabBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 11px', fontSize: 11.5, fontWeight: 600, fontFamily: font, borderRadius: 999, cursor: 'pointer',
      background: active ? '#0f172a' : '#fff', color: active ? '#fff' : '#64748b',
      border: `1px solid ${active ? '#0f172a' : '#e5e7eb'}`, whiteSpace: 'nowrap',
    }}>{children}</button>
  );
}

function EscalateModal({ task, staffList, onClose, onSend }) {
  const [toId, setToId] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);

  async function send() {
    if (!toId) return;
    setSending(true);
    const ok = await onSend(task, toId, note.trim());
    setSending(false);
    if (ok) onClose();
  }

  return (
    <div onClick={onClose} style={modalBackdrop}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modalCard, width: 440 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangle size={16} color="#b45309" /> Escalate task
        </div>
        <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 14 }}>{task.title}</div>

        <label style={fieldLabel}>Who needs to action this?</label>
        <select value={toId} onChange={(e) => setToId(e.target.value)} style={selectInput}>
          <option value="">— Select a person —</option>
          {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        <label style={{ ...fieldLabel, marginTop: 12 }}>Note (what needs doing)</label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
          placeholder="Give them the context they need to act."
          style={{ ...selectInput, resize: 'vertical' }} />

        <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 8 }}>
          Sends them an email with the task and your note, and logs it on the task thread.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onClose} style={btn('ghost')}>Cancel</button>
          <button onClick={send} disabled={!toId || sending} style={{ ...btn('primary'), opacity: (!toId || sending) ? 0.6 : 1 }}>
            <Send size={13} /> {sending ? 'Sending…' : 'Send & escalate'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, count, collapsed, onToggle, action, children }) {
  return (
    <div style={{ ...card, overflow: 'hidden', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 16px', borderBottom: collapsed ? 'none' : '1px solid #f1f5f9' }}>
        <button onClick={onToggle} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginRight: 8, color: '#64748b', display: 'flex' }}>
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </button>
        <span onClick={onToggle} style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5, flex: 1, cursor: 'pointer' }}>
          {title} ({count})
        </span>
        {action}
      </div>
      {!collapsed && children}
    </div>
  );
}

function Chip({ label, value, tone = 'default' }) {
  const tones = {
    default: { bg: '#f1f5f9', fg: '#0f172a' },
    muted: { bg: '#f8fafc', fg: '#94a3b8' },
    red: { bg: '#fee2e2', fg: '#b91c1c' },
    amber: { bg: '#fef3c7', fg: '#b45309' },
    blue: { bg: '#e0f2fe', fg: '#0369a1' },
  };
  const c = tones[tone] || tones.default;
  return (
    <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, padding: '5px 12px', borderRadius: 999, background: c.bg }}>
      <span style={{ fontSize: 15, fontWeight: 700, color: c.fg, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      <span style={{ fontSize: 11.5, color: c.fg, opacity: 0.85 }}>{label}</span>
    </div>
  );
}

function Empty({ children }) {
  return <div style={{ padding: '18px 16px', fontSize: 13, color: '#94a3b8', textAlign: 'center' }}>{children}</div>;
}

function btn(kind) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', fontSize: 12.5, fontWeight: 600,
    fontFamily: font, borderRadius: 8, cursor: 'pointer',
    background: kind === 'primary' ? '#0f172a' : '#fff',
    color: kind === 'primary' ? '#fff' : '#475569',
    border: kind === 'primary' ? 'none' : '1px solid #e5e7eb',
  };
}
const iconBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 3, padding: '4px 7px', fontFamily: font,
  borderRadius: 7, cursor: 'pointer', background: '#fff', border: '1px solid #e5e7eb', flexShrink: 0,
};
function completeBtn(active) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', fontSize: 12, fontWeight: 600,
    fontFamily: font, borderRadius: 7, cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap',
    background: active ? '#dcfce7' : '#fff', color: active ? '#166534' : '#475569',
    border: `1px solid ${active ? '#bbf7d0' : '#e5e7eb'}`,
  };
}
const modalBackdrop = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};
const modalCard = { background: '#fff', borderRadius: 12, padding: '20px 22px', fontFamily: font, boxShadow: '0 20px 60px rgba(15,23,42,0.25)' };
const fieldLabel = { display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 4 };
const selectInput = {
  width: '100%', padding: '8px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1',
  borderRadius: 8, background: '#fff', color: '#0f172a', boxSizing: 'border-box', outline: 'none',
};
