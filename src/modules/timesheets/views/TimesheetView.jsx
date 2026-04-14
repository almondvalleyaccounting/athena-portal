import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import {
  fetchCompletedForWeek, fetchTimesheetEntries, upsertTimesheetEntry,
  fetchScheduledForStaff, fetchStaffList, fetchEntities,
} from '../lib/timesheetQueries';

/* ─── Helpers ──────────────────────────────────────────────── */
function startOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay(); // 0=Sun
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function formatISO(d) {
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

function formatShort(d) {
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatWeekTitle(start) {
  const end = addDays(start, 6);
  return `${start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} — ${end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

function minutesToDisplay(mins) {
  if (!mins && mins !== 0) return '';
  if (mins === 0) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* ─── TimesheetView ───────────────────────────────────────── */
export default function TimesheetView() {
  const { profile } = useAuth();

  const [staffList, setStaffList] = useState([]);
  const [entityList, setEntityList] = useState([]);
  const [selectedStaff, setSelectedStaff] = useState(profile?.id || '');
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const [completedTasks, setCompletedTasks] = useState([]);
  const [manualEntries, setManualEntries] = useState([]);
  const [scheduledTasks, setScheduledTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState('client'); // 'client' | 'service'
  const [addingRow, setAddingRow] = useState(false);
  const [newRowClient, setNewRowClient] = useState('');
  const [newRowService, setNewRowService] = useState('');

  const weekStart = useMemo(() => startOfWeek(anchor), [anchor]);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const weekEndISO = formatISO(addDays(weekStart, 7));
  const weekStartISO = formatISO(weekStart);

  // Load staff + entities on mount
  useEffect(() => {
    (async () => {
      try {
        const [staff, ents] = await Promise.all([fetchStaffList(), fetchEntities()]);
        setStaffList(staff);
        setEntityList(ents);
        if (!selectedStaff && profile?.id) setSelectedStaff(profile.id);
      } catch (e) {
        console.error('[Timesheets] init error:', e);
      }
    })();
  }, []);

  // Load data when staff or week changes
  useEffect(() => {
    if (!selectedStaff) return;
    setLoading(true);
    (async () => {
      try {
        const [completed, manual, scheduled] = await Promise.all([
          fetchCompletedForWeek(selectedStaff, weekStartISO, weekEndISO),
          fetchTimesheetEntries(selectedStaff, weekStartISO, weekEndISO),
          fetchScheduledForStaff(selectedStaff),
        ]);
        setCompletedTasks(completed);
        setManualEntries(manual);
        setScheduledTasks(scheduled);
      } catch (e) {
        console.error('[Timesheets] load error:', e);
      }
      setLoading(false);
    })();
  }, [selectedStaff, weekStartISO, weekEndISO]);

  // Build entity map
  const entityMap = useMemo(() => {
    const m = {};
    entityList.forEach((e) => { m[e.id] = e; });
    return m;
  }, [entityList]);

  // ── Build rows: each row = unique (entity_id, service) combination ──
  const rows = useMemo(() => {
    const rowMap = new Map(); // key = `${entity_id}|${service}`

    function getRow(entityId, service) {
      const key = `${entityId || ''}|${service || ''}`;
      if (!rowMap.has(key)) {
        rowMap.set(key, {
          key,
          entityId: entityId || null,
          service: service || '',
          days: Array(7).fill(null).map(() => ({ completed: 0, manual: 0, scheduled: false })),
        });
      }
      return rowMap.get(key);
    }

    // Auto-populate from completed tasks
    completedTasks.forEach((t) => {
      const d = new Date(t.completed_at);
      const dayIdx = weekDays.findIndex((wd) => sameDay(wd, d));
      if (dayIdx >= 0) {
        const row = getRow(t.entity_id, t.service);
        row.days[dayIdx].completed += t.completion_mins || 0;
      }
    });

    // Manual entries
    manualEntries.forEach((e) => {
      const d = new Date(e.work_date + 'T00:00:00');
      const dayIdx = weekDays.findIndex((wd) => sameDay(wd, d));
      if (dayIdx >= 0) {
        const row = getRow(e.entity_id, e.service);
        row.days[dayIdx].manual += e.minutes || 0;
      }
    });

    // Scheduled placeholders — mark rows that have scheduled work this week
    scheduledTasks.forEach((m) => {
      if (!m.planned_date) return;
      const d = new Date(m.planned_date);
      d.setHours(0, 0, 0, 0);
      // Check if this task falls in the current week
      const dayIdx = weekDays.findIndex((wd) => sameDay(wd, d));
      if (dayIdx >= 0) {
        const row = getRow(m.entity_id, m.service);
        row.days[dayIdx].scheduled = true;
      }
    });

    let result = [...rowMap.values()];

    // Sort
    if (sort === 'client') {
      result.sort((a, b) => {
        const na = a.entityId ? (entityMap[a.entityId]?.name || '') : 'zzz';
        const nb = b.entityId ? (entityMap[b.entityId]?.name || '') : 'zzz';
        return na.localeCompare(nb) || a.service.localeCompare(b.service);
      });
    } else {
      result.sort((a, b) => a.service.localeCompare(b.service) || (
        (a.entityId ? (entityMap[a.entityId]?.name || '') : 'zzz').localeCompare(
          b.entityId ? (entityMap[b.entityId]?.name || '') : 'zzz'
        )
      ));
    }

    return result;
  }, [completedTasks, manualEntries, scheduledTasks, weekDays, entityMap, sort]);

  // Daily and weekly totals
  const dayTotals = useMemo(() => {
    const totals = Array(7).fill(0);
    rows.forEach((r) => {
      r.days.forEach((d, i) => { totals[i] += d.completed + d.manual; });
    });
    return totals;
  }, [rows]);

  const weekTotal = dayTotals.reduce((s, v) => s + v, 0);

  // Handle cell edit
  const handleCellEdit = useCallback(async (row, dayIdx, value) => {
    const mins = parseInt(value, 10) || 0;
    try {
      await upsertTimesheetEntry({
        staffId: selectedStaff,
        entityId: row.entityId,
        service: row.service,
        workDate: formatISO(weekDays[dayIdx]),
        minutes: mins,
      });
      // Refresh manual entries
      const updated = await fetchTimesheetEntries(selectedStaff, weekStartISO, weekEndISO);
      setManualEntries(updated);
    } catch (e) {
      console.error('[Timesheets] save error:', e);
    }
  }, [selectedStaff, weekDays, weekStartISO, weekEndISO]);

  // Add new row
  const handleAddRow = useCallback(async () => {
    if (!newRowClient && !newRowService) return;
    // Insert a zero-minute entry to create the row
    try {
      await upsertTimesheetEntry({
        staffId: selectedStaff,
        entityId: newRowClient || null,
        service: newRowService || '',
        workDate: formatISO(weekDays[0]),
        minutes: 0,
      });
      const updated = await fetchTimesheetEntries(selectedStaff, weekStartISO, weekEndISO);
      setManualEntries(updated);
      setAddingRow(false);
      setNewRowClient('');
      setNewRowService('');
    } catch (e) {
      console.error('[Timesheets] add row error:', e);
    }
  }, [selectedStaff, newRowClient, newRowService, weekDays, weekStartISO, weekEndISO]);

  const staffName = (id) => {
    const s = staffList.find((st) => st.id === id);
    return s?.name || s?.full_name || 'Unknown';
  };

  const selectedStaffName = staffName(selectedStaff);

  return (
    <div style={{ padding: '16px 20px', maxWidth: 1200 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {/* Staff selector */}
        <select
          value={selectedStaff}
          onChange={(e) => setSelectedStaff(e.target.value)}
          style={{
            padding: '6px 12px', fontSize: 13, fontFamily: "'Outfit', sans-serif",
            border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff',
            color: '#0f172a', fontWeight: 500, outline: 'none',
          }}
        >
          {staffList.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        <div style={{ width: 1, height: 20, background: '#e5e7eb' }} />

        {/* Week navigation */}
        <button onClick={() => setAnchor((p) => addDays(p, -7))} style={navBtn}><ChevronLeft size={16} /></button>
        <span style={{ fontSize: 14, fontWeight: 500, minWidth: 180, textAlign: 'center' }}>
          {formatWeekTitle(weekStart)}
        </span>
        <button onClick={() => setAnchor((p) => addDays(p, 7))} style={navBtn}><ChevronRight size={16} /></button>
        <button onClick={() => setAnchor(startOfWeek(new Date()))} style={navBtn}>Today</button>

        <div style={{ flex: 1 }} />

        {/* Sort */}
        <span style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>Sort</span>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          style={{
            padding: '4px 8px', fontSize: 12, fontFamily: "'Outfit', sans-serif",
            border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', outline: 'none',
          }}
        >
          <option value="client">Client</option>
          <option value="service">Service</option>
        </select>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>Loading timesheet...</div>
      ) : (
        <>
          {/* Grid */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  <th style={{ ...thStyle, width: 180, textAlign: 'left' }}>Client</th>
                  <th style={{ ...thStyle, width: 140, textAlign: 'left' }}>Service</th>
                  {weekDays.map((d, i) => {
                    const isToday = sameDay(d, new Date());
                    return (
                      <th key={i} style={{ ...thStyle, width: 90, textAlign: 'center', color: isToday ? '#0e7fe0' : '#64748b', fontWeight: isToday ? 700 : 600 }}>
                        <div>{DAY_NAMES[i]}</div>
                        <div style={{ fontSize: 10, fontWeight: 400 }}>{d.getDate()}</div>
                      </th>
                    );
                  })}
                  <th style={{ ...thStyle, width: 80, textAlign: 'center' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={10} style={{ padding: 32, textAlign: 'center', color: '#cbd5e1', fontSize: 13 }}>
                      No timesheet data for this week.
                    </td>
                  </tr>
                )}
                {rows.map((row) => {
                  const clientName = row.entityId ? (entityMap[row.entityId]?.name || 'Unknown') : '—';
                  const rowTotal = row.days.reduce((s, d) => s + d.completed + d.manual, 0);

                  return (
                    <tr key={row.key} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={tdStyle}>
                        <span style={{ fontWeight: 500, color: '#0f172a' }}>{clientName}</span>
                      </td>
                      <td style={tdStyle}>
                        <span style={{ color: '#64748b' }}>{row.service || '—'}</span>
                      </td>
                      {row.days.map((day, di) => {
                        const total = day.completed + day.manual;
                        const isScheduled = day.scheduled && total === 0;
                        return (
                          <td key={di} style={{ ...tdStyle, textAlign: 'center', position: 'relative' }}>
                            {total > 0 ? (
                              <span style={{ fontWeight: 500, color: '#0f172a' }}>
                                {minutesToDisplay(total)}
                              </span>
                            ) : isScheduled ? (
                              <span style={{ fontSize: 10, color: '#94a3b8', fontStyle: 'italic' }}>planned</span>
                            ) : null}
                            {day.completed > 0 && day.manual > 0 && (
                              <div style={{ fontSize: 9, color: '#94a3b8' }}>
                                {minutesToDisplay(day.completed)} + {minutesToDisplay(day.manual)}
                              </div>
                            )}
                          </td>
                        );
                      })}
                      <td style={{ ...tdStyle, textAlign: 'center', fontWeight: 600, color: '#0f172a' }}>
                        {minutesToDisplay(rowTotal)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: '#f8fafc', borderTop: '2px solid #e5e7eb' }}>
                  <td colSpan={2} style={{ ...tdStyle, fontWeight: 600, color: '#64748b' }}>Daily Total</td>
                  {dayTotals.map((t, i) => (
                    <td key={i} style={{ ...tdStyle, textAlign: 'center', fontWeight: 600, color: '#0f172a' }}>
                      {minutesToDisplay(t)}
                    </td>
                  ))}
                  <td style={{ ...tdStyle, textAlign: 'center', fontWeight: 700, color: '#0e7fe0', fontSize: 14 }}>
                    {minutesToDisplay(weekTotal)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Add row */}
          <div style={{ marginTop: 12 }}>
            {!addingRow ? (
              <button
                onClick={() => setAddingRow(true)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontSize: 12, fontWeight: 500, color: '#64748b',
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: '6px 0', fontFamily: "'Outfit', sans-serif",
                }}
              >
                <Plus size={14} /> Add row
              </button>
            ) : (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select
                  value={newRowClient}
                  onChange={(e) => setNewRowClient(e.target.value)}
                  style={selectStyle}
                >
                  <option value="">No client</option>
                  {entityList.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
                <input
                  value={newRowService}
                  onChange={(e) => setNewRowService(e.target.value)}
                  placeholder="Service..."
                  style={{
                    padding: '5px 10px', fontSize: 12, fontFamily: "'Outfit', sans-serif",
                    border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none', width: 140,
                  }}
                />
                <button onClick={handleAddRow} style={{ ...navBtn, fontSize: 12 }}>Add</button>
                <button onClick={() => setAddingRow(false)} style={{ ...navBtn, fontSize: 12, color: '#94a3b8' }}>Cancel</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const thStyle = {
  padding: '8px 10px', fontSize: 11, fontWeight: 600, color: '#64748b',
  borderBottom: '2px solid #e5e7eb', fontFamily: "'Outfit', sans-serif",
  textTransform: 'uppercase', letterSpacing: '0.03em',
};

const tdStyle = {
  padding: '8px 10px', fontSize: 12, fontFamily: "'Outfit', sans-serif",
};

const navBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  padding: '5px 10px', fontSize: 13, fontWeight: 500,
  fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb',
  borderRadius: 8, background: '#fff', color: '#1e293b',
  cursor: 'pointer', whiteSpace: 'nowrap',
};

const selectStyle = {
  padding: '5px 10px', fontSize: 12, fontFamily: "'Outfit', sans-serif",
  border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff',
  color: '#1e293b', outline: 'none',
};
