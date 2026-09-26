import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DndContext, DragOverlay, useDraggable, useDroppable, PointerSensor, useSensor, useSensors, pointerWithin } from '@dnd-kit/core';
import { supabase } from '../../../lib/supabase';
import { useWorkPlanner } from '../WorkPlannerModule';
import { callJobPlan } from '../plan/planQueries';
import { listScheduleInRange, rescheduleTask } from '../setup/queries';
import { formatISO, addDays, startOfWeek, today, sameDay } from '../lib/helpers';
import Avatar from '../components/Avatar';
import { BTN } from '../../../lib/buttonStyles';

// Right-click menu. Fixed at the pointer, closes on any click or Escape.
function ContextMenu({ menu, onClose }) {
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
function MinutesModal({ ask, onClose }) {
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

// The week planner (Bobby, 2026-09-25: "let people plan their week, not
// just their day"). People as rows, days as columns. A cell holds that
// person's committed-plan stages due that day, the BrightManager work placed
// on it, and their quick tasks, with hours against the day's capacity.
//
// Drag a stage to another day or person (it pins, so the nightly pass
// leaves it), a BM job to another day (same as Waiting: it stamps
// manually_overridden_at), or a quick task anywhere. Day granularity: the
// fifteen-minute grid is gone.

const font = "'Outfit', sans-serif";
const HOURS_PER_WORKING_DAY = 7.5;
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const KIND_COLOUR = { comms: '#d97706', milestone: '#64748b', work: '#0e7fe0', calendar: '#db2777' };
const RISK_PILL = {
  urgent: { bg: '#fee2e2', fg: '#991b1b', label: 'Urgent' },
  at_risk: { bg: '#ffedd5', fg: '#9a3412', label: 'At risk' },
  waiting_on_client: { bg: '#fef3c7', fg: '#92400e', label: 'Waiting' },
};

function workingSet(wd) {
  const s = new Set((wd || 'mon,tue,wed,thu,fri').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
  return s.size ? s : new Set(['mon', 'tue', 'wed', 'thu', 'fri']);
}
function dayCapacity(person, date) {
  const set = workingSet(person?.working_days);
  if (!set.has(DOW[date.getDay()])) return 0;
  const weekly = person?.weekly_capacity_hours != null ? Number(person.weekly_capacity_hours) : set.size * HOURS_PER_WORKING_DAY;
  return weekly / set.size;
}
function shortTask(name) {
  return String(name || '').replace(/\s*(Year End|Quarterly End|Monthly End|Period End|Tax Year).*$/i, '');
}

function Tile({ id, data, disabled, children, onClick, onContextMenu, style }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, data, disabled });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} onClick={onClick} onContextMenu={onContextMenu}
      style={{ ...style, opacity: isDragging ? 0.3 : 1, cursor: disabled ? 'pointer' : 'grab', touchAction: 'none' }}>
      {children}
    </div>
  );
}
function Cell({ id, children, style }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return <div ref={setNodeRef} style={{ ...style, background: isOver ? '#eff6ff' : style?.background }}>{children}</div>;
}

