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

export default function DayPlanView({ selectorOpen, onSelectorClose, onOpenQuick, onQuickDone, onCompleteBlock }) {
  const navigate = useNavigate();
  const { staffList, staffMap, entityMap, quickTasks, scheduledTasks, overridesMap, completedKeys, blockItemsMap, filters, updateQuickTask, profile } = useWorkPlanner();
  const [day, setDay] = useState(formatISO(today()));
  const personId = filters.teamFilter || profile?.id;
  const person = staffMap[personId];
  const [milestones, setMilestones] = useState([]);
  const [bmRows, setBmRows] = useState([]);
  const [doneInAthena, setDoneInAthena] = useState({});
  const [order, setOrder] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [menu, setMenu] = useState(null);
  const [ask, setAsk] = useState(null);
  const [email, setEmail] = useState(null);
  const [active, setActive] = useState(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const dayDate = useMemo(() => new Date(`${day}T12:00:00`), [day]);
  // The rest of the week runs to Sunday; late in the week it takes next week too.
  const weekEnd = useMemo(() => {
    const sun = addDays(startOfWeek(dayDate), 6);
    return dayDate.getDay() >= 5 || dayDate.getDay() === 0 ? addDays(sun, 7) : sun;
  }, [dayDate]);
  const weekEndISO = formatISO(weekEnd);
  const backISO = formatISO(addDays(dayDate, -90));

  const load = useCallback(async () => {
    if (!personId) return;
    setLoading(true); setError(null);
    try {
      const [{ data: ms, error: mErr }, bm, { data: comps }, { data: ord }] = await Promise.all([
        supabase.from('job_milestones')
          .select('id, stage_key, label, kind, hours, owner_id, due_date, status, note, comms_sent_at, job_plans!inner(id, entity_id, period_end, status, risk, entities(name))')
          .eq('owner_id', personId).eq('status', 'pending').eq('job_plans.status', 'committed').lte('due_date', weekEndISO).order('due_date').limit(500),
        listScheduleInRange({ startISO: backISO, endISO: weekEndISO, staffIds: [personId] }),
        supabase.from('bm_task_completions').select('bm_task_schedule_id').is('confirmed_at', null).limit(1000),
        supabase.from('day_plan_order').select('keys').eq('staff_id', personId).eq('day', day).maybeSingle(),
      ]);
      if (mErr) throw mErr;
      setMilestones(ms || []);
      setBmRows((bm || []).filter((b) => b.state !== 'completed'));
      const map = {}; (comps || []).forEach((c) => { if (c.bm_task_schedule_id) map[c.bm_task_schedule_id] = true; });
      setDoneInAthena(map);
      setOrder(ord?.keys || []);
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, [personId, day, weekEndISO, backISO]);
  useEffect(() => { load(); }, [load]);

  // ── Every item as a uniform tile record ──
  const all = useMemo(() => {
    const out = [];
    milestones.forEach((m) => out.push({ key: `ms:${m.id}`, type: 'ms', item: m, date: m.due_date, hours: Number(m.hours) || 0, title: m.label, client: m.job_plans?.entities?.name, entity_id: m.job_plans?.entity_id }));
    bmRows.forEach((b) => { if (!doneInAthena[b.id]) out.push({ key: `bm:${b.id}`, type: 'bm', item: b, date: b.scheduled_for_date, hours: Number(b.remaining_hours ?? b.scheduled_hours) || 0, title: shortTask(b.bm_task_name), client: entityMap[b.entity_id]?.name, entity_id: b.entity_id }); });
    quickTasks.forEach((q) => {
      if (!q.planned_date || q.assignee_id !== personId) return;
      out.push({ key: `quick:${q.id}`, type: 'quick', item: q, date: formatISO(new Date(q.planned_date)), hours: (q.duration || 15) / 60, title: q.title, client: entityMap[q.entity_id]?.name, entity_id: q.entity_id });
    });
    scheduledTasks.forEach((m) => {
      if (m.assignee_id !== personId || !m.planned_date) return;
      generateInstances(m, addDays(dayDate, -14), weekEnd, overridesMap, completedKeys).forEach((inst) => {
        out.push({ key: `block:${inst._key}`, type: 'block', item: inst, date: formatISO(inst._date), hours: (inst.duration || 0) / 60, title: inst.title, client: null, entity_id: null });
      });
    });
    return out;
  }, [milestones, bmRows, doneInAthena, quickTasks, scheduledTasks, overridesMap, completedKeys, personId, entityMap, dayDate, weekEnd]);

  const incomplete = useMemo(() => all.filter((x) => x.date < day).sort((a, b) => a.date.localeCompare(b.date)), [all, day]);
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
    all.filter((x) => x.date > day && x.date <= weekEndISO).sort((a, b) => a.date.localeCompare(b.date)).forEach((x) => { if (!groups.has(x.date)) groups.set(x.date, []); groups.get(x.date).push(x); });
    // Empty working days still get a drop target.
    for (let d = addDays(dayDate, 1); d <= weekEnd; d = addDays(d, 1)) {
      const iso = formatISO(d);
      if (!groups.has(iso) && d.getDay() !== 0 && d.getDay() !== 6) groups.set(iso, []);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [all, day, weekEndISO, dayDate, weekEnd]);
  const byKey = useMemo(() => Object.fromEntries(all.map((x) => [x.key, x])), [all]);
  const todayHours = todayList.reduce((s, x) => s + x.hours, 0);
  const cap = person ? dayCapacity(person, dayDate) : 0;

  // ── Moves (the same writes the week Planner makes) ──
  const moveTo = async (x, iso) => {
    if (x.date === iso) return;
    if (x.type === 'ms') await callJobPlan({ action: 'move_milestone', milestone_id: x.item.id, due_date: iso });
    else if (x.type === 'bm') await rescheduleTask(x.item.id, iso);
    else if (x.type === 'quick') await updateQuickTask(x.item.id, { planned_date: new Date(`${iso}T09:00:00`).toISOString() });
    else throw new Error('A standing block stays on its day; complete it or mark it not required.');
  };
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
    if (x.type === 'ms') navigate(`/planner/plan/${x.item.job_plans.entity_id}/${x.item.job_plans.period_end}`);
    else if (x.type === 'bm') { if (x.entity_id) navigate(`/clients/${x.entity_id}`); }
    else if (x.type === 'quick') onOpenQuick && onOpenQuick(x.item);
    else onCompleteBlock && onCompleteBlock(x.item);
  };
  const openMenu = (e, x) => {
    e.preventDefault(); e.stopPropagation();
    const items = [
      { label: 'Open', run: () => openFor(x) },
      { label: x.type === 'bm' ? 'Mark complete…' : x.type === 'block' ? 'Complete / log time…' : 'Done…', run: () => doneFor(x) },
    ];
    if (x.type === 'ms') items.push({ label: 'Not required (skip)', run: () => { if (window.confirm(`Skip "${x.title}" on this job?`)) act({ action: 'skip', milestone_id: x.item.id }).catch((er) => setError(er.message)); } });
    if (x.date !== day && x.type !== 'block') items.push({ label: 'Move to this day', run: () => moveTo(x, day).then(load).catch((er) => setError(er.message)) });
    if (x.entity_id) items.push({ label: 'Email…', run: () => setEmail(x) });
    setMenu({ x: e.clientX, y: e.clientY, title: `${x.title}${x.client ? ` · ${x.client}` : ''}`, items });
  };
  const closeMenu = useCallback(() => setMenu(null), []);

  // ── Tile ──
  const Tile = ({ x, showDate, compact }) => {
    const risk = x.type === 'ms' ? RISK_PILL[x.item.job_plans?.risk] : null;
    const border = x.type === 'ms' ? `3px solid ${KIND_COLOUR[x.item.kind] || '#64748b'}` : x.type === 'bm' ? `3px ${x.item.status === 'draft' ? 'dashed' : 'solid'} #7c3aed` : x.type === 'block' ? '3px solid #0f766e' : '3px dashed #38bdf8';
    const n = x.type === 'block' ? (blockItemsMap[x.item._masterId] || []).length : 0;
    return (
      <div onContextMenu={(e) => openMenu(e, x)} style={{ background: x.type === 'block' ? '#f0fdfa' : '#fff', border: '1px solid #e5e7eb', borderLeft: border, borderRadius: 7, padding: compact ? '5px 8px' : '7px 10px', marginBottom: 5, fontFamily: font }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: compact ? 12.5 : 13.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.title}</div>
          {x.hours > 0 && <div style={{ fontSize: 11.5, color: '#94a3b8', whiteSpace: 'nowrap' }}>{Math.round(x.hours * 10) / 10}h</div>}
        </div>
        <div style={{ fontSize: 11.5, color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {x.client || (x.type === 'block' ? `${kindOf(x.item.block_kind).label}${n ? ` · ${n} clients` : ''}` : 'General')}
          {showDate ? ` · ${fmtDay(x.date)}` : ''}
          {x.type === 'ms' && x.item.comms_sent_at ? ' · sent' : ''}
          {risk && <span style={{ marginLeft: 5, padding: '0 5px', borderRadius: 8, fontSize: 10, fontWeight: 600, background: risk.bg, color: risk.fg }}>{risk.label}</span>}
        </div>
        {!compact && (
          <div style={{ display: 'flex', gap: 4, marginTop: 5, flexWrap: 'wrap' }} onPointerDown={(e) => e.stopPropagation()}>
            <button onClick={() => openFor(x)} style={BTN.secondary.sm}>Open</button>
            <button onClick={() => doneFor(x)} style={BTN.primary.sm}>{x.type === 'bm' ? 'Complete' : x.type === 'block' ? 'Log time' : 'Done'}</button>
            {x.entity_id && <button onClick={() => setEmail(x)} style={BTN.secondary.sm}>Email</button>}
            {x.date !== day && x.type !== 'block' && <button onClick={() => moveTo(x, day).then(load).catch((er) => setError(er.message))} style={BTN.secondary.sm}>→ {sameDay(dayDate, today()) ? 'Today' : 'This day'}</button>}
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
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 12.5, fontWeight: 600, color: loadColour(todayHours, cap) }}>{Math.round(todayHours * 10) / 10}h planned / {Math.round(cap * 10) / 10}h</div>
          {loading && <span style={{ fontSize: 12, color: '#94a3b8' }}>Loading…</span>}
        </div>
        {error && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13 }}>{error}<button onClick={() => setError(null)} style={{ ...BTN.secondary.sm, marginLeft: 8 }}>OK</button></div>}

        <div style={{ display: 'grid', gridTemplateColumns: '260px minmax(340px, 1fr) 300px', gap: 10, flex: 1, minHeight: 0 }}>
          <div style={col}>
            <div style={colHead}>Incomplete <span style={{ fontWeight: 500, color: '#94a3b8' }}>· {incomplete.length}</span></div>
            <div style={{ overflowY: 'auto', padding: 6, flex: 1 }}>
              {incomplete.length === 0 && <div style={{ fontSize: 12.5, color: '#cbd5e1', padding: 8 }}>Nothing left over from earlier days.</div>}
              {incomplete.map((x) => <Draggable key={x.key} id={x.key} disabled={x.type === 'block'}><Tile x={x} showDate /></Draggable>)}
            </div>
            <div style={{ padding: '6px 10px', fontSize: 11, color: '#94a3b8', borderTop: '1px solid #e5e7eb' }}>Planned for an earlier day, still open. Drag into the day or use →.</div>
          </div>

          <div style={col}>
            <div style={colHead}>{sameDay(dayDate, today()) ? 'Today' : fmtDay(day)} <span style={{ fontWeight: 500, color: '#94a3b8' }}>· {todayList.length} · drag to prioritise</span></div>
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
            <div style={colHead}>Rest of the week</div>
            <div style={{ overflowY: 'auto', padding: 6, flex: 1 }}>
              {rest.map(([iso, list]) => (
                <DropZone key={iso} id={`day:${iso}`} style={{ marginBottom: 8, borderRadius: 8, padding: 4 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#64748b', margin: '2px 4px 4px', display: 'flex', gap: 6 }}>
                    <span>{fmtDay(iso)}</span>
                    <span style={{ fontWeight: 500, color: '#94a3b8' }}>{Math.round(list.reduce((s, x) => s + x.hours, 0) * 10) / 10}h</span>
                  </div>
                  {list.length === 0 && <div style={{ fontSize: 11.5, color: '#e2e8f0', padding: '0 4px 4px' }}>—</div>}
                  {list.map((x) => <Draggable key={x.key} id={x.key} disabled={x.type === 'block'}><Tile x={x} compact /></Draggable>)}
                </DropZone>
              ))}
            </div>
            <div style={{ padding: '6px 10px', fontSize: 11, color: '#94a3b8', borderTop: '1px solid #e5e7eb' }}>Drop a tile on a day to move it there.</div>
          </div>
        </div>
      </div>

      <DragOverlay dropAnimation={null}>{active ? <div style={{ width: 240, pointerEvents: 'none' }}><Tile x={active} compact /></div> : null}</DragOverlay>
      <ContextMenu menu={menu} onClose={closeMenu} />
      {ask && <MinutesModal ask={ask} onClose={() => setAsk(null)} />}
      {email && <EmailModal ctx={{ entity_id: email.entity_id, entity_name: email.client, task_label: email.title }} staffList={staffList} profile={profile} onClose={() => setEmail(null)} onSent={load} />}
      {selectorOpen && <JobSelectorModal staffList={staffList} entityMap={entityMap} profile={profile} teamFilter={personId} defaultDate={day} onScheduled={load} onClose={onSelectorClose} />}
    </DndContext>
  );
}
