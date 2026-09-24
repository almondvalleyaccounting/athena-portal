import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Download, Search } from 'lucide-react';
import DataTable from '../../../components/DataTable';
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

  // Sort + page (the table's headings drive the sort)
  const [sortKey, setSortKey] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(1);

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
    completed.forEach((t, i) => arr.push({
      _key: `c-${t.id ?? i}`,
      _mins: t.completion_mins || 0,
      _source: 'completed',
      _staff: t.assignee_id,
      _entity: t.entity_id,
      _date: t.completed_at ? formatISO(new Date(t.completed_at)) : '',
      _text: t.title || '',
      service: t.service || '',
      _editable: false,
    }));
    entries.forEach((e, i) => arr.push({
      _key: `e-${e.id ?? i}`,
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

  // Sort. The comparator runs ascending (with its date tie-break) and the
  // table flips it for descending, so each row's rank is its sort value.
  const ascending = useMemo(() => {
    const staffName = (e) => staffMap[e._staff]?.name || '';
    const clientName = (e) => (e._entity ? (entityMap[e._entity]?.name || 'Unknown') : '');
    const arr = [...filtered];
    arr.sort((a, b) => {
      switch (sortKey) {
        case 'staff': return staffName(a).localeCompare(staffName(b)) || a._date.localeCompare(b._date);
        case 'client': return clientName(a).localeCompare(clientName(b)) || a._date.localeCompare(b._date);
        case 'minutes': return (a._mins - b._mins) || a._date.localeCompare(b._date);
        case 'date':
        default: return a._date.localeCompare(b._date);
      }
    });
    return arr;
  }, [filtered, sortKey, staffMap, entityMap]);
  const rank = useMemo(() => new Map(ascending.map((e, i) => [e, i])), [ascending]);
  // Table order, which the CSV export follows too.
  const sorted = useMemo(() => (sortDir === 'asc' ? ascending : [...ascending].reverse()), [ascending, sortDir]);

  // Same key flips direction; a new key starts newest first for Date, A–Z otherwise.
  const handleSort = (s) => {
    if (s.key === sortKey) setSortDir(s.dir);
    else { setSortKey(s.key); setSortDir(s.key === 'date' ? 'desc' : 'asc'); }
    setPage(1);
  };
  const filterTo = (set) => (e) => { set(e.target.value); setPage(1); };

  const canEditRow = (e) => e._editable && !isDateLocked(locks, e._date);
  const rowTitle = (e) => {
    if (canEditRow(e)) return 'Click to edit this timesheet entry';
    return isDateLocked(locks, e._date) ? 'Locked period — cannot edit' : 'From completed work — not editable here';
  };
  // The table has no row tooltip, so each cell carries the row's.
  const cell = (e, node, extra) => <div title={rowTitle(e)} style={{ overflow: 'hidden', textOverflow: 'ellipsis', ...extra }}>{node}</div>;
  const byRank = (e) => rank.get(e);

  const columns = [
    {
      key: 'date', label: 'Date', width: 140, sortValue: byRank,
      render: (e) => cell(e, <>
        {e._date ? new Date(e._date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
        {isDateLocked(locks, e._date) && <span style={{ marginLeft: 6, fontSize: 11, color: '#94a3b8' }}>🔒</span>}
      </>, { color: '#64748b' }),
    },
    {
      key: 'staff', label: 'Staff', width: 150, sortValue: byRank,
      render: (e) => cell(e, staffMap[e._staff]?.name || '—', { color: '#0f172a', fontWeight: 500 }),
    },
    {
      key: 'client', label: 'Client', sortValue: byRank,
      render: (e) => cell(e, e._entity ? (
        <Link to={`/clients/${e._entity}`} title="Open client" style={{ color: '#0e7fe0', fontWeight: 500, textDecoration: 'none' }}>
          {entityMap[e._entity]?.name || 'Unknown'}
        </Link>
      ) : <span style={{ color: '#94a3b8' }}>—</span>),
    },
    {
      key: 'service', label: 'Service', width: 160, sortable: false,
      render: (e) => cell(e, e.service || '—', { color: '#64748b' }),
    },
    {
      key: 'minutes', label: 'Time', width: 90, align: 'right', sortValue: byRank,
      render: (e) => cell(e, minutesToHMM(e._mins), { fontWeight: 600, color: '#0f172a' }),
    },
    {
      key: 'source', label: 'Source', width: 115, sortable: false,
      render: (e) => cell(e, (
        <span style={{
          fontSize: 11, fontWeight: 600, color: SOURCE_COLOURS[e._source] || '#64748b',
          background: `${SOURCE_COLOURS[e._source] || '#64748b'}14`,
          padding: '2px 7px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.03em',
        }}>
          {SOURCE_LABELS[e._source] || e._source}
        </span>
      )),
    },
    {
      key: 'notes', label: 'Notes / title', sortable: false,
      render: (e) => <div title={e._text || ''} style={{ color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e._text || '—'}</div>,
    },
  ];

  // Totals over every filtered row, not just the page on screen.
  const footer = (rows) => {
    const mins = rows.reduce((t, e) => t + e._mins, 0);
    return {
      date: <span style={{ fontWeight: 600, color: '#64748b' }}>Total</span>,
      staff: <span style={{ fontWeight: 600, color: '#64748b' }}>{rows.length} {rows.length === 1 ? 'entry' : 'entries'}</span>,
      minutes: <span style={{ color: '#0e7fe0', fontSize: 14.5 }}>{minutesToHMM(mins)}</span>,
      source: <span style={{ color: '#94a3b8', fontSize: 12, fontWeight: 400 }}>{(mins / 60).toFixed(1)} hours</span>,
    };
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

  return (
    <div style={{ padding: '20px 24px', fontFamily: "'Outfit', sans-serif" }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 500, color: '#0f172a', margin: 0 }}>All Entries</h2>
        <div style={{ flex: 1 }} />
        <span style={labelStyle}>From</span>
        <input type="date" value={from} onChange={filterTo(setFrom)} style={{ ...selectStyle, width: 135 }} />
        <span style={{ color: '#94a3b8', fontSize: 13 }}>to</span>
        <input type="date" value={to} onChange={filterTo(setTo)} style={{ ...selectStyle, width: 135 }} />
        <button onClick={exportCsv} disabled={!sorted.length} style={{ ...navBtn, gap: 5, opacity: sorted.length ? 1 : 0.4 }}>
          <Download size={13} /> Export CSV
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <select value={staffFilter} onChange={filterTo(setStaffFilter)} style={{ ...selectStyle, minWidth: 140 }}>
          <option value="">All staff</option>
          {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={clientFilter} onChange={filterTo(setClientFilter)} style={{ ...selectStyle, minWidth: 160 }}>
          <option value="">All clients</option>
          {clientOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={serviceFilter} onChange={filterTo(setServiceFilter)} style={{ ...selectStyle, minWidth: 140 }}>
          <option value="">All services</option>
          {SERVICES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
          <Search size={12} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
          <input
            type="text" placeholder="Search notes / task title..."
            value={search} onChange={filterTo(setSearch)}
            style={{ ...selectStyle, width: '100%', boxSizing: 'border-box', paddingLeft: 26 }}
          />
        </div>
        <span style={{ fontSize: 12.5, color: '#94a3b8', whiteSpace: 'nowrap' }}>
          {sorted.length} {sorted.length === 1 ? 'entry' : 'entries'}
        </span>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>Loading entries...</div>
      ) : (
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(e) => e._key}
          sort={{ key: sortKey, dir: sortDir }}
          onSort={handleSort}
          page={page}
          onPage={setPage}
          onRowClick={(e) => { if (canEditRow(e)) setEditRow(e); }}
          rowStyle={(e) => ({ cursor: canEditRow(e) ? 'pointer' : 'default' })}
          footer={footer}
          empty="No entries for this range and filters."
        />
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
  const inp = { width: '100%', boxSizing: 'border-box', padding: '8px 12px', fontSize: 14, border: '1px solid #cbd5e1', borderRadius: 8, fontFamily: F, outline: 'none' };
  const lbl = { fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 5 };
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: 20, width: 440, maxWidth: '94vw', fontFamily: F }}>
        <div style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a', marginBottom: 2 }}>Edit timesheet entry</div>
        <div style={{ fontSize: 13.5, color: '#64748b', marginBottom: 14 }}>
          {staffName} · {clientName} · {row._date ? new Date(row._date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}
        </div>
        {err && <div style={{ fontSize: 13.5, color: '#b91c1c', marginBottom: 10 }}>{err}</div>}
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
          <button onClick={remove} disabled={busy} style={{ padding: '8px 12px', fontSize: 13.5, fontWeight: 600, color: '#b91c1c', background: '#fff', border: '1px solid #fecaca', borderRadius: 8, cursor: 'pointer', fontFamily: F }}>Delete</button>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={onClose} disabled={busy} style={{ padding: '8px 14px', fontSize: 14, color: '#334155', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontFamily: F }}>Cancel</button>
            <button onClick={save} disabled={busy} style={{ padding: '8px 16px', fontSize: 14, fontWeight: 600, background: '#1E4560', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: F }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const navBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '5px 10px', fontSize: 14, fontWeight: 500, fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', color: '#1e293b', cursor: 'pointer', whiteSpace: 'nowrap' };
const selectStyle = { padding: '5px 10px', fontSize: 13, fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#1e293b', outline: 'none' };
const labelStyle = { fontSize: 12, fontWeight: 600, color: '#94a3b8' };