// onOpen opens a quick task straight into its editor (Done, Not required and
// Delete live there), rather than a click-then-Open popover.
export default function CalendarView({ calendarView, anchor, onOpen, onPickDay, onQuickDone, onQuickNotRequired, onQuickDelete }) {
  const navigate = useNavigate();
  const { staffList, staffMap, entityMap, quickTasks, filters, updateQuickTask, staffColours } = useWorkPlanner();
  const [milestones, setMilestones] = useState([]);
  const [bmRows, setBmRows] = useState([]);
  const [doneInAthena, setDoneInAthena] = useState({}); // bm_task_schedule_id -> completion
  const [menu, setMenu] = useState(null);
  const [ask, setAsk] = useState(null);
  const [dayModal, setDayModal] = useState(null); // ISO date open from the month view
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [active, setActive] = useState(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const now = today();

  // ── Window ──
  const days = useMemo(() => {
    if (calendarView === 'month') {
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const startDay = first.getDay() === 0 ? 6 : first.getDay() - 1;
      return Array.from({ length: 42 }, (_, i) => addDays(first, i - startDay));
    }
    const start = startOfWeek(anchor);
    return Array.from({ length: calendarView === 'week' ? 7 : 5 }, (_, i) => addDays(start, i));
  }, [calendarView, anchor]);
  const fromISO = formatISO(days[0]);
  const toISO = formatISO(days[days.length - 1]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [{ data: ms, error: mErr }, bm, { data: comps }] = await Promise.all([
        supabase.from('job_milestones')
          .select('id, stage_key, label, kind, hours, owner_id, owner_role, due_date, status, pinned_by, comms_sent_at, job_plans!inner(id, entity_id, period_end, status, risk, entities(name))')
          .eq('job_plans.status', 'committed').in('status', ['pending', 'done'])
          .gte('due_date', fromISO).lte('due_date', toISO).order('due_date').limit(3000),
        listScheduleInRange({ startISO: fromISO, endISO: toISO }),
        supabase.from('bm_task_completions').select('id, bm_task_schedule_id, completed_at, minutes').is('confirmed_at', null).limit(1000),
      ]);
      if (mErr) throw mErr;
      setMilestones(ms || []);
      // A job BM already shows as completed has no business on a planning
      // calendar; one marked complete here stays, struck through, until BM
      // agrees.
      setBmRows((bm || []).filter((b) => b.state !== 'completed'));
      const map = {};
      (comps || []).forEach((c) => { if (c.bm_task_schedule_id) map[c.bm_task_schedule_id] = c; });
      setDoneInAthena(map);
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, [fromISO, toISO]);
  useEffect(() => { load(); }, [load]);

  // ── People (rows) ──
  const people = useMemo(() => {
    const active = staffList.filter((s) => s.work_planner !== false);
    const list = filters.teamFilter ? active.filter((s) => s.id === filters.teamFilter) : active;
    return [...list].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [staffList, filters.teamFilter]);

  // ── Items by person and day ──
  const items = useMemo(() => {
    const out = new Map(); // `${personId}|${iso}` -> { ms: [], bm: [], quick: [], hours }
    const put = (pid, iso, kind, item, hours) => {
      const key = `${pid || 'unassigned'}|${iso}`;
      if (!out.has(key)) out.set(key, { ms: [], bm: [], quick: [], hours: 0 });
      const c = out.get(key);
      c[kind].push(item);
      c.hours += Number(hours) || 0;
    };
    for (const m of milestones) {
      if (filters.clientFilter && m.job_plans.entity_id !== filters.clientFilter) continue;
      put(m.owner_id, m.due_date, 'ms', m, m.status === 'pending' ? m.hours : 0);
    }
    for (const b of bmRows) {
      if (filters.clientFilter && b.entity_id !== filters.clientFilter) continue;
      if (filters.serviceFilter && b.service !== filters.serviceFilter) continue;
      put(b.assignee_id, b.scheduled_for_date, 'bm', b, doneInAthena[b.id] ? 0 : (b.remaining_hours ?? b.scheduled_hours));
    }
    for (const q of quickTasks) {
      if (!q.planned_date) continue;
      if (filters.clientFilter && q.entity_id !== filters.clientFilter) continue;
      const d = new Date(q.planned_date);
      if (d < days[0] || d > addDays(days[days.length - 1], 1)) continue;
      put(q.assignee_id, formatISO(d), 'quick', q, (q.duration || 15) / 60);
    }
    return out;
  }, [milestones, bmRows, quickTasks, filters.clientFilter, filters.serviceFilter, days, doneInAthena]);

  const hasUnassigned = useMemo(() => [...items.keys()].some((k) => k.startsWith('unassigned|')), [items]);
  const rows = useMemo(() => (hasUnassigned && !filters.teamFilter ? [...people, { id: null, name: 'Unassigned', working_days: '' }] : people), [people, hasUnassigned, filters.teamFilter]);

  const unplannedQuick = useMemo(() => {
    let list = quickTasks.filter((q) => !q.planned_date);
    if (filters.teamFilter) list = list.filter((q) => q.assignee_id === filters.teamFilter);
    return list;
  }, [quickTasks, filters.teamFilter]);

  // ── Drag ──
  const lookup = useMemo(() => {
    const m = {};
    milestones.forEach((x) => { m[`ms:${x.id}`] = { type: 'ms', item: x }; });
    bmRows.forEach((x) => { m[`bm:${x.id}`] = { type: 'bm', item: x }; });
    quickTasks.forEach((x) => { m[`quick:${x.id}`] = { type: 'quick', item: x }; });
    return m;
  }, [milestones, bmRows, quickTasks]);

  const handleDragEnd = useCallback(async (event) => {
    setActive(null);
    const { active: a, over } = event;
    if (!over) return;
    const src = lookup[a.id];
    if (!src) return;
    const dropId = String(over.id);
    try {
      if (dropId === 'unplanned') {
        if (src.type === 'quick') await updateQuickTask(src.item.id, { planned_date: null });
        return;
      }
      const [, pid, iso] = dropId.split(':'); // cell:{personId|unassigned}:{iso}
      const personId = pid === 'unassigned' ? null : pid;
      if (src.type === 'ms') {
        const m = src.item;
        if (m.status !== 'pending') return;
        const patch = { action: 'move_milestone', milestone_id: m.id, due_date: iso };
        if (personId && personId !== m.owner_id) patch.owner_id = personId;
        await callJobPlan(patch);
        await load();
      } else if (src.type === 'bm') {
        const b = src.item;
        if (personId !== (b.assignee_id || null)) { setError('A BrightManager job stays with its assignee here; change the owner in Allocations.'); return; }
        if (b.scheduled_for_date === iso) return;
        await rescheduleTask(b.id, iso);
        await load();
      } else if (src.type === 'quick') {
        const q = src.item;
        const dt = new Date(`${iso}T09:00:00`);
        const patch = { planned_date: dt.toISOString() };
        if (personId && personId !== q.assignee_id) patch.assignee_id = personId;
        await updateQuickTask(q.id, patch);
      }
    } catch (e) { setError(e.message || String(e)); }
  }, [lookup, updateQuickTask, load]);

  // ── Right-click ──
  const act = async (payload) => { await callJobPlan(payload); await load(); };
  const openMenu = (e, type, x) => {
    e.preventDefault(); e.stopPropagation();
    const items = [];
    let title = '';
    if (type === 'ms') {
      const p = x.job_plans;
      title = `${x.label} · ${p?.entities?.name || ''}`;
      const pending = x.status === 'pending';
      items.push({ label: 'Open the plan', run: () => navigate(`/planner/plan/${p.entity_id}/${p.period_end}`) });
      items.push({ label: 'Done…', disabled: !pending, run: () => setAsk({ title: x.label, subtitle: p?.entities?.name, defaultMins: x.hours ? Math.round(Number(x.hours) * 60) : null, run: (m) => act({ action: 'mark_done', milestone_id: x.id, minutes: m }) }) });
      items.push({ label: 'Not required (skip)', disabled: !pending, run: () => { if (window.confirm(`Skip "${x.label}" on this job?`)) act({ action: 'skip', milestone_id: x.id }).catch((er) => setError(er.message)); } });
      items.push({ label: 'Move to today', disabled: !pending || x.due_date === formatISO(now), run: () => act({ action: 'move_milestone', milestone_id: x.id, due_date: formatISO(now) }).catch((er) => setError(er.message)) });
    } else if (type === 'bm') {
      const done = doneInAthena[x.id];
      title = `${shortTask(x.bm_task_name)} · ${entityMap[x.entity_id]?.name || ''}`;
      items.push({ label: done ? 'Marked complete — update BrightManager' : 'Mark complete…', disabled: !!done, run: () => setAsk({
        title: shortTask(x.bm_task_name), subtitle: entityMap[x.entity_id]?.name, cta: 'Mark complete',
        defaultMins: x.remaining_hours != null ? Math.round(Number(x.remaining_hours) * 60) : null,
        note: 'The minutes go to your timesheet. The job then sits on your "Update in BrightManager" list on Today until the next import confirms it.',
        run: (m) => act({ action: 'complete_bm_job', schedule_id: x.id, minutes: m }),
      }) });
      items.push({ label: 'Move to today', disabled: x.scheduled_for_date === formatISO(now), run: async () => { try { await rescheduleTask(x.id, formatISO(now)); await load(); } catch (er) { setError(er.message); } } });
      if (x.entity_id) items.push({ label: 'Open the client', run: () => navigate(`/clients/${x.entity_id}`) });
    } else {
      title = x.title;
      items.push({ label: 'Open', run: () => onOpen({ ...x, _isQuick: true }) });
      items.push({ label: 'Done…', run: () => onQuickDone && onQuickDone(x) });
      items.push({ label: 'Not required', run: () => onQuickNotRequired && onQuickNotRequired(x) });
      items.push({ label: x.planned_date ? 'Unplan (back to the list)' : 'Plan for today', run: () => updateQuickTask(x.id, { planned_date: x.planned_date ? null : new Date(`${formatISO(now)}T09:00:00`).toISOString() }) });
      items.push({ label: 'Delete', danger: true, run: () => onQuickDelete && onQuickDelete(x) });
    }
    setMenu({ x: e.clientX, y: e.clientY, title, items });
  };
  const closeMenu = useCallback(() => setMenu(null), []);

  const loadColour = (used, cap) => (cap <= 0 ? '#94a3b8' : used > cap * 1.2 ? '#991b1b' : used > cap ? '#9a3412' : used > cap * 0.8 ? '#92400e' : '#166534');

  const renderTile = (type, x, overlay = false) => {
    const base = { padding: '3px 6px', marginBottom: 3, borderRadius: 5, fontSize: 11.5, lineHeight: 1.3, background: '#fff', border: '1px solid #e5e7eb', overflow: 'hidden', fontFamily: font };
    if (type === 'ms') {
      const p = x.job_plans;
      const done = x.status === 'done';
      const r = RISK_PILL[p?.risk];
      return (
        <div style={{ ...base, borderLeft: `3px solid ${KIND_COLOUR[x.kind] || '#64748b'}`, opacity: done ? 0.55 : 1 }} title={`${x.label} · ${p?.entities?.name}${x.pinned_by ? ' · pinned' : ''}`}>
          <div style={{ fontWeight: 500, textDecoration: done ? 'line-through' : 'none', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{x.label}</div>
          <div style={{ color: '#64748b', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
            {p?.entities?.name}{x.hours ? ` · ${Number(x.hours)}h` : ''}{x.pinned_by ? ' · 📌' : ''}
            {r && !done && <span style={{ marginLeft: 4, padding: '0 5px', borderRadius: 8, fontSize: 10, fontWeight: 600, background: r.bg, color: r.fg }}>{r.label}</span>}
          </div>
        </div>
      );
    }
    if (type === 'bm') {
      const draft = x.status === 'draft';
      const done = !!doneInAthena[x.id];
      return (
        <div style={{ ...base, borderLeft: `3px ${draft ? 'dashed' : 'solid'} #7c3aed`, background: draft ? '#faf5ff' : '#fff', opacity: done ? 0.55 : 1 }} title={`${x.bm_task_name} · ${entityMap[x.entity_id]?.name || ''} · ${x.status}${done ? ' · complete, update BM' : ''}`}>
          <div style={{ fontWeight: 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', textDecoration: done ? 'line-through' : 'none' }}>{shortTask(x.bm_task_name)}</div>
          <div style={{ color: '#64748b', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
            {entityMap[x.entity_id]?.name || 'Client'} · {Number(x.remaining_hours ?? x.scheduled_hours ?? 0)}h{draft ? ' · draft' : ''}{done ? ' · ✓ update BM' : ''}
          </div>
        </div>
      );
    }
    return (
      <div style={{ ...base, borderLeft: '3px dashed #38bdf8', background: '#f8fafc' }} title={x.title}>
        <div style={{ fontWeight: 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{x.title}</div>
        {x.entity_id && <div style={{ color: '#64748b', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{entityMap[x.entity_id]?.name}</div>}
      </div>
    );
  };

  const overlay = active ? <div style={{ width: 180, pointerEvents: 'none' }}>{renderTile(active.type, active.item, true)}</div> : null;

  // ── Shared: the floating bits (menu, minutes, day modal) ──
  const dayItems = (iso) => {
    const list = [];
    for (const [key, c] of items) {
      const [pid, d] = key.split('|');
      if (d !== iso) continue;
      const person = pid === 'unassigned' ? null : staffMap[pid];
      c.ms.forEach((m) => list.push({ type: 'ms', item: m, person }));
      c.bm.forEach((b) => list.push({ type: 'bm', item: b, person }));
      c.quick.forEach((q) => list.push({ type: 'quick', item: q, person }));
    }
    list.sort((a, b) => (a.person?.name || 'zz').localeCompare(b.person?.name || 'zz'));
    return list;
  };
  const clickFor = (type, x) => (e) => {
    e.stopPropagation();
    if (type === 'ms') navigate(`/planner/plan/${x.job_plans.entity_id}/${x.job_plans.period_end}`);
    else if (type === 'quick') onOpen({ ...x, _isQuick: true });
    else if (x.entity_id) navigate(`/clients/${x.entity_id}`);
  };
  const floating = (
    <>
      <ContextMenu menu={menu} onClose={closeMenu} />
      {ask && <MinutesModal ask={ask} onClose={() => setAsk(null)} />}
      {dayModal && (() => {
        const list = dayItems(dayModal);
        const d = new Date(`${dayModal}T12:00:00`);
        const totalHours = [...items.entries()].filter(([k]) => k.endsWith(`|${dayModal}`)).reduce((s, [, c]) => s + c.hours, 0);
        return (
          <div onClick={() => setDayModal(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.2)', zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, width: 520, maxWidth: '94vw', maxHeight: '85vh', overflow: 'auto', padding: 16, fontFamily: font, boxShadow: '0 4px 12px rgba(0,0,0,0.12)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>
                  {d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
                  <span style={{ color: '#94a3b8', fontWeight: 500, fontSize: 13 }}> · {list.length} item{list.length === 1 ? '' : 's'} · {Math.round(totalHours * 10) / 10}h</span>
                </div>
                <button onClick={() => { setDayModal(null); onPickDay && onPickDay(d); }} style={BTN.secondary.sm}>Open the week</button>
                <button onClick={() => setDayModal(null)} style={BTN.secondary.sm}>Close</button>
              </div>
              {list.length === 0 && <div style={{ fontSize: 13, color: '#cbd5e1', padding: 8 }}>Nothing planned.</div>}
              {list.map((r) => (
                <div key={`${r.type}:${r.item.id}`} onContextMenu={(e) => openMenu(e, r.type, r.item)} onClick={clickFor(r.type, r.item)} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                  <div style={{ width: 90, fontSize: 12, color: '#64748b', flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.person?.name || 'Unassigned'}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>{renderTile(r.type, r.item)}</div>
                </div>
              ))}
              <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 6 }}>Click to open. Right-click for options.</div>
            </div>
          </div>
        );
      })()}
    </>
  );

  // ── Month: stages, jobs and hours per day; click a day to see it ──
  if (calendarView === 'month') {
    const perDay = new Map();
    for (const [key, c] of items) {
      const iso = key.split('|')[1];
      if (!perDay.has(iso)) perDay.set(iso, { stages: 0, jobs: 0, hours: 0 });
      const d = perDay.get(iso);
      d.stages += c.ms.length; d.jobs += c.bm.length + c.quick.length; d.hours += c.hours;
    }
    return (
      <div style={{ padding: 10, fontFamily: font }}>
        {floating}
        {error && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13, marginBottom: 8 }}>{error}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <div key={d} style={{ padding: 6, fontSize: 12, fontWeight: 600, color: '#94a3b8', textAlign: 'center', borderBottom: '1px solid #e5e7eb' }}>{d}</div>
          ))}
          {days.map((d, i) => {
            const iso = formatISO(d);
            const c = perDay.get(iso);
            const other = d.getMonth() !== anchor.getMonth();
            const weekend = d.getDay() === 0 || d.getDay() === 6;
            return (
              <div key={i} onClick={() => setDayModal(iso)} style={{ minHeight: 78, padding: 6, borderRight: '1px solid #f1f5f9', borderBottom: '1px solid #f1f5f9', opacity: other ? 0.4 : 1, background: sameDay(d, now) ? '#eff6ff' : weekend ? '#fafafa' : '#fff', cursor: 'pointer' }}>
                <div style={{ fontSize: 13, fontWeight: sameDay(d, now) ? 700 : 500, color: sameDay(d, now) ? '#0e7fe0' : '#64748b' }}>{d.getDate()}</div>
                {c && (
                  <div style={{ fontSize: 11.5, color: '#475569', marginTop: 4 }}>
                    {c.stages > 0 && <div>{c.stages} stage{c.stages === 1 ? '' : 's'}</div>}
                    {c.jobs > 0 && <div>{c.jobs} job{c.jobs === 1 ? '' : 's'}</div>}
                    <div style={{ color: c.hours > 0 ? '#0f172a' : '#94a3b8', fontWeight: 600 }}>{Math.round(c.hours * 10) / 10}h</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>Click a day to see what is on it. Weekend work shows here and in Full week; Work week hides Saturday and Sunday.</div>
      </div>
    );
  }

  // ── Week: people × days ──
  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin}
      onDragStart={(e) => setActive(lookup[e.active.id] || null)} onDragEnd={handleDragEnd} onDragCancel={() => setActive(null)}>
      <div style={{ display: 'flex', height: '100%', fontFamily: font }}>
        <Cell id="unplanned" style={{ width: 200, flexShrink: 0, borderRight: '1px solid #e5e7eb', background: '#fff', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '8px 10px', fontSize: 12, fontWeight: 600, color: '#94a3b8', borderBottom: '1px solid #e5e7eb' }}>Unplanned quick tasks ({unplannedQuick.length})</div>
          <div style={{ overflowY: 'auto', padding: 5, flex: 1 }}>
            {unplannedQuick.map((q) => (
              <Tile key={q.id} id={`quick:${q.id}`} data={{ type: 'quick' }} onClick={(e) => { e.stopPropagation(); onOpen({ ...q, _isQuick: true }); }} onContextMenu={(e) => openMenu(e, 'quick', q)}>
                {renderTile('quick', q)}
              </Tile>
            ))}
            {unplannedQuick.length === 0 && <div style={{ padding: 8, fontSize: 12, color: '#cbd5e1', textAlign: 'center' }}>Nothing waiting</div>}
          </div>
          <div style={{ padding: '6px 10px', fontSize: 11, color: '#94a3b8', borderTop: '1px solid #e5e7eb' }}>Drag onto a day to plan it. Drop here to unplan. Right-click for options.</div>
        </Cell>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {error && <div style={{ margin: 8, padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13 }}>{error}<button onClick={() => setError(null)} style={{ ...BTN.secondary.sm, marginLeft: 8 }}>OK</button></div>}
          {loading && <div style={{ padding: 8, fontSize: 12, color: '#94a3b8' }}>Loading the week…</div>}
          <div style={{ display: 'grid', gridTemplateColumns: `170px repeat(${days.length}, minmax(150px, 1fr))`, minWidth: 170 + days.length * 150 }}>
            <div style={{ position: 'sticky', top: 0, zIndex: 3, background: '#fff', borderBottom: '1px solid #e5e7eb', borderRight: '1px solid #e5e7eb' }} />
            {days.map((d, i) => (
              <div key={i} style={{ position: 'sticky', top: 0, zIndex: 3, background: '#fff', textAlign: 'center', padding: 6, fontSize: 13, fontWeight: 600, color: sameDay(d, now) ? '#0e7fe0' : '#64748b', borderBottom: '1px solid #e5e7eb', borderRight: '1px solid #f1f5f9' }}>
                {d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
              </div>
            ))}
            {rows.map((p) => {
              const pid = p.id || 'unassigned';
              const weekUsed = days.reduce((s, d) => s + (items.get(`${pid}|${formatISO(d)}`)?.hours || 0), 0);
              const weekCap = p.id ? days.reduce((s, d) => s + dayCapacity(p, d), 0) : 0;
              return (
                <React.Fragment key={pid}>
                  <div style={{ padding: '8px 10px', borderBottom: '1px solid #e5e7eb', borderRight: '1px solid #e5e7eb', background: '#fff', position: 'sticky', left: 0, zIndex: 2 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {p.id && <Avatar id={p.id} staffMap={staffMap} size={20} customColour={staffColours?.[p.id]} />}
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{p.name}</div>
                    </div>
                    {p.id && (
                      <div style={{ fontSize: 11, marginTop: 2, color: loadColour(weekUsed, weekCap), fontWeight: 600 }}>
                        {Math.round(weekUsed * 10) / 10}h / {Math.round(weekCap)}h this week
                      </div>
                    )}
                  </div>
                  {days.map((d, i) => {
                    const iso = formatISO(d);
                    const c = items.get(`${pid}|${iso}`);
                    const cap = p.id ? dayCapacity(p, d) : 0;
                    const off = p.id && cap === 0;
                    return (
                      <Cell key={i} id={`cell:${pid}:${iso}`} style={{ padding: 4, minHeight: 64, borderBottom: '1px solid #e5e7eb', borderRight: '1px solid #f1f5f9', background: off ? '#f8fafc' : sameDay(d, now) ? '#f0f9ff' : '#fff', verticalAlign: 'top' }}>
                        {c?.ms.map((m) => (
                          <Tile key={m.id} id={`ms:${m.id}`} data={{ type: 'ms' }} disabled={m.status !== 'pending'} onContextMenu={(e) => openMenu(e, 'ms', m)}
                            onClick={(e) => { e.stopPropagation(); navigate(`/planner/plan/${m.job_plans.entity_id}/${m.job_plans.period_end}`); }}>
                            {renderTile('ms', m)}
                          </Tile>
                        ))}
                        {c?.bm.map((b) => (
                          <Tile key={b.id} id={`bm:${b.id}`} data={{ type: 'bm' }} disabled={!!doneInAthena[b.id]} onContextMenu={(e) => openMenu(e, 'bm', b)}
                            onClick={(e) => { e.stopPropagation(); if (b.entity_id) navigate(`/clients/${b.entity_id}`); }}>{renderTile('bm', b)}</Tile>
                        ))}
                        {c?.quick.map((q) => (
                          <Tile key={q.id} id={`quick:${q.id}`} data={{ type: 'quick' }} onClick={(e) => { e.stopPropagation(); onOpen({ ...q, _isQuick: true }); }} onContextMenu={(e) => openMenu(e, 'quick', q)}>
                            {renderTile('quick', q)}
                          </Tile>
                        ))}
                        {p.id && (c?.hours > 0 || cap > 0) && (
                          <div style={{ fontSize: 10.5, color: loadColour(c?.hours || 0, cap), textAlign: 'right', marginTop: 2 }}>
                            {off ? 'off' : `${Math.round((c?.hours || 0) * 10) / 10} / ${Math.round(cap * 10) / 10}h`}
                          </div>
                        )}
                      </Cell>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
      <DragOverlay dropAnimation={null}>{overlay}</DragOverlay>
      {floating}
    </DndContext>
  );
}
