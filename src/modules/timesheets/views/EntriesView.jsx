import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Search, ChevronUp, ChevronDown } from 'lucide-react';
import { SERVICES } from '../../work-planner/lib/constants';
import {
  fetchAllCompletedForRange, fetchAllTimesheetEntriesForRange,
  fetchStaffList, fetchEntities, fetchTimesheetLocks, isDateLocked,
  updateTimesheetEntry, deleteTimesheetEntryById,
} from '../lib/timesheetQueries';

/* ─── Helpers ──────────────────────────────────────────────── */
function formatISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function startOfMonth(d) { const r = new Date(d); r.setDate(1); r.setHours(0, 0, 0, 0); return r; }
function endOfMonth(d) { const r = new Date(d.getFullYear(), d.getMonth() + 1, 0); r.setHours(0, 0, 0, 0); return r; }
function minutesToHMM(mins) {
  const m = Math.round(Number(mins) || 0);
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, '0')}`;
}

const SOURCE_LABELS = { manual: 'Manual', override: 'Override', completed: 'Completed' };
const SOURCE_COLOURS = { manual: '#0e7fe0', override: '#d97706', completed: '#059669' };

/* ─── EntriesView ─────────────────────────────────────────── */
export default function EntriesView() {
  const navigate = useNavigate();

  const [from, setFrom] = useState(() => formatISO(startOfMonth(new Date())));
  const [to, setTo] = useState(() => formatISO(endOfMonth(new Date())));
  const [staffList, setStaffList] = useState([]);
  const [entityList, setEntityList] = useState([]);
  const [completed, setCompleted] = useState([]);
  const [entries, setEntries] = useState([]);
  const [locks, setLocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [editRow, setEditRow] = useState(null); // timesheet_entries row being edited

  // Filters
  const [staffFilter, setStaffFilter] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [serviceFilter, setServiceFilter] = useState('');
  const [search, setSearch] = useState('');

  // Sort
  const [sortKey, setSortKey] = useState('date');
  const [sortDir, setSortDir] = useState('desc');

  useEffect(() => {
    (async () => {
      try {
        const [staff, ents] = await Promise.all([
          fetchStaffList().catch(() => []),
          fetchEntities().catch(() => []),
        ]);
        setStaffList(staff);
        setEntityList(ents);
      } catch (e) { console.error('[Timesheets] entries init error:', e); }
    })();
  }, []);

  useEffect(() => {
    if (!from || !to) return;
    setLoading(true);
    (async () => {
      try {
        // Fetch functions use an exclusive upper bound — add a day to include "to"
        const toExclusive = formatISO(addDays(new Date(to + 'T00:00:00'), 1));
        const [c, e, lk] = await Promise.all([
          fetchAllCompletedForRange(from, toExclusive).catch(() => []),
          fetchAllTimesheetEntriesForRange(from, toExclusive).catch(() => []),
          fetchTimesheetLocks().catch(() => []),
        ]);
        setCompleted(c);
        setEntries(e);
        setLocks(lk || []);
      } catch (e) { console.error('[Timesheets] entries load error:', e); }
      setLoading(false);
    })();
  }, [from, to, reloadKey]);

  const entityMap = useMemo(() => { const m = {}; entityList.forEach((e) => { m[e.id] = e; }); return m; }, [entityList]);
  const staffMap = useMemo(() => { const m = {}; staffList.forEach((s) => { m[s.id] = s; }); return m; }, [staffList]);

  // Merge manual/override timesheet entries + completed tasks (same approach as DashboardView)
  const allEntries = useMemo(() => {
    const arr = [];
    completed.forEach((t) => arr.push({
      _mins: t.completion_mins || 0,
      _source: 'completed',
      _staff: t.assignee_id,
      _entity: t.entity_id,
      _date: t.completed_at ? formatISO(new Date(t.completed_at)) : '',
      _text: t.title || '',
      service: t.service || '',
      _editable: false,
    }));
    entries.forEach((e) => arr.push({
      _id: e.id,
      _mins: e.minutes || 0,
      _source: e.source === 'override' ? 'override' : 'manual',
      _staff: e.staff_id,
      _entity: e.entity_id,
      _date: e.work_date || '',
      _text: e.notes || '',
      _notes: e.notes || '',
      service: e.service || '',
      _editable: true, // timesheet_entries rows — the editable timesheet
    }));
    return arr;
  }, [completed, entries]);

  // Client options: entities present in the fetched results
  const clientOptions = useMemo(() => {
    const ids = new Set();
    allEntries.forEach((e) => { if (e._entity) ids.add(e._entity); });
    return [...ids]
      .map((id) => ({ id, name: entityMap[id]?.name || 'Unknown' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allEntries, entityMap]);

  // Apply filters
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allEntries.filter((e) => {
      if (staffFilter && e._staff !== staffFilter) return false;
      if (clientFilter && e._entity !== clientFilter) return false;
      if (serviceFilter && (e.service || '') !== serviceFilter) return false;
      if (q && !(e._text || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [allEntries, staffFilter, clientFilter, serviceFilter, search]);

  // Sort
  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const staffName = (e) => staffMap[e._staff]?.name || '';
    const clientName = (e) => (e._entity ? (entityMap[e._entity]?.name || 'Unknown') : '');
    const arr = [...filtered];
    arr.sort((a, b) => {
      switch (sortKey) {
        case 'staff': return dir * (staffName(a).localeCompare(staffName(b)) || a._date.localeCompare(b._date));
        case 'client': return dir * (clientName(a).localeCompare(clientName(b)) || a._date.localeCompare(b._date));
        case 'minutes': return dir * ((a._mins - b._mins) || a._date.localeCompare(b._date));
        case 'date':
        default: return dir * a._date.localeCompare(b._date);
      }
    });
    return arr;
  }, [filtered, sortKey, sortDir, staffMap, entityMap]);

  const totalMinutes = filtered.reduce((s, e) => s + e._mins, 0);

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'date' ? 'desc' : 'asc'); }
  };

  // CSV export (same pattern as AdminTasksPage exportCsv)
  function exportCsv() {
    const rows = sorted.map((e) => ({
      Date: e._date,
      Staff: staffMap[e._staff]?.name || '',
      Client: e._entity ? (entityMap[e._entity]?.name || 'Unknown') : '',
      Service: e.service || '',
      Minutes: Math.round(e._mins),
      'Time (h:mm)': minutesToHMM(e._mins),
      Source: SOURCE_LABELS[e._source] || e._source,
      Notes: e._text || '',
    }));
    const headers = ['Date', 'Staff', 'Client', 'Service', 'Minutes', 'Time (h:mm)', 'Source', 'Notes'];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url; a.download = `timesheet-entries-${from}-to-${to}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  const SortHeader = ({ colKey, label, align = 'left' }) => (
    <th
      onClick={() => handleSort(colKey)}
      style={{ ...thStyle, textAlign: align, cursor: 'pointer', userSelect: 'none' }}
      title="Click to sort"
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        {label}
        {sortKey === colKey && (sortDir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
      </span>
    </th>
  );

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1100, fontFamily: "'Outfit', sans-serif" }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 500, color: '#0f172a', margin: 0 }}>All Entries</h2>
        <div style={{ flex: 1 }} />
        <span style={labelStyle}>From</span>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ ...selectStyle, width: 135 }} />
        <span style={{ color: '#94a3b8', fontSize: 12 }}>to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ ...selectStyle, width: 135 }} />
        <button onClick={exportCsv} disabled={!sorted.length} style={{ ...navBtn, gap: 5, opacity: sorted.length ? 1 : 0.4 }}>
          <Download size={13} /> Export CSV
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <select value={staffFilter} onChange={(e) => setStaffFilter(e.target.value)} style={{ ...selectStyle, minWidth: 140 }}>
          <option value="">All staff</option>
          {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} style={{ ...selectStyle, minWidth: 160 }}>
          <option value="">All clients</option>
          {clientOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={serviceFilter} onChange={(e) => setServiceFilter(e.target.value)} style={{ ...selectStyle, minWidth: 140 }}>
          <option value="">All services</option>
          {SERVICES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
          <Search size={12} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
          <input
            type="text" placeholder="Search notes / task title..."
            value={search} onChange={(e) => setSearch(e.target.value)}
            style={{ ...selectStyle, width: '100%', boxSizing: 'border-box', paddingLeft: 26 }}
          />
        </div>
        <span style={{ fontSize: 11.5, color: '#94a3b8', whiteSpace: 'nowrap' }}>
          {sorted.length} {sorted.length === 1 ? 'entry' : 'entries'}
        </span>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>Loading entries...</div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  <SortHeader colKey="date" label="Date" />
                  <SortHeader colKey="staff" label="Staff" />
                  <SortHeader colKey="client" label="Client" />
                  <th style={thStyle}>Service</th>
                  <SortHeader colKey="minutes" label="Time" align="right" />
                  <th style={thStyle}>Source</th>
                  <th style={thStyle}>Notes / Title</th>
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ padding: 32, textAlign: 'center', color: '#cbd5e1', fontSize: 13 }}>
                      No entries for this range and filters.
                    </td>
                  </tr>
                )}
                {sorted.map((e, i) => {
                  const clientName = e._entity ? (entityMap[e._entity]?.name || 'Unknown') : '—';
                  const locked = isDateLocked(locks, e._date);
                  const canEdit = e._editable && !locked;
                  return (
                    <tr key={i}
                      onClick={canEdit ? () => setEditRow(e) : undefined}
                      title={canEdit ? 'Click to edit this timesheet entry' : (locked ? 'Locked period — cannot edit' : 'From completed work — not editable here')}
                      style={{ borderBottom: '1px solid #f1f5f9', cursor: canEdit ? 'pointer' : 'default' }}
                    >
                      <td style={{ ...tdStyle, whiteSpace: 'nowrap', color: '#64748b' }}>
                        {e._date ? new Date(e._date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                        {locked && <span style={{ marginLeft: 6, fontSize: 10, color: '#94a3b8' }}>🔒</span>}
                      </td>
                      <td style={{ ...tdStyle, color: '#0f172a', fontWeight: 500 }}>{staffMap[e._staff]?.name || '—'}</td>
                      <td style={tdStyle}>
                        {e._entity ? (
                          <span
                            onClick={(ev) => { ev.stopPropagation(); navigate(`/clients/${e._entity}`); }}
                            title="Open client"
                            style={{ color: '#0e7fe0', fontWeight: 500, cursor: 'pointer' }}
                          >{clientName}</span>
                        ) : (
                          <span style={{ color: '#94a3b8' }}>—</span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, color: '#64748b' }}>{e.service || '—'}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600, color: '#0f172a', whiteSpace: 'nowrap' }}>{minutesToHMM(e._mins)}</td>
                      <td style={tdStyle}>
                        <span style={{
                          fontSize: 10, fontWeight: 600, color: SOURCE_COLOURS[e._source] || '#64748b',
                          background: `${SOURCE_COLOURS[e._source] || '#64748b'}14`,
                          padding: '2px 7px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.03em',
                        }}>
                          {SOURCE_LABELS[e._source] || e._source}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, color: '#64748b', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e._text || ''}>
                        {e._text || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {sorted.length > 0 && (
                <tfoot>
                  <tr style={{ background: '#f8fafc', borderTop: '2px solid #e5e7eb' }}>
                    <td colSpan={4} style={{ ...tdStyle, fontWeight: 600, color: '#64748b' }}>
                      Total — {sorted.length} {sorted.length === 1 ? 'entry' : 'entries'}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: '#0e7fe0', fontSize: 13.5, whiteSpace: 'nowrap' }}>
                      {minutesToHMM(totalMinutes)}
                    </td>
                    <td colSpan={2} style={{ ...tdStyle, color: '#94a3b8', fontSize: 11 }}>
                      {(totalMinutes / 60).toFixed(1)} hours
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      {editRow && (
        <EditEntryModal
          row={editRow}
          staffName={staffMap[editRow._staff]?.name || '—'}
          clientName={editRow._entity ? (entityMap[editRow._entity]?.name || 'Unknown') : 'No client'}
          onClose={() => setEditRow(null)}
          onSaved={() => { setEditRow(null); setReloadKey((k) => k + 1); }}
        />
      )}
    </div>
  );
}

/* ─── Edit a single timesheet entry ─────────────────────────── */
function EditEntryModal({ row, staffName, clientName, onClose, onSaved }) {
  const [minutes, setMinutes] = useState(String(Math.round(row._mins || 0)));
  const [service, setService] = useState(row.service || '');
  const [notes, setNotes] = useState(row._notes || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const save = async () => {
    const mins = parseInt(minutes, 10);
    if (isNaN(mins) || mins < 0) { setErr('Enter minutes as a whole number.'); return; }
    setBusy(true); setErr(null);
    try {
      await updateTimesheetEntry(row._id, { minutes: mins, service: service || null, notes: notes.trim() || null });
      onSaved();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm('Delete this timesheet entry?')) return;
    setBusy(true); setErr(null);
    try { await deleteTimesheetEntryById(row._id); onSaved(); }
    catch (e) { setErr(e.message); setBusy(false); }
  };

  const F = "'Outfit', sans-serif";
  const inp = { width: '100%', boxSizing: 'border-box', padding: '8px 12px', fontSize: 13, border: '1px solid #cbd5e1', borderRadius: 8, fontFamily: F, outline: 'none' };
  const lbl = { fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 5 };
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: 20, width: 440, maxWidth: '94vw', fontFamily: F }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', marginBottom: 2 }}>Edit timesheet entry</div>
        <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 14 }}>
          {staffName} · {clientName} · {row._date ? new Date(row._date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}
        </div>
        {err && <div style={{ fontSize: 12.5, color: '#b91c1c', marginBottom: 10 }}>{err}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <div style={lbl}>Minutes</div>
            <input type="number" min="0" step="5" value={minutes} onChange={(e) => setMinutes(e.target.value)} style={inp} />
          </div>
          <div>
            <div style={lbl}>Service</div>
            <select value={service} onChange={(e) => setService(e.target.value)} style={{ ...inp, appearance: 'auto' }}>
              <option value="">— none —</option>
              {SERVICES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginBottom: 16 }}>
          <div style={lbl}>Notes</div>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ ...inp, resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={remove} disabled={busy} style={{ padding: '8px 12px', fontSize: 12.5, fontWeight: 600, color: '#b91c1c', background: '#fff', border: '1px solid #fecaca', borderRadius: 8, cursor: 'pointer', fontFamily: F }}>Delete</button>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={onClose} disabled={busy} style={{ padding: '8px 14px', fontSize: 13, color: '#334155', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontFamily: F }}>Cancel</button>
            <button onClick={save} disabled={busy} style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: F }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const thStyle = { padding: '8px 10px', fontSize: 11, fontWeight: 600, color: '#64748b', borderBottom: '2px solid #e5e7eb', fontFamily: "'Outfit', sans-serif", textTransform: 'uppercase', letterSpacing: '0.03em', textAlign: 'left' };
const tdStyle = { padding: '8px 10px', fontSize: 12, fontFamily: "'Outfit', sans-serif" };
const navBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '5px 10px', fontSize: 13, fontWeight: 500, fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', color: '#1e293b', cursor: 'pointer', whiteSpace: 'nowrap' };
const selectStyle = { padding: '5px 10px', fontSize: 12, fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#1e293b', outline: 'none' };
const labelStyle = { fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.03em' };
