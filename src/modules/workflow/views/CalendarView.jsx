import React, { useEffect, useMemo, useState } from 'react';
import { DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors, pointerWithin } from '@dnd-kit/core';
import { ChevronLeft, ChevronRight, AlertTriangle, RotateCcw } from 'lucide-react';
import { listWorkloadInWeek, listWorkloadUnscheduled, listEntities, listStaffProfiles, listAliases, rescheduleTask, clearManualOverride } from '../lib/workflowQueries';

const font = "'Outfit', sans-serif";

export default function CalendarView() {
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const [rows, setRows] = useState([]);
  const [unscheduled, setUnscheduled] = useState([]);
  const [entityMap, setEntityMap] = useState({});
  const [staffMap, setStaffMap] = useState({});
  const [aliasByStaffId, setAliasByStaffId] = useState({});
  const [aliasUnmapped, setAliasUnmapped] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const days = useMemo(() => {
    return Array.from({ length: 5 }, (_, i) => addDays(anchor, i)); // Mon–Fri
  }, [anchor]);

  const weekStart = iso(days[0]);
  const weekEnd = iso(days[days.length - 1]);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const [scheduled, uns, staff, aliases] = await Promise.all([
        listWorkloadInWeek(weekStart, weekEnd),
        listWorkloadUnscheduled(),
        listStaffProfiles(),
        listAliases(),
      ]);

      const entityIds = [
        ...scheduled.map((r) => r.entity_id),
        ...uns.map((r) => r.entity_id),
      ].filter(Boolean);
      const ents = await listEntities(entityIds);

      const staffById = {};
      for (const s of staff) staffById[s.id] = s;

      const byStaff = {};
      const unmapped = [];
      for (const a of aliases) {
        if (a.staff_profile_id) byStaff[a.staff_profile_id] = a;
        else if (a.active) unmapped.push(a);
      }

      setRows(scheduled);
      setUnscheduled(uns);
      setEntityMap(ents);
      setStaffMap(staffById);
      setAliasByStaffId(byStaff);
      setAliasUnmapped(unmapped);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart]);

  // Group scheduled rows by (assignee_id or raw BM name) × day
  const grid = useMemo(() => {
    const byStaffer = new Map();
    for (const row of rows) {
      const key = row.assignee_id || `bm:${row.bm_assignee_name || 'Unknown'}`;
      if (!byStaffer.has(key)) {
        byStaffer.set(key, {
          key,
          assignee_id: row.assignee_id,
          display: row.assignee_id
            ? (staffMap[row.assignee_id]?.name || 'Staff')
            : (row.bm_assignee_name || 'Unknown BM staff'),
          unmapped: !row.assignee_id,
          days: Array.from({ length: 5 }, () => []),
        });
      }
      const staffer = byStaffer.get(key);
      const dayIdx = days.findIndex((d) => iso(d) === row.scheduled_for_date);
      if (dayIdx >= 0) staffer.days[dayIdx].push(row);
    }
    return Array.from(byStaffer.values()).sort((a, b) => {
      if (a.unmapped !== b.unmapped) return a.unmapped ? 1 : -1; // mapped first
      return (a.display || '').localeCompare(b.display || '');
    });
  }, [rows, days, staffMap]);

  const totalHoursInWeek = rows.reduce((s, r) => s + Number(r.remaining_hours || 0), 0);

  const handleDragEnd = async (event) => {
    const { active, over } = event;
    if (!over || !active) return;
    const taskId = String(active.id);
    const dropId = String(over.id);
    if (!dropId.startsWith('cell:')) return;
    const parts = dropId.split(':');
    const newDate = parts[parts.length - 1]; // YYYY-MM-DD
    const task = rows.find((r) => r.id === taskId) || unscheduled.find((r) => r.id === taskId);
    if (!task) return;
    if (task.scheduled_for_date === newDate) return; // no-op
    // Optimistic update
    setRows((prev) => {
      const existing = prev.find((r) => r.id === taskId);
      if (existing) {
        return prev.map((r) => r.id === taskId ? { ...r, scheduled_for_date: newDate, manually_overridden_at: new Date().toISOString() } : r);
      }
      return [...prev, { ...task, scheduled_for_date: newDate, manually_overridden_at: new Date().toISOString() }];
    });
    setUnscheduled((prev) => prev.filter((r) => r.id !== taskId));
    try {
      await rescheduleTask(taskId, newDate);
    } catch (e) {
      setError(e.message || String(e));
      reload();
    }
  };

  const undoOverride = async (task) => {
    setError(null);
    try {
      await clearManualOverride(task.id);
      reload();
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  return (
    <div style={{ padding: '20px 28px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <p style={{ fontSize: 13, color: '#475569', maxWidth: 760 }}>
            Preview of the auto-scheduled workload. Each cell shows <b>remaining hours</b> (planned minus time already logged via <code>source_task_id</code>). Blocks shrink as work progresses.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => setAnchor(addDays(anchor, -7))} style={btnGhost}><ChevronLeft size={14} /></button>
          <button onClick={() => setAnchor(startOfWeek(new Date()))} style={btnSecondary}>This week</button>
          <button onClick={() => setAnchor(addDays(anchor, 7))} style={btnGhost}><ChevronRight size={14} /></button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', fontSize: 12, color: '#475569' }}>
        <span>Week of <b>{fmtDate(days[0])}</b></span>
        <span>·</span>
        <span><b>{rows.length}</b> planned tasks</span>
        <span>·</span>
        <span><b>{totalHoursInWeek.toFixed(1)}h</b> remaining</span>
        {unscheduled.length > 0 && (<><span>·</span><span style={{ color: '#92400e' }}><b>{unscheduled.length}</b> unscheduled</span></>)}
        {aliasUnmapped.length > 0 && (<><span>·</span><span style={{ color: '#92400e' }}><b>{aliasUnmapped.length}</b> unmapped BM staff</span></>)}
      </div>

      {error && (
        <div style={banner('red')}>
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8' }}>Loading…</p>
      ) : (
        <>
          {rows.length === 0 && unscheduled.length === 0 ? (
            <EmptyState />
          ) : (
            <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={handleDragEnd}>
              {rows.length > 0 && (
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '180px repeat(5, 1fr)', borderBottom: '1px solid #e5e7eb', background: '#f8fafc' }}>
                    <div style={headerCell}>Staff</div>
                    {days.map((d) => (
                      <div key={iso(d)} style={{ ...headerCell, textAlign: 'center' }}>
                        <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase' }}>
                          {d.toLocaleDateString('en-GB', { weekday: 'short' })}
                        </div>
                        <div style={{ fontSize: 13, color: '#0f172a', fontWeight: 600 }}>
                          {d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                        </div>
                      </div>
                    ))}
                  </div>
                  {grid.map((staffer) => (
                    <div key={staffer.key} style={{ display: 'grid', gridTemplateColumns: '180px repeat(5, 1fr)', borderBottom: '1px solid #f1f5f9' }}>
                      <div style={staffCell}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{staffer.display}</div>
                        {staffer.unmapped && (
                          <div style={{ fontSize: 10, color: '#92400e', marginTop: 2 }}>Unmapped alias</div>
                        )}
                      </div>
                      {staffer.days.map((tasks, i) => {
                        const dayDate = iso(days[i]);
                        const dayHours = tasks.reduce((s, t) => s + Number(t.remaining_hours || 0), 0);
                        return (
                          <DroppableCell key={i} id={`cell:${staffer.key}:${dayDate}`}>
                            {tasks.length === 0 && (
                              <div style={{ fontSize: 10, color: '#cbd5e1' }}>—</div>
                            )}
                            {tasks.map((t) => (
                              <DraggableTile key={t.id} id={t.id} task={t} entityName={entityMap[t.entity_id]} onUndoOverride={() => undoOverride(t)} />
                            ))}
                            {tasks.length > 0 && (
                              <div style={{ fontSize: 10, color: '#94a3b8', textAlign: 'right', marginTop: 4 }}>
                                {dayHours.toFixed(1)}h total
                              </div>
                            )}
                          </DroppableCell>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}

              {unscheduled.length > 0 && (
                <div style={{ marginTop: 20 }}>
                  <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', marginBottom: 6 }}>Unscheduled tasks ({unscheduled.length})</h3>
                  <p style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>
                    Matched a rule but no date computed (usually: no deadline and no preferred week-of-month). Drag onto a calendar cell above to schedule.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
                    {unscheduled.map((t) => (
                      <DraggableTile key={t.id} id={t.id} task={t} entityName={entityMap[t.entity_id]} variant="unscheduled" />
                    ))}
                  </div>
                </div>
              )}
            </DndContext>
          )}
        </>
      )}
    </div>
  );
}

function DraggableTile({ id, task, entityName, onUndoOverride, variant }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id });
  const base = tile(task);
  const style = {
    ...base,
    minHeight: variant === 'unscheduled' ? 60 : undefined,
    opacity: isDragging ? 0.3 : 1,
    cursor: 'grab',
    userSelect: 'none',
  };
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} style={style}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {entityName || '—'}
      </div>
      <div style={{ fontSize: 10, color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {task.service}{variant === 'unscheduled' ? ` · ${task.bm_task_name}` : ''}
      </div>
      <div style={{ fontSize: 10, color: '#64748b', marginTop: 2, display: 'flex', justifyContent: 'space-between', gap: 4 }}>
        <span>{Number(task.remaining_hours).toFixed(2)}h left</span>
        {task.logged_hours > 0 && (
          <span style={{ color: '#15803d' }}>+{Number(task.logged_hours).toFixed(1)}h</span>
        )}
      </div>
      {task.manually_overridden_at && (
        <div style={{ fontSize: 9, color: '#7c3aed', marginTop: 1, fontStyle: 'italic', display: 'flex', justifyContent: 'space-between' }}>
          <span>Manually placed</span>
          {onUndoOverride && (
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onUndoOverride(); }}
              style={{ background: 'none', border: 'none', padding: 0, color: '#7c3aed', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 9 }}
              title="Clear override — next import will reschedule from rule"
            >
              <RotateCcw size={9} /> clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DroppableCell({ id, children }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{
        ...dayCell,
        background: isOver ? 'rgba(56, 189, 248, 0.15)' : 'transparent',
      }}
    >
      {children}
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{ background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: 10, padding: 32, textAlign: 'center' }}>
      <p style={{ fontSize: 13, color: '#475569', fontWeight: 500 }}>No scheduled tasks in this week yet.</p>
      <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>
        Run a BM Tasks import from Admin → Data Import to populate the workload.
      </p>
    </div>
  );
}

/* ─── date helpers ───────────────────────────────────────────── */
function startOfWeek(d) {
  const x = new Date(d);
  const dow = x.getDay(); // 0=Sun
  const diff = dow === 0 ? -6 : 1 - dow; // back to Monday
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function iso(d) { return d.toISOString().slice(0, 10); }
function fmtDate(d) { return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }

/* ─── styles ─────────────────────────────────────────────────── */
const headerCell = { padding: '10px 12px', fontSize: 11, fontWeight: 700, color: '#0f172a', borderRight: '1px solid #e5e7eb' };
const staffCell  = { padding: '10px 12px', background: '#f8fafc', borderRight: '1px solid #e5e7eb' };
const dayCell    = { padding: 6, borderRight: '1px solid #f1f5f9', minHeight: 60, display: 'flex', flexDirection: 'column', gap: 4 };

function tile(t) {
  const overdue = t.bm_deadline && new Date(t.bm_deadline) < new Date();
  return {
    padding: '6px 8px',
    borderRadius: 6,
    background: overdue ? '#fef3c7' : '#f0f9ff',
    border: `1px solid ${overdue ? '#fcd34d' : '#bae6fd'}`,
    fontFamily: font,
  };
}

const btnSecondary = { fontSize: 12, fontWeight: 500, padding: '6px 12px', background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, color: '#1e293b', cursor: 'pointer', fontFamily: font };
const btnGhost = { display: 'inline-flex', alignItems: 'center', padding: '6px 10px', background: 'none', border: '1px solid #cbd5e1', borderRadius: 6, color: '#64748b', cursor: 'pointer', fontFamily: font };

function banner(tone) {
  const tones = { red: { bg: '#fee2e2', border: '#fca5a5', color: '#991b1b' } };
  const t = tones[tone] || tones.red;
  return { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 8, background: t.bg, border: `1px solid ${t.border}`, color: t.color, fontSize: 13, marginBottom: 14 };
}
