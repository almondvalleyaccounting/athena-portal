import React, { useState, useCallback, useMemo } from 'react';
import { DndContext, DragOverlay, useDraggable, useDroppable, PointerSensor, useSensor, useSensors, pointerWithin } from '@dnd-kit/core';
import { TIME_SLOTS, CALENDAR_VIEWS } from '../lib/constants';
import {
  sameDay, addDays, addMonths, startOfWeek, today,
  formatDateFull, formatDateShort, formatISO, formatTime,
  teamColour, tileColour, durFmt, clientName, countWorkingDaysSince,
} from '../lib/helpers';
import { generateInstances } from '../lib/instanceEngine';
import StatusIcon from '../components/StatusIcon';
import { useWorkPlanner } from '../WorkPlannerModule';

/* ─── Small sub-components for dnd-kit hooks ──────────────── */

function DraggableTile({ id, taskType, children, style, onClick, anyDragActive }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    data: { taskType },
  });
  // During any active drag, non-active tiles get pointerEvents:none so the
  // pointer passes through to the DroppableCell underneath. @dnd-kit's
  // PointerSensor has already captured the active drag — it doesn't need
  // pointer events on other tiles. This prevents tall absolutely-positioned
  // tiles from blocking drop detection on cells they overflow into.
  const pe = anyDragActive && !isDragging ? 'none' : 'auto';
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={onClick}
      style={{ ...style, opacity: isDragging ? 0.2 : 1, cursor: 'grab', pointerEvents: pe }}
    >
      {children}
    </div>
  );
}

function DroppableCell({ id, children, style, className }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={className}
      style={{
        ...style,
        background: isOver ? 'rgba(56, 189, 248, 0.15)' : (style?.background || 'transparent'),
      }}
    >
      {children}
    </div>
  );
}

/* ─── Main CalendarView ───────────────────────────────────── */

