import React, { useRef, useCallback } from 'react';
import { TIME_SLOTS, CALENDAR_VIEWS } from '../lib/constants';
import {
  sameDay, addDays, addMonths, startOfWeek, today,
  formatDateFull, formatDateShort, formatISO, formatTime,
  teamColour, tileColour, durFmt, clientName,
} from '../lib/helpers';
import { generateInstances } from '../lib/instanceEngine';
import StatusIcon from '../components/StatusIcon';
import { useWorkPlanner } from '../WorkPlannerModule';

export default function CalendarView({ calendarView, anchor, onAction }) {
  const {
    scheduledTasks, overridesMap, completedKeys,
    quickTasks, staffMap, entityMap,
    filters, highlightId,
    updateScheduledTask, saveOverride, deleteOverride, updateQuickTask,
    colourMode, staffColours, statusColours,
  } = useWorkPlanner();

  // ── Drag state: refs only, NO React state during drag ──
  const rootRef = useRef(null);
  const dragDataRef = useRef(null); // { taskId, taskType }

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

  // Apply filters
  if (filters.teamFilter) allInstances = allInstances.filter((t) => t.assignee_id === filters.teamFilter);
  if (filters.clientFilter) allInstances = allInstances.filter((t) => t.entity_id === filters.clientFilter);
  if (filters.serviceFilter) allInstances = allInstances.filter((t) => t.service === filters.serviceFilter);
  if (filters.statusFilter) allInstances = allInstances.filter((t) => t.status === filters.statusFilter);

  // Quick tasks
  let quickFiltered = quickTasks.filter(Boolean);
  if (filters.teamFilter) quickFiltered = quickFiltered.filter((t) => t.assignee_id === filters.teamFilter);
  if (filters.clientFilter) quickFiltered = quickFiltered.filter((t) => t.entity_id === filters.clientFilter);
  if (filters.serviceFilter) quickFiltered = quickFiltered.filter((t) => t.service === filters.serviceFilter);

  const quickUnplanned = quickFiltered.filter((t) => !t.planned_date || new Date(t.planned_date) < now);
  const quickPlanned = quickFiltered.filter((t) => t.planned_date && new Date(t.planned_date) >= now);
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

  // ── Drag handlers: NO React state changes during drag ──

  const handleDragStart = useCallback((e, taskId, taskType) => {
    dragDataRef.current = { taskId, taskType };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', taskId);

    // CRITICAL: defer DOM changes by one animation frame so the browser
    // can capture the ghost image and fully initiate the drag first
    requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) return;
      root.classList.add('planner-root--dragging');
      const tile = root.querySelector(`[data-task-id="${taskId}"]`);
      if (tile) tile.classList.add('cal-tile--drag-source');
    });
  }, []);

  const handleCellDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('cal-cell--drop-target');
  }, []);

  const handleCellDragLeave = useCallback((e) => {
    e.currentTarget.classList.remove('cal-cell--drop-target');
  }, []);

  const handleSidebarDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('unplanned-zone--drop-target');
  }, []);

  const handleSidebarDragLeave = useCallback((e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      e.currentTarget.classList.remove('unplanned-zone--drop-target');
    }
  }, []);

  function cleanupDrag() {
    dragDataRef.current = null;
    const root = rootRef.current;
    if (!root) return;
    root.classList.remove('planner-root--dragging');
    root.querySelectorAll('.cal-tile--drag-source').forEach((el) => el.classList.remove('cal-tile--drag-source'));
    root.querySelectorAll('.cal-cell--drop-target').forEach((el) => el.classList.remove('cal-cell--drop-target'));
    root.querySelectorAll('.unplanned-zone--drop-target').forEach((el) => el.classList.remove('unplanned-zone--drop-target'));
  }

  const handleDragEnd = useCallback(() => { cleanupDrag(); }, []);

  const handleDropOnCell = useCallback((e, date, h, m) => {
    e.preventDefault();
    const drag = dragDataRef.current;
    if (!drag) return;
    const { taskId, taskType } = drag;

    if (taskType === 'quick') {
      const dt = new Date(date);
      dt.setHours(h != null ? h : 9, m != null ? m : 0, 0, 0);
      updateQuickTask(taskId, { planned_date: dt.toISOString() });
    } else if (taskType === 'instance') {
      const parts = taskId.split('_');
      const dateStr = parts.pop();
      const masterId = parts.join('_');
      // Update master directly — overrides are keyed by original date so
      // the instance engine won't find one on a different date
      updateScheduledTask(masterId, {
        planned_date: date.toISOString(),
        planned_hour: h != null ? h : 9,
        planned_min: m != null ? m : 0,
      });
    } else if (taskType === 'sched') {
      updateScheduledTask(taskId, {
        planned_date: date.toISOString(),
        planned_hour: h != null ? h : 9,
        planned_min: m != null ? m : 0,
      });
    }
    cleanupDrag();
  }, [updateQuickTask, saveOverride, updateScheduledTask]);

  const handleDropOnUnplanned = useCallback((e) => {
    e.preventDefault();
    const drag = dragDataRef.current;
    if (!drag) return;
    const { taskId, taskType } = drag;

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
    cleanupDrag();
  }, [updateQuickTask, deleteOverride, updateScheduledTask]);

  // Resize handler (unchanged — uses mousedown/mousemove, not DnD)
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

  // ── Sidebar ──
  const sidebar = (
    <div
      className="unplanned-zone"
      style={{
        width: 260, borderRight: '1px solid #e5e7eb', background: '#fff',
        display: 'flex', flexDirection: 'column', flexShrink: 0,
        fontFamily: "'Outfit', sans-serif",
      }}
      onDragOver={handleSidebarDragOver}
      onDragLeave={handleSidebarDragLeave}
      onDrop={handleDropOnUnplanned}
    >
      <div style={{
        padding: '8px 10px', fontSize: 11, fontWeight: 600, color: '#94a3b8',
        textTransform: 'uppercase', letterSpacing: '0.4px',
        borderBottom: '1px solid #e5e7eb',
        transition: 'all 0.15s',
      }}>
        Unplanned ({unplannedMasters.length})
      </div>

      <div style={{ overflowY: 'auto', padding: 5, maxHeight: quickUnplanned.length > 0 ? '50%' : undefined }}>
        {unplannedMasters.map((t) => (
          <div
            key={t.id}
            className="cal-tile"
            data-task-id={t.id}
            draggable
            onDragStart={(e) => { e.stopPropagation(); handleDragStart(e, t.id, 'sched'); }}
            onDragEnd={handleDragEnd}
            onClick={(e) => { e.stopPropagation(); onAction(e, t); }}
            style={{
              padding: '4px 8px', marginBottom: 3, background: '#fff',
              border: '1px solid #e5e7eb',
              borderLeft: `3px solid ${t.assignee_id ? teamColour(t.assignee_id) : '#0e7fe0'}`,
              borderRadius: 5, fontSize: 12, cursor: 'grab', transition: 'opacity 0.12s',
              boxShadow: highlightId === t.id ? '0 0 0 2px #dbeafe' : 'none',
            }}
          >
            <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 3 }}>
              <StatusIcon status={t.status} size={9} />
              {t.title}
            </div>
            <div style={{ fontSize: 11, color: '#64748b' }}>
              {staffMap[t.assignee_id]?.name?.split(' ')[0] || 'Unassigned'} &middot; {durFmt(t.duration)}
            </div>
          </div>
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
              <div
                key={t.id}
                className="cal-tile"
                data-task-id={t.id}
                draggable
                onDragStart={(e) => { e.stopPropagation(); handleDragStart(e, t.id, 'quick'); }}
                onDragEnd={handleDragEnd}
                onClick={(e) => { e.stopPropagation(); onAction(e, { ...t, _isQuick: true }); }}
                style={{
                  padding: '4px 8px', marginBottom: 3, background: '#f1f5f9',
                  border: '1px solid #e5e7eb', borderLeft: '3px solid #94a3b8',
                  borderRadius: 5, fontSize: 12, cursor: 'grab', transition: 'opacity 0.12s',
                  boxShadow: highlightId === t.id ? '0 0 0 2px #dbeafe' : 'none',
                }}
              >
                <div style={{ fontWeight: 500, fontSize: 12 }}>{t.title}</div>
                <div style={{ fontSize: 11, color: '#64748b' }}>
                  {staffMap[t.assignee_id]?.name?.split(' ')[0] || 'Unassigned'}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );

  // ── Month view ──
  if (calendarView === 'month') {
    return (
      <div ref={rootRef} className="planner-root" style={{ display: 'flex', height: '100%' }}>
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
                <div
                  key={i}
                  className="cal-cell"
                  style={{
                    borderRight: '1px solid #f1f5f9', borderBottom: '1px solid #f1f5f9',
                    padding: 3, minHeight: 68, overflow: 'hidden',
                    opacity: isOther ? 0.3 : 1,
                    background: isToday ? '#eff6ff' : 'transparent',
                    fontFamily: "'Outfit', sans-serif",
                  }}
                  onDragOver={handleCellDragOver}
                  onDragLeave={handleCellDragLeave}
                  onDrop={(e) => handleDropOnCell(e, d, 9, 0)}
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
                      className="cal-tile"
                      data-task-id={t._key || t.id}
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
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // ── Grid view (day/3day/workweek/week) ──
  const cols = days.length;

  return (
    <div ref={rootRef} className="planner-root" style={{ display: 'flex', height: '100%' }}>
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
                {/* Time label */}
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

                {/* Day cells */}
                {days.map((d, di) => {
                  const cellKey = `${di}-${si}`;

                  // Events starting at this slot
                  const cellEvents = eventsOnDay(d).filter(
                    (t) => t.planned_hour === slot.h && (t.planned_min || 0) === slot.m
                  );
                  // Quick tasks — match by their planned_date hour/min
                  const cellQuick = quickOnDay(d).filter((t) => {
                    const hm = quickHourMin(t);
                    const snappedMin = Math.floor(hm.m / 15) * 15;
                    return hm.h === slot.h && snappedMin === slot.m;
                  });

                  return (
                    <div
                      key={cellKey}
                      className="cal-cell"
                      style={{
                        borderRight: '1px solid #f1f5f9',
                        borderBottom: `1px solid ${isHourBottom ? '#e5e7eb' : '#f1f5f9'}`,
                        position: 'relative', minHeight: 18,
                      }}
                      onDragOver={handleCellDragOver}
                      onDragLeave={handleCellDragLeave}
                      onDrop={(e) => handleDropOnCell(e, d, slot.h, slot.m)}
                    >
                      {cellEvents.map((t) => {
                        const span = Math.max(1, Math.round((t.duration || 30) / 15));
                        const isHl = highlightId === t.id;
                        const tileId = t._key || t.id;

                        return (
                          <div
                            key={t.id}
                            className="cal-tile"
                            data-task-id={tileId}
                            draggable
                            onDragStart={(e) => { e.stopPropagation(); handleDragStart(e, tileId, t._instance ? 'instance' : 'sched'); }}
                            onDragEnd={handleDragEnd}
                            onClick={(e) => { e.stopPropagation(); onAction(e, t); }}
                            style={{
                              position: 'absolute', left: 1, right: 1, top: 0,
                              padding: '1px 4px', borderRadius: 3,
                              fontSize: 11, fontWeight: 500, color: '#fff',
                              background: tileColour(t, colourMode, staffColours, statusColours),
                              height: `${span * 18 - 1}px`,
                              overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                              zIndex: isHl ? 5 : 1,
                              boxShadow: isHl
                                ? '0 0 0 2px #0e7fe0'
                                : '0 1px 2px rgba(0,0,0,0.04)',
                              display: 'flex', alignItems: 'center', gap: 2,
                              cursor: 'grab',
                            }}
                          >
                            <StatusIcon status={t.status} dark size={9} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                              {t.title}
                            </span>
                            {t._hasOverride && (
                              <span style={{
                                position: 'absolute', top: 1, right: 2,
                                width: 5, height: 5, borderRadius: '50%', background: '#f59e0b',
                              }} />
                            )}
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
                          </div>
                        );
                      })}

                      {cellQuick.map((t) => {
                        const isHl = highlightId === t.id;
                        const qSpan = Math.max(1, Math.round((t.duration || 15) / 15));
                        return (
                          <div
                            key={t.id}
                            className="cal-tile"
                            data-task-id={t.id}
                            draggable
                            onDragStart={(e) => { e.stopPropagation(); handleDragStart(e, t.id, 'quick'); }}
                            onDragEnd={handleDragEnd}
                            onClick={(e) => { e.stopPropagation(); onAction(e, { ...t, _isQuick: true }); }}
                            style={{
                              position: 'absolute', left: 1, right: 1, top: 0,
                              padding: '1px 4px', borderRadius: 3,
                              fontSize: 11, fontWeight: 500, color: '#fff',
                              background: tileColour(t, colourMode, staffColours, statusColours),
                              height: `${qSpan * 18 - 1}px`,
                              overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                              border: '1px dashed rgba(255,255,255,0.5)',
                              cursor: 'grab',
                              zIndex: isHl ? 5 : 1,
                              boxShadow: isHl ? '0 0 0 2px #0e7fe0' : 'none',
                              display: 'flex', alignItems: 'center', gap: 2,
                            }}
                          >
                            {t.title}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
