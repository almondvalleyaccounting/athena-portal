import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DndContext, DragOverlay, useDraggable, useDroppable, PointerSensor, useSensor, useSensors, pointerWithin } from '@dnd-kit/core';
import { supabase } from '../../../lib/supabase';
import { useWorkPlanner } from '../WorkPlannerModule';
import { callJobPlan } from '../plan/planQueries';
import { listScheduleInRange, rescheduleTask } from '../setup/queries';
import { generateInstances } from '../lib/instanceEngine';
import { kindOf } from '../lib/blocksApi';
import { formatISO, addDays, startOfWeek, today, sameDay } from '../lib/helpers';
import { ContextMenu, MinutesModal, dayCapacity, loadColour, shortTask } from '../components/PlannerBits';
import JobSelectorModal from '../components/JobSelectorModal';
import { Check, Mail, ArrowRight, ArrowUpRight, MessageSquare, MoreHorizontal } from 'lucide-react';
import EmailModal from '../components/EmailModal';
import { BTN } from '../../../lib/buttonStyles';

// Day Plan (Bobby, 2026-09-26): one person's day in detail, two-way with the
// week Planner. Left: what was planned for an earlier day and is still open,
// to pull into today. Middle: today's tiles, dragged up and down to set the
// order (sql/313). Right: the rest of the week in date order. Any tile with
// a client can send an email about it; the Job Selector pulls BM work in.

const font = "'Outfit', sans-serif";
const KIND_COLOUR = { comms: '#d97706', milestone: '#64748b', work: '#0e7fe0', calendar: '#db2777' };
const RISK_PILL = {
  urgent: { bg: '#fee2e2', fg: '#991b1b', label: 'Urgent' },
  at_risk: { bg: '#ffedd5', fg: '#9a3412', label: 'At risk' },
  waiting_on_client: { bg: '#fef3c7', fg: '#92400e', label: 'Waiting' },
};
const fmtDay = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

function Draggable({ id, disabled, children }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, disabled });
  return <div ref={setNodeRef} {...listeners} {...attributes} style={{ opacity: isDragging ? 0.3 : 1, touchAction: 'none', cursor: disabled ? 'default' : 'grab' }}>{children}</div>;
}
function DropZone({ id, style, children, activeStyle }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return <div ref={setNodeRef} style={{ ...style, ...(isOver ? activeStyle || { background: '#eff6ff' } : {}) }}>{children}</div>;
}

