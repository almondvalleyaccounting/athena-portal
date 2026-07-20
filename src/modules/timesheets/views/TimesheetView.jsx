import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Plus, Download } from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import { SERVICES } from '../../work-planner/lib/constants';
import {
  fetchCompletedForWeek, fetchTimesheetEntries, upsertTimesheetEntry,
  deleteManualRow, fetchScheduledForStaff, fetchStaffList, fetchEntities,
  upsertCompletionOverride, clearCompletionOverride,
} from '../lib/timesheetQueries';

/* ─── Helpers ──────────────────────────────────────────────── */
function startOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function formatISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function formatWeekTitle(start) {
  const end = addDays(start, 6);
  return `${start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} — ${end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}
function minutesToDisplay(mins) {
  if (!mins) return '';
  return `${Math.round(Number(mins) || 0)}m`;
}
function minutesValue(mins) { return mins ? String(Math.round(Number(mins) || 0)) : '0'; }
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* ─── TimesheetView ───────────────────────────────────────── */
export default function TimesheetView() {
  const { profile } = useAuth();

  const [staffList, setStaffList] = useState([]);
  const [entityList, setEntityList] = useState([]);
  const [selectedStaff, setSelectedStaff] = useState('');
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const [completedTasks, setCompletedTasks] = useState([]);
  const [manualEntries, setManualEntries] = useState([]);
  const [scheduledTasks, setScheduledTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState('client');
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
        const [staff, ents] = await Promise.all([
          fetchStaffList().catch(() => []),
          fetchEntities().catch(() => []),
        ]);
        setStaffList(staff);
        setEntityList(ents);
        // Default to logged-in user
        if (profile?.id) setSelectedStaff(profile.id);
      } catch (e) {
        console.error('[Timesheets] init error:', e);
      }
      setLoading(false);
    })();
  }, [profile?.id]);

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

  const entityMap = useMemo(() => {
    const m = {};
    entityList.forEach((e) => { m[e.id] = e; });
    return m;
  }, [entityList]);

  // ── Build rows ──
  const rows = useMemo(() => {
    const rowMap = new Map();
    function getRow(entityId, service, { hasManual = false, hasCompletion = false } = {}) {
      const key = `${entityId || '_none'}|${service || '_none'}`;
      if (!rowMap.has(key)) {
        rowMap.set(key, {
          key, entityId: entityId || null, service: service || '',
          isManual: false, hasCompletion: false,
          days: Array(7).fill(null).map(() => ({ completed: 0, manual: 0, override: null, scheduled: false })),
        });
      }
      const row = rowMap.get(key);
      if (hasManual) row.isManual = true;
      if (hasCompletion) row.hasCompletion = true;
      return row;
    }

    completedTasks.forEach((t) => {
      const d = new Date(t.completed_at);
      const dayIdx = weekDays.findIndex((wd) => sameDay(wd, d));
      if (dayIdx >= 0) getRow(t.entity_id, t.service, { hasCompletion: true }).days[dayIdx].completed += t.completion_mins || 0;
    });

    manualEntries.forEach((e) => {
      const d = new Date(e.work_date + 'T00:00:00');
      const dayIdx = weekDays.findIndex((wd) => sameDay(wd, d));
      if (dayIdx < 0) return;
      if (e.source === 'override') {
        // Override wins over completion for this cell. Last one written
        // takes precedence (fetch order is work_date ASC, and the
        // override-lookup index guarantees one per cell after upsertCompletionOverride).
        getRow(e.entity_id, e.service).days[dayIdx].override = e.minutes || 0;
      } else {
        getRow(e.entity_id, e.service, { hasManual: true }).days[dayIdx].manual += e.minutes || 0;
      }
    });

    scheduledTasks.forEach((m) => {
      if (!m.planned_date) return;
      const d = new Date(m.planned_date);
      d.setHours(0, 0, 0, 0);
      const dayIdx = weekDays.findIndex((wd) => sameDay(wd, d));
      if (dayIdx >= 0) getRow(m.entity_id, m.service).days[dayIdx].scheduled = true;
    });

    let result = [...rowMap.values()];
    if (sort === 'client') {
      result.sort((a, b) => {
        const na = a.entityId ? (entityMap[a.entityId]?.name || '') : 'zzz';
        const nb = b.entityId ? (entityMap[b.entityId]?.name || '') : 'zzz';
        return na.localeCompare(nb) || a.service.localeCompare(b.service);
      });
    } else {
      result.sort((a, b) => a.service.localeCompare(b.service));
    }
    return result;
  }, [completedTasks, manualEntries, scheduledTasks, weekDays, entityMap, sort]);

  // effective minutes for a day cell: override (if set) replaces completion, then manual is added
  const effMins = (d) => (d.override != null ? d.override : d.completed) + d.manual;

  const dayTotals = useMemo(() => {
    const totals = Array(7).fill(0);
    rows.forEach((r) => r.days.forEach((d, i) => { totals[i] += effMins(d); }));
    return totals;
  }, [rows]);
  const weekTotal = dayTotals.reduce((s, v) => s + v, 0);

  // Override a completion-sourced cell (or clear the override if blank)
  const handleOverrideEdit = useCallback(async (row, dayIdx, value, origCompleted) => {
    const workDate = formatISO(weekDays[dayIdx]);
    const trimmed = (value ?? '').toString().trim();
    try {
      if (trimmed === '') {
        await clearCompletionOverride({
          staffId: selectedStaff, entityId: row.entityId, service: row.service, workDate,
        });
      } else {
        const mins = parseInt(trimmed, 10) || 0;
        if (mins === origCompleted) {
          // User typed back to the original; clear override
          await clearCompletionOverride({
            staffId: selectedStaff, entityId: row.entityId, service: row.service, workDate,
          });
        } else {
          await upsertCompletionOverride({
            staffId: selectedStaff, entityId: row.entityId, service: row.service, workDate, minutes: mins,
          });
        }
      }
      const updated = await fetchTimesheetEntries(selectedStaff, weekStartISO, weekEndISO);
      setManualEntries(updated);
    } catch (e) {
      console.error('[Timesheets] override error:', e);
    }
  }, [selectedStaff, weekDays, weekStartISO, weekEndISO]);

  // Edit a manual cell
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
      const updated = await fetchTimesheetEntries(selectedStaff, weekStartISO, weekEndISO);
      setManualEntries(updated);
    } catch (e) {
      console.error('[Timesheets] save error:', e);
    }
  }, [selectedStaff, weekDays, weekStartISO, weekEndISO]);

  // Delete a manual row (all entries for that entity+service in the week)
  const handleDeleteRow = useCallback(async (row) => {
    if (!window.confirm(`Delete manual row "${row.entityId ? (entityList.find((e) => e.id === row.entityId)?.name || 'Unknown') : '—'} / ${row.service || '—'}"?`)) return;
    try {
      const deleted = await deleteManualRow(selectedStaff, row.entityId, row.service, weekStartISO, weekEndISO);
      const hadEntries = (row.days || []).some((d) => (d?.manual || 0) > 0 || d?.override != null);
      if (deleted === 0 && hadEntries) {
        window.alert('Nothing was deleted — these entries belong to someone else or fall in a locked period.');
      }
      const updated = await fetchTimesheetEntries(selectedStaff, weekStartISO, weekEndISO);
      setManualEntries(updated);
    } catch (e) {
      console.error('[Timesheets] delete error:', e);
      window.alert(`Delete failed: ${e.message || e}`);
    }
  }, [selectedStaff, weekStartISO, weekEndISO, entityList]);

  // Add new row
  const handleAddRow = useCallback(async () => {
    if (!newRowClient && !newRowService) return;
    try {
      const entry = {
        staffId: selectedStaff,
        entityId: newRowClient || null,
        service: newRowService || null,
        workDate: formatISO(weekDays[0]),
        minutes: 0,
      };
      console.log('[Timesheets] adding manual row:', entry);
      await upsertTimesheetEntry(entry);
      const updated = await fetchTimesheetEntries(selectedStaff, weekStartISO, weekEndISO);
      setManualEntries(updated);
      setAddingRow(false);
      setNewRowClient('');
      setNewRowService('');
    } catch (e) {
      console.error('[Timesheets] add row error:', e.message || e);
    }
  }, [selectedStaff, newRowClient, newRowService, weekDays, weekStartISO, weekEndISO]);

  // Export CSV
  const handleExport = () => {
    const staffName = staffList.find((s) => s.id === selectedStaff)?.name || 'Unknown';
    const headers = ['Client', 'Service', ...weekDays.map((d) => formatISO(d)), 'Total (hrs)'];
    const csvRows = rows.map((r) => {
      const client = r.entityId ? (entityMap[r.entityId]?.name || '') : '';
      const daily = r.days.map((d) => minutesValue(effMins(d)));
      const total = minutesValue(r.days.reduce((s, d) => s + effMins(d), 0));
      return [
        `"${client.replace(/"/g, '""')}"`,
        `"${(r.service || '').replace(/"/g, '""')}"`,
        ...daily,
        total,
      ].join(',');
    });
    // Totals row
    csvRows.push(['"TOTAL"', '""', ...dayTotals.map((t) => minutesValue(t)), minutesValue(weekTotal)].join(','));

    const csv = [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `timesheet-${staffName.replace(/\s/g, '_')}-${weekStartISO}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ padding: '16px 20px', maxWidth: 1200, fontFamily: "'Outfit', sans-serif" }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {/* Staff selector */}
        <span style={labelStyle}>Staff</span>
        <select
          value={selectedStaff}
          onChange={(e) => setSelectedStaff(e.target.value)}
          style={{ ...selectStyle, fontWeight: 600, minWidth: 140 }}
        >
          {staffList.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        <div style={sepStyle} />

        {/* Week navigation */}
        <button onClick={() => setAnchor((p) => addDays(p, -7))} style={navBtn}><ChevronLeft size={16} /></button>
        <span style={{ fontSize: 14, fontWeight: 500, minWidth: 190, textAlign: 'center' }}>
          {formatWeekTitle(weekStart)}
        </span>
        <button onClick={() => setAnchor((p) => addDays(p, 7))} style={navBtn}><ChevronRight size={16} /></button>
        <button onClick={() => setAnchor(startOfWeek(new Date()))} style={navBtn}>Today</button>

        <div style={{ flex: 1 }} />

        <span style={labelStyle}>Sort</span>
        <select value={sort} onChange={(e) => setSort(e.target.value)} style={selectStyle}>
          <option value="client">Client</option>
          <option value="service">Service</option>
        </select>

        {rows.length > 0 && (
          <button onClick={handleExport} style={{ ...navBtn, gap: 5 }}>
            <Download size={13} /> Export
          </button>
        )}
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
                  <th style={{ ...thStyle, width: 32 }} />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={11} style={{ padding: 32, textAlign: 'center', color: '#cbd5e1', fontSize: 13 }}>
                      No timesheet data for this week.
                    </td>
                  </tr>
                )}
                {rows.map((row) => {
                  const clientName = row.entityId ? (entityMap[row.entityId]?.name || 'Unknown') : '—';
                  const rowTotal = row.days.reduce((s, d) => s + effMins(d), 0);
                  return (
                    <tr key={row.key} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={tdStyle}>
                        <span onClick={() => row.entityId && (window.location.href = `/clients/${row.entityId}`)} style={{ fontWeight: 500, color: row.entityId ? '#0e7fe0' : '#0f172a', cursor: row.entityId ? 'pointer' : 'default' }}>{clientName}</span>
                        {row.isManual && <span style={{ fontSize: 9, color: '#94a3b8', marginLeft: 6 }}>manual</span>}
                      </td>
                      <td style={tdStyle}><span style={{ color: '#64748b' }}>{row.service || '—'}</span></td>
                      {row.days.map((day, di) => {
                        const shown = day.override != null ? day.override : day.completed;
                        const total = shown + day.manual;
                        const isScheduled = day.scheduled && total === 0;
                        const overridden = day.override != null && day.override !== day.completed;
                        // Completion cells are editable: edits create overrides.
                        // Manual-only rows continue to use the manual entry path.
                        if (row.isManual && !row.hasCompletion) {
                          return (
                            <td key={di} style={{ ...tdStyle, textAlign: 'center' }}>
                              <input
                                type="number"
                                defaultValue={day.manual || ''}
                                placeholder={day.completed > 0 ? minutesToDisplay(day.completed) : ''}
                                onBlur={(e) => {
                                  const mins = parseInt(e.target.value, 10) || 0;
                                  if (mins !== day.manual) handleCellEdit(row, di, e.target.value);
                                }}
                                onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                                style={cellInput}
                              />
                            </td>
                          );
                        }
                        if (row.hasCompletion) {
                          return (
                            <td key={di} style={{ ...tdStyle, textAlign: 'center' }}>
                              {day.completed > 0 || day.override != null ? (
                                <input
                                  type="number"
                                  key={`${row.key}|${di}|${day.override}|${day.completed}`}
                                  defaultValue={shown > 0 ? shown : ''}
                                  onBlur={(e) => handleOverrideEdit(row, di, e.target.value, day.completed)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                                  title={overridden ? `Original: ${minutesToDisplay(day.completed) || '0m'} · overridden. Clear cell to revert.` : 'Editable — saves as override'}
                                  style={{
                                    ...cellInput,
                                    color: overridden ? '#0e7fe0' : '#0f172a',
                                    fontWeight: overridden ? 600 : 500,
                                    borderColor: overridden ? '#bae6fd' : '#e5e7eb',
                                    background: overridden ? '#f0f9ff' : '#fff',
                                  }}
                                />
                              ) : isScheduled ? (
                                <span style={{ fontSize: 10, color: '#94a3b8', fontStyle: 'italic' }}>planned</span>
                              ) : null}
                            </td>
                          );
                        }
                        return (
                          <td key={di} style={{ ...tdStyle, textAlign: 'center' }}>
                            {total > 0 ? (
                              <span style={{ fontWeight: 500, color: '#0f172a' }}>{minutesToDisplay(total)}</span>
                            ) : isScheduled ? (
                              <span style={{ fontSize: 10, color: '#94a3b8', fontStyle: 'italic' }}>planned</span>
                            ) : null}
                          </td>
                        );
                      })}
                      <td style={{ ...tdStyle, textAlign: 'center', fontWeight: 600, color: '#0f172a' }}>
                        {minutesToDisplay(rowTotal)}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'center', width: 32 }}>
                        {row.isManual && (
                          <button
                            onClick={() => handleDeleteRow(row)}
                            title="Delete manual row"
                            style={{
                              background: 'none', border: 'none', cursor: 'pointer',
                              padding: 2, opacity: 0.3, transition: 'opacity 0.15s',
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.3'; }}
                          >
                            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                              <path d="M2 4h10M5 4V3a1 1 0 011-1h2a1 1 0 011 1v1M11 4v7a1 1 0 01-1 1H4a1 1 0 01-1-1V4" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: '#f8fafc', borderTop: '2px solid #e5e7eb' }}>
                  <td colSpan={2} style={{ ...tdStyle, fontWeight: 600, color: '#64748b' }}>Daily Total</td>
                  {dayTotals.map((t, i) => (
                    <td key={i} style={{ ...tdStyle, textAlign: 'center', fontWeight: 600, color: '#0f172a' }}>{minutesToDisplay(t)}</td>
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
              <button onClick={() => setAddingRow(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer', padding: '6px 0', fontFamily: "'Outfit', sans-serif" }}>
                <Plus size={14} /> Add manual row
              </button>
            ) : (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={newRowClient} onChange={(e) => setNewRowClient(e.target.value)} style={{ ...selectStyle, minWidth: 160 }}>
                  <option value="">— Select client —</option>
                  {entityList.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
                <select value={newRowService} onChange={(e) => setNewRowService(e.target.value)} style={{ ...selectStyle, minWidth: 140 }}>
                  <option value="">— Select service —</option>
                  {SERVICES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <button onClick={handleAddRow} disabled={!newRowClient && !newRowService} style={{ ...navBtn, fontSize: 12, opacity: (!newRowClient && !newRowService) ? 0.4 : 1 }}>Add</button>
                <button onClick={() => { setAddingRow(false); setNewRowClient(''); setNewRowService(''); }} style={{ ...navBtn, fontSize: 12, color: '#94a3b8' }}>Cancel</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const thStyle = { padding: '8px 10px', fontSize: 11, fontWeight: 600, color: '#64748b', borderBottom: '2px solid #e5e7eb', fontFamily: "'Outfit', sans-serif", textTransform: 'uppercase', letterSpacing: '0.03em' };
const tdStyle = { padding: '8px 10px', fontSize: 12, fontFamily: "'Outfit', sans-serif" };
const navBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '5px 10px', fontSize: 13, fontWeight: 500, fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', color: '#1e293b', cursor: 'pointer', whiteSpace: 'nowrap' };
const selectStyle = { padding: '5px 10px', fontSize: 12, fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#1e293b', outline: 'none' };
const labelStyle = { fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.03em' };
const sepStyle = { width: 1, height: 20, background: '#e5e7eb' };
const cellInput = {
  width: 50, padding: '3px 4px', fontSize: 12, textAlign: 'center',
  border: '1px solid #e5e7eb', borderRadius: 4, outline: 'none',
  fontFamily: "'Outfit', sans-serif",
};