export default function CalendarView({ calendarView, anchor, onAction }) {
  const {
    scheduledTasks, overridesMap, completedKeys,
    quickTasks, staffMap, entityMap,
    filters, highlightId, notesMap,
    updateScheduledTask, saveOverride, deleteOverride, updateQuickTask,
    colourMode, staffColours, statusColours,
  } = useWorkPlanner();

  const [activeTask, setActiveTask] = useState(null); // for DragOverlay

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const now = today();

  // Build day columns
  let days = [];
  if (calendarView === 'month') {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const startDay = first.getDay() === 0 ? 6 : first.getDay() - 1;
    for (let i = 0; i < 42; i++) days.push(addDays(first, i - startDay));
  } else {
    const cv = CALENDAR_VIEWS.find((v) => v.id === calendarView);
    const start = (calendarView === 'day' || calendarView === '3day')
      ? new Date(anchor) : startOfWeek(anchor);
    const dayCount = cv ? cv.days : 7;
    for (let i = 0; i < dayCount; i++) {
      const d = addDays(start, i);
      if (calendarView === 'workweek' && (d.getDay() === 0 || d.getDay() === 6)) continue;
      days.push(d);
    }
  }

  const from = days[0];
  const to = addDays(days[days.length - 1], 1);

  // Generate instances
  let allInstances = [];
  scheduledTasks.forEach((m) => {
    allInstances = allInstances.concat(generateInstances(m, from, to, overridesMap, completedKeys));
  });

  if (filters.teamFilter) allInstances = allInstances.filter((t) => t.assignee_id === filters.teamFilter);
  if (filters.clientFilter) allInstances = allInstances.filter((t) => t.entity_id === filters.clientFilter);
  if (filters.serviceFilter) allInstances = allInstances.filter((t) => t.service === filters.serviceFilter);
  if (filters.statusFilter) allInstances = allInstances.filter((t) => t.status === filters.statusFilter);

  let quickFiltered = quickTasks.filter(Boolean);
  if (filters.teamFilter) quickFiltered = quickFiltered.filter((t) => t.assignee_id === filters.teamFilter);
  if (filters.clientFilter) quickFiltered = quickFiltered.filter((t) => t.entity_id === filters.clientFilter);
  if (filters.serviceFilter) quickFiltered = quickFiltered.filter((t) => t.service === filters.serviceFilter);

  // Split quick tasks: show on calendar if planned_date is within visible range,
  // otherwise show in sidebar. Uses the calendar's visible start date (from),
  // NOT today — so tasks on past-but-visible days (e.g. Monday when today is
  // Tuesday in workweek view) appear on the calendar, not the sidebar.
  const quickUnplanned = quickFiltered.filter((t) => !t.planned_date || new Date(t.planned_date) < from);
  const quickPlanned = quickFiltered.filter((t) => t.planned_date && new Date(t.planned_date) >= from);
  const unplannedMasters = scheduledTasks.filter((m) => {
    if (m.planned_date) return false;
    if (filters.teamFilter && m.assignee_id !== filters.teamFilter) return false;
    if (filters.clientFilter && m.entity_id !== filters.clientFilter) return false;
    if (filters.serviceFilter && m.service !== filters.serviceFilter) return false;
    if (filters.statusFilter && m.status !== filters.statusFilter) return false;
    return true;
  });

  function eventsOnDay(d) { return allInstances.filter((t) => sameDay(t.planned_date, d)); }
  function quickOnDay(d) { return quickPlanned.filter((t) => sameDay(t.planned_date, d)); }
  function quickHourMin(task) {
    if (!task.planned_date) return { h: 9, m: 0 };
    const dt = new Date(task.planned_date);
    return { h: dt.getHours(), m: dt.getMinutes() };
  }

  // Build a lookup of all tasks by their drag id for the DragOverlay
  const taskLookup = useMemo(() => {
    const map = {};
    allInstances.forEach((t) => { map[t._key || t.id] = t; });
    quickPlanned.forEach((t) => { map[t.id] = t; });
    quickUnplanned.forEach((t) => { map[t.id] = t; });
    unplannedMasters.forEach((t) => { map[t.id] = t; });
    return map;
  }, [allInstances, quickPlanned, quickUnplanned, unplannedMasters]);

  // ── dnd-kit callbacks ──

  const handleDragStart = useCallback((event) => {
    const task = taskLookup[event.active.id];
    setActiveTask(task || null);
  }, [taskLookup]);

  const handleDragEnd = useCallback((event) => {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;

    const taskId = active.id;
    const taskType = active.data.current?.taskType;
    const dropId = String(over.id);

    if (dropId === 'unplanned') {
      // ── Drop on sidebar → unplan ──
      if (taskType === 'quick') {
        updateQuickTask(taskId, { planned_date: null });
      } else if (taskType === 'instance') {
        const parts = taskId.split('_');
        const dateStr = parts.pop();
        const masterId = parts.join('_');
        deleteOverride(masterId, dateStr);
        updateScheduledTask(masterId, { planned_date: null, planned_hour: null, planned_min: null });
      } else if (taskType === 'sched') {
        updateScheduledTask(taskId, { planned_date: null, planned_hour: null, planned_min: null });
      }
    } else if (dropId.startsWith('cell:')) {
      // ── Drop on calendar cell → plan/move ──
      // dropId format: "cell:{dayIndex}:{slotIndex}" or "cell:month:{dayIndex}"
      const parts = dropId.split(':');

      let date, h, m;
      if (parts[1] === 'month') {
        const dayIdx = parseInt(parts[2], 10);
        date = days[dayIdx];
        h = 9; m = 0;
      } else {
        const dayIdx = parseInt(parts[1], 10);
        const slotIdx = parseInt(parts[2], 10);
        date = days[dayIdx];
        h = TIME_SLOTS[slotIdx].h;
        m = TIME_SLOTS[slotIdx].m;
      }

      if (!date) return;

      if (taskType === 'quick') {
        const dt = new Date(date);
        dt.setHours(h, m, 0, 0);
        updateQuickTask(taskId, { planned_date: dt.toISOString() });
      } else if (taskType === 'instance') {
        const idParts = taskId.split('_');
        idParts.pop();
        const masterId = idParts.join('_');
        updateScheduledTask(masterId, {
          planned_date: date.toISOString(),
          planned_hour: h,
          planned_min: m,
        });
      } else if (taskType === 'sched') {
        updateScheduledTask(taskId, {
          planned_date: date.toISOString(),
          planned_hour: h,
          planned_min: m,
        });
      }
    }
  }, [days, updateQuickTask, updateScheduledTask, deleteOverride]);

  // Resize handler (mousedown/mousemove — not part of dnd-kit)
  function handleResize(e, inst) {
    e.stopPropagation();
    e.preventDefault();
    const startY = e.clientY;
    const startDur = inst.duration || 30;
    function onMove(me) {
      const diff = me.clientY - startY;
      const slotDiff = Math.round(diff / 18);
      const newDur = Math.max(15, startDur + slotDiff * 15);
      if (inst._instance) {
        saveOverride(inst._masterId, inst._date, { duration: newDur });
      } else {
        updateScheduledTask(inst.id, { duration: newDur });
      }
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ── Tile rendering helper (shared between real tiles and overlay) ──
  function renderTileContent(t, opts = {}) {
    const { isQuick, isSidebar, span } = opts;
    const bg = tileColour(t, colourMode, staffColours, statusColours);
    const isHl = highlightId === t.id || highlightId === t._key;

    // Overdue detection
    let overdue = t._overdue || null;
    if (!overdue && t.planned_date) {
      const planned = new Date(t.planned_date);
      planned.setHours(0, 0, 0, 0);
      const now = new Date(); now.setHours(0, 0, 0, 0);
      if (planned < now) {
        const wd = staffMap[t.assignee_id]?.working_days || 'mon,tue,wed,thu,fri';
        const days = countWorkingDaysSince(planned, now, wd);
        if (days >= 2) overdue = 'late';
        else if (days >= 1) overdue = 'warning';
      }
    }
    const overdueBorder = overdue ? '2px solid #f59e0b' : undefined;

    if (isSidebar && isQuick) {
      return (
        <div style={{
          padding: '4px 8px', background: '#f1f5f9',
          border: overdueBorder || '1px solid #e5e7eb', borderLeft: overdue ? '3px solid #f59e0b' : '3px solid #94a3b8',
          borderRadius: 5, fontSize: 12,
          boxShadow: isHl ? '0 0 0 2px #dbeafe' : 'none',
        }}>
          <div style={{ fontWeight: 500, fontSize: 12 }}>{t.title}</div>
          <div style={{ fontSize: 11, color: '#64748b' }}>
            {staffMap[t.assignee_id]?.name?.split(' ')[0] || 'Unassigned'}
          </div>
        </div>
      );
    }

    if (isSidebar) {
      return (
        <div style={{
          padding: '4px 8px', background: '#fff',
          border: overdueBorder || '1px solid #e5e7eb',
          borderLeft: overdue ? '3px solid #f59e0b' : `3px solid ${t.assignee_id ? (staffColours?.[t.assignee_id] || teamColour(t.assignee_id)) : '#0e7fe0'}`,
          borderRadius: 5, fontSize: 12,
          boxShadow: isHl ? '0 0 0 2px #dbeafe' : overdue ? '0 0 0 1px #f59e0b' : 'none',
        }}>
          <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 3 }}>
            <StatusIcon status={t.status} size={9} />
            {t.title}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', display: 'flex', alignItems: 'center', gap: 3 }}>
            {staffMap[t.assignee_id]?.name?.split(' ')[0] || 'Unassigned'} &middot; {durFmt(t.duration)}
            {(notesMap[`master:${t.id}`] || []).length > 0 && (
              <span style={{ background: '#f1f5f9', padding: '0 3px', borderRadius: 3, fontSize: 8, color: '#64748b', fontWeight: 600 }}>
                {(notesMap[`master:${t.id}`] || []).length}&#128221;
              </span>
            )}
          </div>
        </div>
      );
    }

    // Grid tile
    const height = span ? `${span * 18 - 1}px` : undefined;
    return (
      <div style={{
        ...(height ? { position: 'absolute', left: 1, right: 1, top: 0, height } : {}),
        padding: '1px 4px', borderRadius: 3,
        fontSize: 11, fontWeight: 500, color: '#fff', background: bg,
        overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        zIndex: isHl ? 5 : 1,
        boxShadow: overdue ? '0 0 0 2px #f59e0b' : isHl ? '0 0 0 2px #0e7fe0' : '0 1px 2px rgba(0,0,0,0.04)',
        display: 'flex', alignItems: 'center', gap: 2,
        border: overdue ? '2px solid #f59e0b' : isQuick ? '1px dashed rgba(255,255,255,0.5)' : 'none',
      }}>
        {!isQuick && <StatusIcon status={t.status} dark size={9} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
          {t.title}
        </span>
        {t._hasOverride && (
          <span style={{
            position: 'absolute', top: 1, right: 2,
            width: 5, height: 5, borderRadius: '50%', background: '#f59e0b',
          }} />
        )}
      </div>
    );
  }

  // ── Sidebar ──
  const sidebar = (
    <DroppableCell
      id="unplanned"
      style={{
        width: 260, borderRight: '1px solid #e5e7eb', background: '#fff',
        display: 'flex', flexDirection: 'column', flexShrink: 0,
        fontFamily: "'Outfit', sans-serif",
      }}
    >
      <div style={{
        padding: '8px 10px', fontSize: 11, fontWeight: 600, color: '#94a3b8',
        textTransform: 'uppercase', letterSpacing: '0.4px',
        borderBottom: '1px solid #e5e7eb',
      }}>
        Unplanned ({unplannedMasters.length})
      </div>

      <div style={{ overflowY: 'auto', padding: 5, maxHeight: quickUnplanned.length > 0 ? '50%' : undefined }}>
        {unplannedMasters.map((t) => (
          <DraggableTile
            key={t.id}
            id={t.id}
            taskType="sched"
            anyDragActive={!!activeTask}
            onClick={(e) => { e.stopPropagation(); onAction(e, t); }}
            style={{ marginBottom: 3 }}
          >
            {renderTileContent(t, { isSidebar: true })}
          </DraggableTile>
        ))}
        {unplannedMasters.length === 0 && (
          <div style={{ padding: 8, fontSize: 11, color: '#cbd5e1', textAlign: 'center' }}>All planned</div>
        )}
      </div>

      {quickUnplanned.length > 0 && (
        <>
          <div style={{
            padding: '8px 10px', fontSize: 11, fontWeight: 600, color: '#94a3b8',
            textTransform: 'uppercase', letterSpacing: '0.4px',
            borderTop: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb',
          }}>
            Quick ({quickUnplanned.length})
          </div>
          <div style={{ overflowY: 'auto', padding: 5 }}>
            {quickUnplanned.map((t) => (
              <DraggableTile
                key={t.id}
                id={t.id}
                taskType="quick"
                anyDragActive={!!activeTask}
                onClick={(e) => { e.stopPropagation(); onAction(e, { ...t, _isQuick: true }); }}
                style={{ marginBottom: 3 }}
              >
                {renderTileContent(t, { isSidebar: true, isQuick: true })}
              </DraggableTile>
            ))}
          </div>
        </>
      )}
    </DroppableCell>
  );

  // ── DragOverlay content ──
  const overlay = activeTask ? (
    <div style={{ opacity: 0.9, pointerEvents: 'none', fontFamily: "'Outfit', sans-serif" }}>
      {renderTileContent(activeTask, {
        isSidebar: !activeTask.planned_hour && activeTask.planned_hour !== 0,
        isQuick: !activeTask._instance && !activeTask.recurring && activeTask.due_date != null,
      })}
    </div>
  ) : null;

  // ── Month view ──
  if (calendarView === 'month') {
    return (
      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div style={{ display: 'flex', height: '100%' }}>
          {sidebar}
          <div style={{ flex: 1, overflow: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', height: '100%' }}>
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                <div key={d} style={{
                  padding: 4, fontSize: 12, fontWeight: 600, color: '#94a3b8',
                  textAlign: 'center', borderBottom: '1px solid #e5e7eb', background: '#fff',
                  fontFamily: "'Outfit', sans-serif",
                }}>
                  {d}
                </div>
              ))}
              {days.map((d, i) => {
                const evs = eventsOnDay(d);
                const qs = quickOnDay(d);
                const isOther = d.getMonth() !== anchor.getMonth();
                const isToday = sameDay(d, now);

                return (
                  <DroppableCell
                    key={i}
                    id={`cell:month:${i}`}
                    style={{
                      borderRight: '1px solid #f1f5f9', borderBottom: '1px solid #f1f5f9',
                      padding: 3, minHeight: 68, overflow: 'hidden',
                      opacity: isOther ? 0.3 : 1,
                      background: isToday ? '#eff6ff' : 'transparent',
                      fontFamily: "'Outfit', sans-serif",
                    }}
                  >
                    <div style={{
                      fontSize: 13, fontWeight: isToday ? 700 : 500, marginBottom: 2,
                      color: isToday ? '#0e7fe0' : '#64748b',
                    }}>
                      {d.getDate()}
                    </div>
                    {evs.slice(0, 2).map((t) => (
                      <div
                        key={t.id}
                        onClick={(e) => { e.stopPropagation(); onAction(e, t); }}
                        style={{
                          padding: '2px 4px', marginBottom: 1, borderRadius: 3,
                          fontSize: 10, fontWeight: 500, color: '#fff',
                          background: tileColour(t, colourMode, staffColours, statusColours),
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 2,
                        }}
                      >
                        <StatusIcon status={t.status} dark size={8} />
                        {t.title}
                      </div>
                    ))}
                    {qs.slice(0, 1).map((t) => (
                      <div key={t.id} style={{
                        padding: '2px 4px', marginBottom: 1, borderRadius: 3,
                        fontSize: 10, fontWeight: 500, color: '#fff',
                        background: '#64748b', opacity: 0.7,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>
                        {t.title}
                      </div>
                    ))}
                    {(evs.length + qs.length) > 3 && (
                      <div style={{ fontSize: 10, color: '#94a3b8' }}>+{evs.length + qs.length - 3}</div>
                    )}
                  </DroppableCell>
                );
              })}
            </div>
          </div>
        </div>
        <DragOverlay dropAnimation={null}>{overlay}</DragOverlay>
      </DndContext>
    );
  }

  // ── Grid view (day/3day/workweek/week) ──
  const cols = days.length;

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div style={{ display: 'flex', height: '100%' }}>
        {sidebar}
        <div style={{ flex: 1, overflow: 'auto' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: `44px${' 1fr'.repeat(cols)}`,
            gridTemplateRows: `auto${' 18px'.repeat(TIME_SLOTS.length)}`,
            minHeight: '100%',
          }}>
            {/* Top-left corner */}
            <div style={{
              background: '#fff', borderRight: '1px solid #e5e7eb',
              borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0, left: 0, zIndex: 4,
            }} />

            {/* Day headers */}
            {days.map((d, i) => (
              <div key={i} style={{
                textAlign: 'center', padding: 5, fontSize: 12, fontWeight: 600,
                color: sameDay(d, now) ? '#0e7fe0' : '#64748b',
                borderBottom: '1px solid #e5e7eb',
                borderRight: '1px solid #f1f5f9',
                background: '#fff', position: 'sticky', top: 0, zIndex: 3,
                fontFamily: "'Outfit', sans-serif",
              }}>
                {formatDateFull(d)}
              </div>
            ))}

            {/* Time slots */}
            {TIME_SLOTS.map((slot, si) => {
              const isHour = slot.m === 0;
              const isHourBottom = slot.m === 45;

              return (
                <React.Fragment key={si}>
                  <div style={{
                    padding: '1px 4px', fontSize: 10, color: isHour ? '#64748b' : '#94a3b8',
                    fontWeight: isHour ? 600 : 400,
                    textAlign: 'right', borderRight: '1px solid #e5e7eb',
                    borderBottom: `1px solid ${isHourBottom ? '#e5e7eb' : '#f1f5f9'}`,
                    background: '#fff', position: 'sticky', left: 0, zIndex: 2,
                    fontFamily: "'Outfit', sans-serif",
                  }}>
                    {isHour ? formatTime(slot.h, 0) : ''}
                  </div>

                  {days.map((d, di) => {
                    const cellEvents = eventsOnDay(d).filter(
                      (t) => t.planned_hour === slot.h && (t.planned_min || 0) === slot.m
                    );
                    const cellQuick = quickOnDay(d).filter((t) => {
                      const hm = quickHourMin(t);
                      const snappedMin = Math.floor(hm.m / 15) * 15;
                      return hm.h === slot.h && snappedMin === slot.m;
                    });

                    return (
                      <DroppableCell
                        key={`${di}-${si}`}
                        id={`cell:${di}:${si}`}
                        style={{
                          borderRight: '1px solid #f1f5f9',
                          borderBottom: `1px solid ${isHourBottom ? '#e5e7eb' : '#f1f5f9'}`,
                          position: 'relative', minHeight: 18,
                        }}
                      >
                        {cellEvents.map((t) => {
                          const span = Math.max(1, Math.round((t.duration || 30) / 15));
                          const tileId = t._key || t.id;

                          return (
                            <DraggableTile
                              key={t.id}
                              id={tileId}
                              taskType={t._instance ? 'instance' : 'sched'}
                              anyDragActive={!!activeTask}
                              onClick={(e) => { e.stopPropagation(); onAction(e, t); }}
                              style={{
                                position: 'absolute', left: 1, right: 1, top: 0,
                                height: `${span * 18 - 1}px`, zIndex: highlightId === t.id ? 5 : 1,
                              }}
                            >
                              {renderTileContent(t, { span })}
                              {/* Resize handle */}
                              <div
                                onMouseDown={(e) => handleResize(e, t)}
                                style={{
                                  position: 'absolute', left: 0, right: 0, bottom: 0,
                                  height: 8, cursor: 'ns-resize', borderRadius: '0 0 2px 2px',
                                  background: 'rgba(255,255,255,0.25)',
                                  borderTop: '1px solid rgba(255,255,255,0.35)',
                                  transition: 'background 0.12s',
                                }}
                                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.5)'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.25)'; }}
                              />
                            </DraggableTile>
                          );
                        })}

                        {cellQuick.map((t) => {
                          const qSpan = Math.max(1, Math.round((t.duration || 15) / 15));
                          return (
                            <DraggableTile
                              key={t.id}
                              id={t.id}
                              taskType="quick"
                              anyDragActive={!!activeTask}
                              onClick={(e) => { e.stopPropagation(); onAction(e, { ...t, _isQuick: true }); }}
                              style={{
                                position: 'absolute', left: 1, right: 1, top: 0,
                                height: `${qSpan * 18 - 1}px`, zIndex: highlightId === t.id ? 5 : 1,
                              }}
                            >
                              {renderTileContent(t, { span: qSpan, isQuick: true })}
                            </DraggableTile>
                          );
                        })}
                      </DroppableCell>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
      <DragOverlay dropAnimation={null}>{overlay}</DragOverlay>
    </DndContext>
  );
}