export default function DayPlanView({ selectorOpen, onSelectorClose, onOpenQuick, onQuickDone, onCompleteBlock, onOpenTask, refreshTick }) {
  const navigate = useNavigate();
  const { staffList, staffMap, entityMap, quickTasks, scheduledTasks, overridesMap, completedKeys, blockItemsMap, filters, updateQuickTask, profile, holidayMap = {}, coverMap = {}, bankHolidays = {} } = useWorkPlanner();
  const [day, setDay] = useState(formatISO(today()));
  const personId = filters.teamFilter || profile?.id;
  const person = staffMap[personId];
  const [milestones, setMilestones] = useState([]);
  const [bmRows, setBmRows] = useState([]);
  const [coverMs, setCoverMs] = useState([]); // stages I am covering while the owner is off
  const [coverBm, setCoverBm] = useState([]);
  const [hover, setHover] = useState(null); // tile key under the pointer
  const [doneInAthena, setDoneInAthena] = useState({});
  const [order, setOrder] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [menu, setMenu] = useState(null);
  const [ask, setAsk] = useState(null);
  const [email, setEmail] = useState(null);
  const [reschedule, setReschedule] = useState(null); // tile being moved to a chosen day
  const [active, setActive] = useState(null);
  const [weekOffset, setWeekOffset] = useState(0); // right column: 0 = rest of this week, n = n weeks on
  const [undo, setUndo] = useState(null); // { x, from } for the last move
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const dayDate = useMemo(() => new Date(`${day}T12:00:00`), [day]);
  // The rest of the week runs to Sunday; late in the week it takes next week too.
  const weekEnd = useMemo(() => {
    const sun = addDays(startOfWeek(dayDate), 6);
    return dayDate.getDay() >= 5 || dayDate.getDay() === 0 ? addDays(sun, 7) : sun;
  }, [dayDate]);
  const weekEndISO = formatISO(weekEnd);
  const backISO = formatISO(addDays(dayDate, -90));
  // The right column can page forward a week at a time; the window loads that far.
  const pageStart = useMemo(() => (weekOffset === 0 ? addDays(dayDate, 1) : addDays(startOfWeek(weekEnd), 1 + 7 * (weekOffset - 1) + 7)), [weekOffset, dayDate, weekEnd]);
  const pageEnd = useMemo(() => (weekOffset === 0 ? weekEnd : addDays(pageStart, 6)), [weekOffset, weekEnd, pageStart]);
  const loadEndISO = formatISO(pageEnd);

  const load = useCallback(async () => {
    if (!personId) return;
    setLoading(true); setError(null);
    try {
      const [{ data: ms, error: mErr }, bm, { data: comps }, { data: ord }] = await Promise.all([
        supabase.from('job_milestones')
          .select('id, stage_key, label, kind, hours, owner_id, due_date, status, note, comms_sent_at, job_plans!inner(id, entity_id, period_end, status, risk, entities(name))')
          .eq('owner_id', personId).eq('status', 'pending').eq('job_plans.status', 'committed').lte('due_date', loadEndISO).order('due_date').limit(500),
        listScheduleInRange({ startISO: backISO, endISO: loadEndISO, staffIds: [personId] }),
        supabase.from('bm_task_completions').select('bm_task_schedule_id').is('confirmed_at', null).limit(1000),
        supabase.from('day_plan_order').select('keys').eq('staff_id', personId).eq('day', day).maybeSingle(),
      ]);
      if (mErr) throw mErr;
      setMilestones(ms || []);
      setBmRows((bm || []).filter((b) => b.state !== 'completed'));
      // Tasks handed to me for the owner's holiday dates (sql/320).
      const mineCover = Object.entries(coverMap).filter(([, c]) => c.cover === personId && c.to >= backISO && c.from <= loadEndISO);
      const msIds = mineCover.filter(([k]) => k.startsWith('ms:')).map(([k]) => k.split(':')[1]);
      const bmIds = mineCover.filter(([k]) => k.startsWith('bm:')).map(([k]) => k.split(':')[1]);
      const [cm, cb] = await Promise.all([
        msIds.length ? supabase.from('job_milestones').select('id, stage_key, label, kind, hours, owner_id, due_date, status, note, comms_sent_at, job_plans!inner(id, entity_id, period_end, status, risk, entities(name))').in('id', msIds).eq('status', 'pending').then((r) => r.data || []) : Promise.resolve([]),
        bmIds.length ? listScheduleInRange({ startISO: backISO, endISO: loadEndISO }).then((rows) => rows.filter((r) => bmIds.includes(r.id) && r.state !== 'completed')) : Promise.resolve([]),
      ]);
      setCoverMs(cm); setCoverBm(cb);
      const map = {}; (comps || []).forEach((c) => { if (c.bm_task_schedule_id) map[c.bm_task_schedule_id] = true; });
      setDoneInAthena(map);
      setOrder(ord?.keys || []);
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, [personId, day, loadEndISO, backISO, coverMap]);
  useEffect(() => { load(); }, [load, refreshTick]);

  // ── Every item as a uniform tile record ──
  const all = useMemo(() => {
    const out = [];
    // A task covered by someone else during the owner's holiday leaves the owner's day.
    const away = (ckey, date) => { const c = coverMap[ckey]; return c && c.owner === personId && date >= c.from && date <= c.to; };
    milestones.forEach((m) => { if (!away(`ms:${m.id}`, m.due_date)) out.push({ key: `ms:${m.id}`, type: 'ms', item: m, date: m.due_date, hours: Number(m.hours) || 0, title: m.label, client: m.job_plans?.entities?.name, entity_id: m.job_plans?.entity_id }); });
    bmRows.forEach((b) => { if (!doneInAthena[b.id] && !away(`bm:${b.id}`, b.scheduled_for_date)) out.push({ key: `bm:${b.id}`, type: 'bm', item: b, date: b.scheduled_for_date, hours: Number(b.remaining_hours ?? b.scheduled_hours) || 0, title: shortTask(b.bm_task_name), client: entityMap[b.entity_id]?.name, entity_id: b.entity_id }); });
    quickTasks.forEach((q) => {
      if (!q.planned_date) return;
      const date = formatISO(new Date(q.planned_date));
      const cv = coverMap[`quick:${q.id}`];
      const coveringForMe = cv && cv.cover === personId && date >= cv.from && date <= cv.to;
      if (q.assignee_id !== personId && !coveringForMe) return;
      if (q.assignee_id === personId && away(`quick:${q.id}`, date)) return;
      out.push({ key: `quick:${q.id}`, type: 'quick', item: q, date, hours: (q.duration || 15) / 60, title: q.title, client: entityMap[q.entity_id]?.name, entity_id: q.entity_id, coverFor: coveringForMe ? cv.owner : null });
    });
    scheduledTasks.forEach((m) => {
      if (!m.planned_date) return;
      generateInstances(m, addDays(dayDate, -14), pageEnd, overridesMap, completedKeys).forEach((inst) => {
        const date = formatISO(inst._date);
        const cv = coverMap[`block:${m.id}:${date}`];
        const coveringForMe = cv && cv.cover === personId && date >= cv.from && date <= cv.to;
        if (m.assignee_id !== personId && !coveringForMe) return;
        if (m.assignee_id === personId && cv && cv.owner === personId && date >= cv.from && date <= cv.to) return;
        out.push({ key: `block:${inst._key}`, type: 'block', item: inst, date, hours: (inst.duration || 0) / 60, title: inst.title, client: inst.entity_id ? entityMap[inst.entity_id]?.name : null, entity_id: inst.entity_id || null, coverFor: coveringForMe ? cv.owner : null });
      });
    });
    coverMs.forEach((m) => { const cv = coverMap[`ms:${m.id}`]; if (cv && m.due_date >= cv.from && m.due_date <= cv.to) out.push({ key: `ms:${m.id}`, type: 'ms', item: m, date: m.due_date, hours: Number(m.hours) || 0, title: m.label, client: m.job_plans?.entities?.name, entity_id: m.job_plans?.entity_id, coverFor: cv.owner }); });
    coverBm.forEach((b) => { const cv = coverMap[`bm:${b.id}`]; if (cv && b.scheduled_for_date >= cv.from && b.scheduled_for_date <= cv.to && !doneInAthena[b.id]) out.push({ key: `bm:${b.id}`, type: 'bm', item: b, date: b.scheduled_for_date, hours: Number(b.remaining_hours ?? b.scheduled_hours) || 0, title: shortTask(b.bm_task_name), client: entityMap[b.entity_id]?.name, entity_id: b.entity_id, coverFor: cv.owner }); });
    return out;
  }, [milestones, bmRows, coverMs, coverBm, doneInAthena, quickTasks, scheduledTasks, overridesMap, completedKeys, personId, entityMap, dayDate, pageEnd, coverMap]);

  const incomplete = useMemo(() => all.filter((x) => x.date < day && !(x.type === 'block' && !x.item.carry_over)).sort((a, b) => a.date.localeCompare(b.date)), [all, day]);
  // Blocks that do not carry over: missed days wait for a reason, not for the work.
  const unexplained = useMemo(() => all.filter((x) => x.type === 'block' && !x.item.carry_over && x.date < day).sort((a, b) => a.date.localeCompare(b.date)), [all, day]);
  const todayList = useMemo(() => {
    const list = all.filter((x) => x.date === day);
    const pos = new Map(order.map((k, i) => [k, i]));
    return list.sort((a, b) => {
      const pa = pos.has(a.key) ? pos.get(a.key) : 1e6, pb = pos.has(b.key) ? pos.get(b.key) : 1e6;
      if (pa !== pb) return pa - pb;
      return b.hours - a.hours;
    });
  }, [all, day, order]);
  const rest = useMemo(() => {
    const groups = new Map();
    const fromISO = formatISO(pageStart), toISO = formatISO(pageEnd);
    all.filter((x) => x.date >= fromISO && x.date <= toISO).sort((a, b) => a.date.localeCompare(b.date)).forEach((x) => { if (!groups.has(x.date)) groups.set(x.date, []); groups.get(x.date).push(x); });
    // Empty working days still get a drop target.
    for (let d = new Date(pageStart); d <= pageEnd; d = addDays(d, 1)) {
      const iso = formatISO(d);
      if (!groups.has(iso) && d.getDay() !== 0 && d.getDay() !== 6) groups.set(iso, []);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [all, pageStart, pageEnd]);
  const byKey = useMemo(() => Object.fromEntries(all.map((x) => [x.key, x])), [all]);
  const todayHours = todayList.reduce((s, x) => s + x.hours, 0);
  const holiday = person ? holidayMap[`${person.id}|${day}`] : null;
  const cap = person && !holiday ? dayCapacity(person, dayDate) : 0;

  // ── Moves (the same writes the week Planner makes) ──
  const moveTo = async (x, iso, remember = true) => {
    if (x.date === iso) return;
    if (x.type === 'ms') await callJobPlan({ action: 'move_milestone', milestone_id: x.item.id, due_date: iso });
    else if (x.type === 'bm') await rescheduleTask(x.item.id, iso);
    else if (x.type === 'quick') await updateQuickTask(x.item.id, { planned_date: new Date(`${iso}T09:00:00`).toISOString() });
    else throw new Error('A block stays on its day; complete it or mark it not required.');
    if (remember) setUndo({ x, from: x.date, to: iso });
  };
  const undoMove = async () => {
    if (!undo) return;
    try { await moveTo({ ...undo.x, date: undo.to }, undo.from, false); setUndo(null); await load(); }
    catch (e) { setError(e.message || String(e)); }
  };
  // "Back to Incomplete": the previous working day, so it lands on the left.
  const prevWorkingISO = (() => { let d = addDays(dayDate, -1); while (d.getDay() === 0 || d.getDay() === 6) d = addDays(d, -1); return formatISO(d); })();
  const saveOrder = async (keys) => {
    setOrder(keys);
    if (personId === profile?.id) await callJobPlan({ action: 'set_day_order', day, keys }).catch((e) => setError(e.message));
  };

  const handleDragEnd = useCallback(async (event) => {
    setActive(null);
    const { active: a, over } = event;
    if (!over) return;
    const x = byKey[a.id];
    if (!x) return;
    const target = String(over.id);
    try {
      if (target.startsWith('slot:') || target === 'today-end') {
        const before = target === 'today-end' ? null : target.slice(5);
        const keys = todayList.map((t) => t.key).filter((k) => k !== x.key);
        const idx = before ? keys.indexOf(before) : keys.length;
        keys.splice(idx < 0 ? keys.length : idx, 0, x.key);
        if (x.date !== day) { await moveTo(x, day); await load(); }
        await saveOrder(keys);
      } else if (target.startsWith('day:')) {
        await moveTo(x, target.slice(4));
        await load();
      } else if (target === 'incomplete') {
        if (x.date >= day) { await moveTo(x, prevWorkingISO); await load(); }
      }
    } catch (e) { setError(e.message || String(e)); }
  }, [byKey, todayList, day, load]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ──
  const act = async (payload) => { await callJobPlan(payload); await load(); };
  const doneFor = (x) => {
    if (x.type === 'ms') setAsk({ title: x.title, subtitle: x.client, defaultMins: x.hours ? Math.round(x.hours * 60) : null, run: (m) => act({ action: 'mark_done', milestone_id: x.item.id, minutes: m }) });
    else if (x.type === 'bm') setAsk({ title: x.title, subtitle: x.client, cta: 'Mark complete', defaultMins: x.hours ? Math.round(x.hours * 60) : null, note: 'The minutes go to your timesheet. The job then sits on your "Update in BrightManager" list on Overview until the next import confirms it.', run: (m) => act({ action: 'complete_bm_job', schedule_id: x.item.id, minutes: m }) });
    else if (x.type === 'quick') onQuickDone && onQuickDone(x.item);
    else onCompleteBlock && onCompleteBlock(x.item);
  };
  const openFor = (x) => {
    if (x.type === 'block') onOpenTask({ type: 'block', id: x.item._masterId, occurrence_date: x.date });
    else onOpenTask({ type: x.type, id: x.item.id });
  };
  const openMenu = (e, x) => {
    e.preventDefault(); e.stopPropagation();
    const items = [
      { label: 'Open', run: () => openFor(x) },
      { label: x.type === 'bm' ? 'Mark complete…' : x.type === 'block' ? 'Complete / log time…' : 'Done…', run: () => doneFor(x) },
    ];
    if (x.type === 'ms') items.push({ label: 'Not required (skip)', run: () => { if (window.confirm(`Skip "${x.title}" on this job?`)) act({ action: 'skip', milestone_id: x.item.id }).catch((er) => setError(er.message)); } });
    if (x.type !== 'block') {
      const todayIso = formatISO(today());
      if (x.date !== todayIso) items.push({ label: 'Move to today', run: () => moveTo(x, todayIso).then(load).catch((er) => setError(er.message)) });
      if (x.date !== day && day !== todayIso) items.push({ label: `Move to ${fmtDay(day)}`, run: () => moveTo(x, day).then(load).catch((er) => setError(er.message)) });
      items.push({ label: 'Reschedule…', run: () => setReschedule(x) });
    }
    items.push({ label: 'Log time…', run: () => setAsk({ title: 'Log time', subtitle: `${x.title}${x.client ? ` · ${x.client}` : ''}`, cta: 'Log', note: 'Goes straight to your timesheet. The task stays open.', run: (m) => { if (!(m > 0)) throw new Error('Enter the minutes'); return callJobPlan({ action: 'log_time', task: x.type === 'block' ? { type: 'block', id: x.item._masterId, occurrence_date: x.date } : { type: x.type, id: x.item.id }, minutes: m }); } }) });
    if (x.type === 'bm' || x.type === 'ms') items.push({ label: 'Reassign…', run: () => onOpenTask({ type: x.type, id: x.item.id, reassign: true }) });
    items.push({ label: 'Add a comment…', run: () => onOpenTask(x.type === 'block' ? { type: 'block', id: x.item._masterId, occurrence_date: x.date, comment: true } : { type: x.type, id: x.item.id, comment: true }) });
    if (x.entity_id) items.push({ label: 'Email…', run: () => setEmail(x) });
    if (x.type === 'quick') items.push({ label: 'Edit', run: () => onOpenQuick && onOpenQuick(x.item) });
    if (x.date === day && x.type !== 'block') items.push({ label: 'Back to Incomplete', run: () => moveTo(x, prevWorkingISO).then(load).catch((er) => setError(er.message)) });
    setMenu({ x: e.clientX, y: e.clientY, title: `${x.title}${x.client ? ` · ${x.client}` : ''}`, items });
  };
  const closeMenu = useCallback(() => setMenu(null), []);

  // ── Tile ──
  // One compact tile everywhere (Bobby, 2026-09-26): a click opens the task
  // modal, right-click has the full menu. On hover an icon strip slides in
  // over the hours (option A, 2026-09-27) so the tile never changes height.
  const Tile = ({ x, showDate, compact }) => {
    const risk = x.type === 'ms' ? RISK_PILL[x.item.job_plans?.risk] : null;
    const border = x.type === 'ms' ? `3px solid ${KIND_COLOUR[x.item.kind] || '#64748b'}` : x.type === 'bm' ? `3px ${x.item.status === 'draft' ? 'dashed' : 'solid'} #7c3aed` : x.type === 'block' ? '3px solid #0f766e' : '3px dashed #38bdf8';
    const n = x.type === 'block' ? (blockItemsMap[x.item._masterId] || []).length : 0;
    const showButtons = !compact && hover === x.key;
    const ico = { width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', color: '#475569', cursor: 'pointer', padding: 0 };
    return (
      <div onContextMenu={(e) => openMenu(e, x)} onClick={() => openFor(x)} onMouseEnter={() => setHover(x.key)} onMouseLeave={() => setHover((h) => (h === x.key ? null : h))}
        style={{ position: 'relative', background: showButtons ? '#eff6ff' : x.type === 'block' ? '#f0fdfa' : '#fff', border: x.coverFor ? '1px dashed #f59e0b' : `1px solid ${showButtons ? '#bfdbfe' : '#e5e7eb'}`, borderLeft: border, borderRadius: 7, padding: '5px 8px', marginBottom: 5, fontFamily: font, cursor: 'pointer' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.title}</div>
          {x.hours > 0 && <div style={{ fontSize: 11.5, color: '#94a3b8', whiteSpace: 'nowrap' }}>{Math.round(x.hours * 10) / 10}h</div>}
        </div>
        <div style={{ fontSize: 11.5, color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {x.client || (x.type === 'block' ? `${kindOf(x.item.block_kind).label}${n ? ` · ${n} clients` : ''}` : 'General')}
          {showDate ? ` · ${fmtDay(x.date)}` : ''}
          {x.type === 'ms' && x.item.comms_sent_at ? ' · sent' : ''}
          {x.coverFor ? <span style={{ color: '#b45309', fontWeight: 600 }}> · covering for {staffMap[x.coverFor]?.name?.split(' ')[0] || 'a colleague'}</span> : ''}
          {risk && <span style={{ marginLeft: 5, padding: '0 5px', borderRadius: 8, fontSize: 10, fontWeight: 600, background: risk.bg, color: risk.fg }}>{risk.label}</span>}
        </div>
        {showButtons && (
          <div style={{ position: 'absolute', right: 5, top: 5, display: 'flex', gap: 3, background: '#eff6ff', paddingLeft: 8 }} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            <button onClick={() => doneFor(x)} title={x.type === 'bm' ? 'Mark complete' : x.type === 'block' ? 'Log time' : 'Done'} style={{ ...ico, background: '#0e7fe0', borderColor: '#0e7fe0', color: '#fff' }}><Check size={14} /></button>
            {x.entity_id && <button onClick={() => setEmail(x)} title="Email" style={ico}><Mail size={14} /></button>}
            {x.date !== day && x.type !== 'block' && <button onClick={() => moveTo(x, day).then(load).catch((er) => setError(er.message))} title={sameDay(dayDate, today()) ? 'Move to today' : 'Move to this day'} style={ico}><ArrowRight size={14} /></button>}
            {x.type !== 'block' && <button onClick={() => setReschedule(x)} title="Reschedule…" style={ico}><ArrowUpRight size={14} /></button>}
            <button onClick={() => onOpenTask(x.type === 'block' ? { type: 'block', id: x.item._masterId, occurrence_date: x.date, comment: true } : { type: x.type, id: x.item.id, comment: true })} title="Add a comment" style={ico}><MessageSquare size={14} /></button>
            <button onClick={(e) => openMenu(e, x)} title="More" style={ico}><MoreHorizontal size={14} /></button>
          </div>
        )}
      </div>
    );
  };

  const colHead = { padding: '8px 10px', fontSize: 12.5, fontWeight: 700, color: '#475569', borderBottom: '1px solid #e5e7eb', background: '#f8fafc', display: 'flex', alignItems: 'baseline', gap: 6 };
  const col = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, display: 'flex', flexDirection: 'column', minHeight: 0 };

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={(e) => setActive(byKey[e.active.id] || null)} onDragEnd={handleDragEnd} onDragCancel={() => setActive(null)}>
      <div style={{ padding: 10, height: '100%', display: 'flex', flexDirection: 'column', gap: 8, fontFamily: font, boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setDay(formatISO(addDays(dayDate, -1)))} style={BTN.secondary.sm}>‹</button>
          <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} style={{ padding: '5px 8px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6 }} />
          <button onClick={() => setDay(formatISO(addDays(dayDate, 1)))} style={BTN.secondary.sm}>›</button>
          <button onClick={() => setDay(formatISO(today()))} style={BTN.secondary.sm}>Today</button>
          <div style={{ fontSize: 14, fontWeight: 600, marginLeft: 4 }}>{dayDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          <div style={{ fontSize: 12.5, color: '#64748b' }}>· {person?.name || '—'}{filters.teamFilter && filters.teamFilter !== profile?.id ? ' (viewing)' : ''}</div>
          {bankHolidays[day] && <div style={{ fontSize: 12, color: '#9a3412', fontWeight: 600 }} title="For information; working days are unchanged">· {bankHolidays[day]} (bank holiday)</div>}
          <div style={{ flex: 1 }} />
          {undo && <button onClick={undoMove} style={BTN.secondary.sm} title={`Put "${undo.x.title}" back on ${fmtDay(undo.from)}`}>Undo move</button>}
          <div style={{ fontSize: 12.5, fontWeight: 600, color: loadColour(todayHours, cap) }}>{Math.round(todayHours * 10) / 10}h planned / {Math.round(cap * 10) / 10}h</div>
          {loading && <span style={{ fontSize: 12, color: '#94a3b8' }}>Loading…</span>}
        </div>
        {error && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13 }}>{error}<button onClick={() => setError(null)} style={{ ...BTN.secondary.sm, marginLeft: 8 }}>OK</button></div>}
        {holiday && <div style={{ padding: '6px 12px', borderRadius: 8, background: '#fff7ed', color: '#9a3412', fontSize: 13, fontWeight: 600 }}>{person?.name?.split(' ')[0]} is off this day ({holiday.kind}{holiday.half_day ? ', half day' : ''}){holiday.cover_staff_id ? ` · cover ${staffMap[holiday.cover_staff_id]?.name?.split(' ')[0] || ''}` : ''}. Anything planned here needs to move or be handed over.</div>}

        <div style={{ display: 'grid', gridTemplateColumns: '380px minmax(320px, 1fr) 380px', gap: 10, flex: 1, minHeight: 0 }}>
          <DropZone id="incomplete" style={col} activeStyle={{ background: '#eff6ff' }}>
            <div style={colHead}>Incomplete <span style={{ fontWeight: 500, color: '#94a3b8' }}>· {incomplete.length}</span></div>
            <div style={{ overflowY: 'auto', padding: 6, flex: 1 }}>
              {unexplained.length > 0 && (
                <div style={{ marginBottom: 8, padding: '6px 8px', borderRadius: 8, background: '#fffbeb', border: '1px solid #fcd34d' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 4 }}>Missed blocks · say why</div>
                  {unexplained.map((x) => (
                    <div key={x.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, padding: '2px 0' }}>
                      <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.title} <span style={{ color: '#94a3b8' }}>· {fmtDay(x.date)}</span></span>
                      <button onClick={() => onCompleteBlock && onCompleteBlock(x.item)} style={BTN.secondary.sm}>Explain / log</button>
                    </div>
                  ))}
                </div>
              )}
              {incomplete.length === 0 && unexplained.length === 0 && <div style={{ fontSize: 12.5, color: '#cbd5e1', padding: 8 }}>Nothing left over from earlier days.</div>}
              {incomplete.map((x) => <Draggable key={x.key} id={x.key} disabled={x.type === 'block'}><Tile x={x} showDate /></Draggable>)}
            </div>
            <div style={{ padding: '6px 10px', fontSize: 11, color: '#94a3b8', borderTop: '1px solid #e5e7eb' }}>Planned for an earlier day, still open. Drag into the day or use →. Drop a tile here to send it back.</div>
          </DropZone>

          <div style={{ ...col, border: '2px solid #0e7fe0' }}>
            <div style={{ ...colHead, background: '#e0f2fe', color: '#0c447c', borderBottom: '1px solid #bae6fd' }}>{sameDay(dayDate, today()) ? 'Today' : fmtDay(day)} <span style={{ fontWeight: 500, color: '#185fa5' }}>· {todayList.length} · drag to prioritise</span></div>
            <div style={{ overflowY: 'auto', padding: 6, flex: 1, display: 'flex', flexDirection: 'column' }}>
              {todayList.map((x) => (
                <DropZone key={x.key} id={`slot:${x.key}`} style={{ borderTop: '2px solid transparent', paddingTop: 2 }} activeStyle={{ borderTop: '2px solid #0e7fe0' }}>
                  <Draggable id={x.key}><Tile x={x} /></Draggable>
                </DropZone>
              ))}
              <DropZone id="today-end" style={{ flex: 1, minHeight: 60, borderRadius: 8, border: '1px dashed #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#cbd5e1', fontSize: 12.5 }}>
                {todayList.length === 0 ? 'Nothing planned. Drag from either side, or use the Job Selector.' : 'Drop here to add at the end'}
              </DropZone>
            </div>
          </div>

          <div style={col}>
            <div style={{ ...colHead, gap: 4 }}>
              <button onClick={() => setWeekOffset((n) => Math.max(0, n - 1))} disabled={weekOffset === 0} style={{ ...BTN.secondary.sm, padding: '2px 7px', opacity: weekOffset === 0 ? 0.4 : 1 }} title="Previous week">‹</button>
              <span style={{ flex: 1, textAlign: 'center' }}>{weekOffset === 0 ? 'Rest of the week' : `Week of ${fmtDay(formatISO(pageStart))}`}</span>
              <button onClick={() => setWeekOffset((n) => n + 1)} style={{ ...BTN.secondary.sm, padding: '2px 7px' }} title="Next week">›</button>
            </div>
            <div style={{ overflowY: 'auto', padding: 6, flex: 1 }}>
              {rest.map(([iso, list]) => (
                <DropZone key={iso} id={`day:${iso}`} style={{ marginBottom: 8, borderRadius: 8, padding: 4 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#64748b', margin: '2px 4px 4px', display: 'flex', gap: 6 }}>
                    <span>{fmtDay(iso)}</span>
                    <span style={{ fontWeight: 500, color: '#94a3b8' }}>{Math.round(list.reduce((s, x) => s + x.hours, 0) * 10) / 10}h</span>
                  </div>
                  {list.length === 0 && <div style={{ fontSize: 11.5, color: '#e2e8f0', padding: '0 4px 4px' }}>—</div>}
                  {list.map((x) => <Draggable key={x.key} id={x.key} disabled={x.type === 'block'}><Tile x={x} /></Draggable>)}
                </DropZone>
              ))}
            </div>
            <div style={{ padding: '6px 10px', fontSize: 11, color: '#94a3b8', borderTop: '1px solid #e5e7eb' }}>Drop a tile on a day to move it there.</div>
          </div>
        </div>
        {/* A quiet key for the tile colours (Bobby, 2026-09-27). */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', padding: '6px 4px 0', fontSize: 11, color: '#94a3b8', fontFamily: font }}>
          {[
            [KIND_COLOUR.work, 'solid', 'Workflow work'],
            [KIND_COLOUR.comms, 'solid', 'Client step'],
            [KIND_COLOUR.milestone, 'solid', 'Milestone'],
            [KIND_COLOUR.calendar, 'solid', 'Meeting'],
            ['#7c3aed', 'solid', 'BrightManager job'],
            ['#7c3aed', 'dashed', 'BM job in draft'],
            ['#0f766e', 'solid', 'Block'],
            ['#38bdf8', 'dashed', 'Quick task'],
            ['#f59e0b', 'dashed', 'Covering for someone'],
          ].map(([c, style, label]) => (
            <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, border: `2px ${style} ${c}`, background: style === 'solid' ? c : '#fff', boxSizing: 'border-box' }} />{label}
            </span>
          ))}
        </div>
      </div>

      <DragOverlay dropAnimation={null}>{active ? <div style={{ width: 240, pointerEvents: 'none' }}><Tile x={active} compact /></div> : null}</DragOverlay>
      <ContextMenu menu={menu} onClose={closeMenu} />
      {ask && <MinutesModal ask={ask} onClose={() => setAsk(null)} />}
      {reschedule && (
        <div onClick={() => setReschedule(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.2)', zIndex: 125, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, padding: 18, width: 340, maxWidth: '92vw', fontFamily: font, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 2 }}>Reschedule</div>
            <div style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>{reschedule.title}{reschedule.client ? ` · ${reschedule.client}` : ''} · now {fmtDay(reschedule.date)}</div>
            <input type="date" defaultValue={reschedule.date} id="reschedule-date" autoFocus style={{ padding: '7px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 8 }} />
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 14 }}>
              <button onClick={() => setReschedule(null)} style={BTN.secondary.sm}>Cancel</button>
              <button onClick={() => { const v = document.getElementById('reschedule-date')?.value; if (!v) return; const x = reschedule; setReschedule(null); moveTo(x, v).then(load).catch((er) => setError(er.message)); }} style={BTN.primary.sm}>Move</button>
            </div>
          </div>
        </div>
      )}
      {email && <EmailModal ctx={{ entity_id: email.entity_id, entity_name: email.client, task_label: email.title }} staffList={staffList} profile={profile} onClose={() => setEmail(null)} onSent={load} />}
      {selectorOpen && <JobSelectorModal staffList={staffList} entityMap={entityMap} profile={profile} teamFilter={personId} defaultDate={day} onScheduled={load} onClose={onSelectorClose} />}
    </DndContext>
  );
}
