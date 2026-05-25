import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';

const font = "'Outfit', sans-serif";

const STATUS_GROUPS = {
  'Not started': ['No Latest Action', 'No Progress', 'Records Requested', 'Part Records Received'],
  'In progress': ['Records Received', 'In Progress', 'Queries Requested'],
  'To review':   ['To Review', 'Reviewed'],
  'With client': ['To Send to Client to Approve', 'Awaiting Approval'],
  'Other':       ['Other - See Note', 'Striking Off Application'],
};
const STATUS_TO_GROUP = (() => {
  const m = {};
  for (const [g, list] of Object.entries(STATUS_GROUPS)) list.forEach((s) => { m[s] = g; });
  return m;
})();
const GROUP_COLOUR = {
  'Not started': '#94a3b8',
  'In progress': '#0ea5e9',
  'To review':   '#a855f7',
  'With client': '#f59e0b',
  'Other':       '#64748b',
};

function todayUTC() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function isoDate(d) { return d.toISOString().slice(0, 10); }
function parseISO(s) { return new Date(s + 'T00:00:00Z'); }
function addDays(d, n) { const o = new Date(d); o.setUTCDate(o.getUTCDate() + n); return o; }
function subMonths(d, n) { const o = new Date(d); o.setUTCMonth(o.getUTCMonth() - n); return o; }
function fmt(d) {
  return new Date(d.getTime() + d.getTimezoneOffset() * 60000)
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Period end derivation. Prefer parsing the task name (BM always embeds the
// precise period end in the title) since `bm_deadline − 9 months` overflows
// on YE 29/30/31 of a short month (e.g. YE 28/02 → BM deadline 30/11 → naive
// subMonths gives 2 Mar instead of 28 Feb).
function parsePeriodEndFromTaskName(service, name) {
  if (!name) return null;
  if (service === 'Annual Accounts') {
    const m = name.match(/Year End\s+(\d{2})\/(\d{2})\/(\d{4})/i);
    if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  }
  if (service === 'Self Assessment') {
    const m = name.match(/Tax Year\s+(\d{4})\/(\d{2})/i);
    if (m) return new Date(Date.UTC(+m[1] + 1, 3, 5)); // 5 April of the closing year
  }
  return null;
}
function derivePeriodEnd(service, bmDeadlineISO, taskName) {
  const fromName = parsePeriodEndFromTaskName(service, taskName);
  if (fromName) return fromName;
  if (!bmDeadlineISO) return null;
  const d = parseISO(bmDeadlineISO);
  if (service === 'Annual Accounts') return subMonths(d, 9);
  if (service === 'Self Assessment') return new Date(Date.UTC(d.getUTCFullYear() - 1, 3, 5));
  return null;
}

export default function ReadyNowView() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [togglingId, setTogglingId] = useState(null);

  // Filters
  const [serviceFilter, setServiceFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [assigneeFilter, setAssigneeFilter] = useState('all');
  const [gradeFilter, setGradeFilter] = useState('all');
  const [dueFilter, setDueFilter] = useState('all'); // all | overdue | 30 | 60 | 90
  const [search, setSearch] = useState('');
  const [normalDaysBuffer, setNormalDaysBuffer] = useState(90);
  const [sortKey, setSortKey] = useState('period_end');
  const [sortDir, setSortDir] = useState('asc');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { data, error } = await supabase
          .from('bm_task_schedule')
          .select('id, service, bm_task_name, bm_status, bm_deadline, bm_target_date, entity_id, assignee_id, entities(name, grade, expedite), staff_profiles:assignee_id(id, name)')
          .in('service', ['Self Assessment', 'Annual Accounts'])
          .eq('state', 'planned');
        if (error) throw error;
        if (cancelled) return;
        setRows(data || []);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  async function toggleExpedite(entityId, next) {
    setTogglingId(entityId);
    // Optimistic update
    setRows((prev) => prev.map((r) =>
      r.entity_id === entityId ? { ...r, entities: { ...r.entities, expedite: next } } : r
    ));
    const { error } = await supabase.from('entities').update({ expedite: next }).eq('id', entityId);
    setTogglingId(null);
    if (error) {
      setRows((prev) => prev.map((r) =>
        r.entity_id === entityId ? { ...r, entities: { ...r.entities, expedite: !next } } : r
      ));
      alert('Could not update expedite flag: ' + error.message);
    }
  }

  // Build unique rows (one per entity+service+period_end), independent of cutoff
  const allReady = useMemo(() => {
    const today = todayUTC();
    const byKey = new Map();
    for (const r of rows) {
      const pe = derivePeriodEnd(r.service, r.bm_deadline, r.bm_task_name);
      if (!pe) continue;
      const key = `${r.entity_id}|${r.service}|${isoDate(pe)}`;
      const assigneeName = r.staff_profiles?.name || null;
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          entity_id: r.entity_id,
          client: r.entities?.name || '(unknown)',
          grade: r.entities?.grade || null,
          expedite: !!r.entities?.expedite,
          service: r.service,
          period_end: pe,
          bm_deadline: r.bm_deadline,
          bm_target_date: r.bm_target_date || null,
          bm_status: r.bm_status,
          status_group: STATUS_TO_GROUP[r.bm_status] || 'Other',
          assignees: assigneeName ? [assigneeName] : [],
          days_past: Math.floor((today - pe) / 86400000),
        });
      } else {
        const e = byKey.get(key);
        // Earliest target date wins (most pressing)
        if (r.bm_target_date && (!e.bm_target_date || r.bm_target_date < e.bm_target_date)) {
          e.bm_target_date = r.bm_target_date;
        }
        if (assigneeName && !e.assignees.includes(assigneeName)) e.assignees.push(assigneeName);
      }
    }
    return Array.from(byKey.values());
  }, [rows]);

  const assigneeOptions = useMemo(() => {
    const set = new Set();
    rows.forEach((r) => { if (r.staff_profiles?.name) set.add(r.staff_profiles.name); });
    return Array.from(set).sort();
  }, [rows]);

  const gradeOptions = useMemo(() => {
    const set = new Set();
    allReady.forEach((r) => { if (r.grade) set.add(r.grade); });
    // Sort by letter ascending, then suffix '+' < '' < '-' so A+ comes before A.
    const suffixRank = (s) => (s === '+' ? 0 : s === '' ? 1 : s === '-' ? 2 : 3);
    return Array.from(set).sort((a, b) => {
      const al = a[0] || '', bl = b[0] || '';
      if (al !== bl) return al < bl ? -1 : 1;
      return suffixRank(a.slice(1)) - suffixRank(b.slice(1));
    });
  }, [allReady]);

  // Apply shared filters (service/status/assignee/grade/search). Cutoff is per-box.
  function applySharedFilters(list) {
    let out = list;
    if (serviceFilter === 'SA') out = out.filter((r) => r.service === 'Self Assessment');
    else if (serviceFilter === 'Acc') out = out.filter((r) => r.service === 'Annual Accounts');
    if (statusFilter !== 'all') out = out.filter((r) => r.status_group === statusFilter);
    if (assigneeFilter === 'unassigned') out = out.filter((r) => r.assignees.length === 0);
    else if (assigneeFilter !== 'all') out = out.filter((r) => r.assignees.includes(assigneeFilter));
    if (gradeFilter !== 'all') out = out.filter((r) => (r.grade || '—') === gradeFilter);
    if (dueFilter !== 'all') {
      const today = todayUTC();
      out = out.filter((r) => {
        if (!r.bm_deadline) return false;
        const d = parseISO(r.bm_deadline);
        const diff = Math.floor((d - today) / 86400000);
        if (dueFilter === 'overdue') return diff < 0;
        const window = parseInt(dueFilter, 10);
        return diff >= 0 && diff <= window;
      });
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter((r) => r.client.toLowerCase().includes(q));
    }
    return out;
  }

  function applySort(list) {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      let av, bv;
      switch (sortKey) {
        case 'client':     av = a.client.toLowerCase(); bv = b.client.toLowerCase(); break;
        case 'service':    av = a.service; bv = b.service; break;
        case 'grade':      av = a.grade || 'Z'; bv = b.grade || 'Z'; break;
        case 'status':     av = a.bm_status || ''; bv = b.bm_status || ''; break;
        case 'assignee':   av = (a.assignees[0] || '~'); bv = (b.assignees[0] || '~'); break;
        case 'days':       av = a.days_past; bv = b.days_past; break;
        case 'target':     av = a.bm_target_date || '9999-12-31'; bv = b.bm_target_date || '9999-12-31'; break;
        case 'statutory':  av = a.bm_deadline || '9999-12-31'; bv = b.bm_deadline || '9999-12-31'; break;
        case 'period_end':
        default:           av = a.period_end.getTime(); bv = b.period_end.getTime(); break;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  // Expedite box: any expedite row whose period_end has passed (days_past >= 0).
  // Normal box: non-expedite rows where days_past >= normalDaysBuffer.
  const sharedFiltered = useMemo(() => applySharedFilters(allReady), [allReady, serviceFilter, statusFilter, assigneeFilter, gradeFilter, dueFilter, search]);
  const expediteRows = useMemo(
    () => applySort(sharedFiltered.filter((r) => r.expedite && r.days_past >= 0)),
    [sharedFiltered, sortKey, sortDir]
  );
  const normalRows = useMemo(
    () => applySort(sharedFiltered.filter((r) => !r.expedite && r.days_past >= normalDaysBuffer)),
    [sharedFiltered, normalDaysBuffer, sortKey, sortDir]
  );

  // Summary by service x status_group, combined across both boxes
  const summary = useMemo(() => {
    const tally = { 'Self Assessment': {}, 'Annual Accounts': {} };
    for (const r of [...expediteRows, ...normalRows]) {
      if (!tally[r.service]) tally[r.service] = {};
      tally[r.service][r.status_group] = (tally[r.service][r.status_group] || 0) + 1;
    }
    return tally;
  }, [expediteRows, normalRows]);

  function toggleSort(key) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'days' ? 'desc' : 'asc'); }
  }

  function exportCsv() {
    const header = ['Box', 'Client', 'Grade', 'Service', 'Period end', 'BM target', 'Days past PE', 'BM deadline', 'BM status', 'Status group', 'Assignees'];
    const lines = [header.join(',')];
    const dump = (label, list) => {
      for (const r of list) {
        const row = [
          label,
          '"' + r.client.replace(/"/g, '""') + '"',
          r.grade || '',
          r.service,
          isoDate(r.period_end),
          r.bm_target_date || '',
          r.days_past,
          r.bm_deadline || '',
          r.bm_status || '',
          r.status_group,
          '"' + r.assignees.join('; ') + '"',
        ];
        lines.push(row.join(','));
      }
    };
    dump('Expedite', expediteRows);
    dump('Normal', normalRows);
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ready-now-${isoDate(todayUTC())}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) {
    return <div style={{ padding: 20, fontFamily: font, color: '#64748b', fontSize: 13 }}>Loading…</div>;
  }
  if (error) {
    return <div style={{ padding: 20, fontFamily: font, color: '#dc2626', fontSize: 13 }}>Error: {error}</div>;
  }

  return (
    <div style={{ fontFamily: font, padding: '16px 20px 40px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#0f172a' }}>Ready Now</h2>
        <span style={{ fontSize: 12, color: '#64748b' }}>
          Self Assessment & Annual Accounts where period end has passed and the job hasn't been submitted.
        </span>
      </div>

      {/* Summary */}
      <div style={{
        display: 'flex', gap: 12, marginBottom: 14, padding: 10, background: '#f8fafc',
        border: '1px solid #e5e7eb', borderRadius: 8, flexWrap: 'wrap',
      }}>
        {['Self Assessment', 'Annual Accounts'].map((svc) => {
          const total = Object.values(summary[svc] || {}).reduce((a, b) => a + b, 0);
          return (
            <div key={svc} style={{ minWidth: 280 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#0f172a', marginBottom: 4 }}>
                {svc} · <span style={{ color: '#0e7fe0' }}>{total}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {Object.keys(STATUS_GROUPS).map((g) => {
                  const n = summary[svc]?.[g] || 0;
                  if (!n) return null;
                  return (
                    <span key={g} style={{
                      fontSize: 11, padding: '2px 8px', borderRadius: 999,
                      background: GROUP_COLOUR[g] + '22',
                      color: GROUP_COLOUR[g],
                      border: '1px solid ' + GROUP_COLOUR[g] + '55',
                    }}>{g}: {n}</span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Select label="Service" value={serviceFilter} onChange={setServiceFilter}
          options={[['all', 'All'], ['SA', 'Self Assessment'], ['Acc', 'Annual Accounts']]} />
        <Select label="Status" value={statusFilter} onChange={setStatusFilter}
          options={[['all', 'All'], ...Object.keys(STATUS_GROUPS).map((g) => [g, g])]} />
        <Select label="Assignee" value={assigneeFilter} onChange={setAssigneeFilter}
          options={[['all', 'All'], ['unassigned', '— Unassigned —'], ...assigneeOptions.map((n) => [n, n])]} />
        <Select label="Grade" value={gradeFilter} onChange={setGradeFilter}
          options={[['all', 'All'], ...gradeOptions.map((g) => [g, g])]} />
        <Select label="Statutory" value={dueFilter} onChange={setDueFilter}
          options={[['all', 'All'], ['overdue', 'Overdue'], ['30', 'Due in 30'], ['60', 'Due in 60'], ['90', 'Due in 90']]} />
        <label style={{ fontSize: 12, color: '#475569', display: 'flex', alignItems: 'center', gap: 6 }}>
          Normal box: days past PE ≥
          <input
            type="number" min={0} value={normalDaysBuffer}
            onChange={(e) => setNormalDaysBuffer(Math.max(0, parseInt(e.target.value || '0', 10)))}
            style={{
              width: 60, padding: '4px 6px', fontSize: 12, fontFamily: font,
              border: '1px solid #cbd5e1', borderRadius: 6,
            }}
          />
        </label>
        <input
          placeholder="Search client…"
          value={search} onChange={(e) => setSearch(e.target.value)}
          style={{
            padding: '5px 10px', fontSize: 12, fontFamily: font,
            border: '1px solid #cbd5e1', borderRadius: 6, minWidth: 200,
          }}
        />
        <div style={{ flex: 1 }} />
        <button
          onClick={exportCsv}
          style={{
            padding: '5px 12px', fontSize: 12, fontWeight: 500, fontFamily: font,
            border: '1px solid #0f172a', borderRadius: 6, background: '#0f172a', color: '#fff', cursor: 'pointer',
          }}
        >Export CSV</button>
      </div>

      {/* Expedite box */}
      <Box
        title="⚡ Expedite"
        subtitle="Skip the queue — shown as soon as period end passes."
        accent="#f59e0b"
        background="#fff"
        rows={expediteRows}
        expedite
        togglingId={togglingId}
        onToggle={toggleExpedite}
        sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort}
        emptyText="No expedite clients with a passed period end."
      />

      <div style={{ height: 16 }} />

      {/* Normal box */}
      <Box
        title="Normal priority"
        subtitle={`Period end ≥ ${normalDaysBuffer} days ago.`}
        accent="#64748b"
        background="#fff"
        rows={normalRows}
        expedite={false}
        togglingId={togglingId}
        onToggle={toggleExpedite}
        sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort}
        emptyText="No normal-priority jobs match the current filters."
      />

      <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 14, lineHeight: 1.5 }}>
        Period end is derived: Annual Accounts = BM deadline − 9 months; Self Assessment = 5 April of the year before the BM deadline.
        Non-standard accounting periods (first-year, struck-off, overseas) may differ — spot-check anomalies.
        BM target is the internal deadline from BrightManager — to change it, update the task's Target Date in BM.
      </p>
    </div>
  );
}

function Box({ title, subtitle, accent, background, rows, expedite, togglingId, onToggle, sortKey, sortDir, toggleSort, emptyText }) {
  return (
    <div style={{
      border: `1px solid ${accent}66`, borderRadius: 8, overflow: 'hidden', background,
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 10,
        padding: '8px 12px', background: accent + '14',
        borderBottom: `1px solid ${accent}44`,
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: accent === '#f59e0b' ? '#b45309' : '#0f172a' }}>
          {title}
        </span>
        <span style={{ fontSize: 11, color: '#64748b' }}>{subtitle}</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: '#64748b' }}>{rows.length} jobs</span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead style={{ background: '#f8fafc' }}>
          <tr>
            <Th onClick={() => toggleSort('client')} active={sortKey === 'client'} dir={sortDir}>Client</Th>
            <Th onClick={() => toggleSort('grade')} active={sortKey === 'grade'} dir={sortDir}>Grade</Th>
            <Th onClick={() => toggleSort('service')} active={sortKey === 'service'} dir={sortDir}>Service</Th>
            <Th onClick={() => toggleSort('period_end')} active={sortKey === 'period_end'} dir={sortDir}>Period end</Th>
            <Th onClick={() => toggleSort('statutory')} active={sortKey === 'statutory'} dir={sortDir}>Statutory</Th>
            <Th onClick={() => toggleSort('target')} active={sortKey === 'target'} dir={sortDir}>BM target</Th>
            <Th onClick={() => toggleSort('days')} active={sortKey === 'days'} dir={sortDir} align="right">Days past</Th>
            <Th onClick={() => toggleSort('status')} active={sortKey === 'status'} dir={sortDir}>BM status</Th>
            <Th onClick={() => toggleSort('assignee')} active={sortKey === 'assignee'} dir={sortDir}>Assignee(s)</Th>
            <th style={thStatic}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key} style={{
              background: i % 2 ? 'transparent' : '#fafbfc',
              borderTop: '1px solid #f1f5f9',
            }}>
              <td style={td}>
                {expedite ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: '#f59e0b', fontSize: 13, lineHeight: 1 }}>⚡</span>
                    <span>{r.client}</span>
                  </span>
                ) : r.client}
              </td>
              <td style={{ ...td, color: '#475569', fontWeight: 600 }}>
                {r.grade ? <span style={{
                  fontSize: 10, padding: '1px 6px', borderRadius: 4,
                  background: '#eef2ff', color: '#4338ca', border: '1px solid #c7d2fe',
                }}>{r.grade}</span> : <span style={{ color: '#cbd5e1' }}>—</span>}
              </td>
              <td style={{ ...td, color: '#475569' }}>{r.service === 'Self Assessment' ? 'SA' : 'Annual Accs'}</td>
              <td style={{ ...td, color: '#475569' }}>{fmt(r.period_end)}</td>
              <td style={{ ...td, color: r.bm_deadline ? (parseISO(r.bm_deadline) < todayUTC() ? '#dc2626' : '#475569') : '#cbd5e1', fontWeight: r.bm_deadline && parseISO(r.bm_deadline) < todayUTC() ? 600 : 400 }}>
                {r.bm_deadline ? fmt(parseISO(r.bm_deadline)) : '—'}
              </td>
              <td style={{ ...td, color: r.bm_target_date ? '#475569' : '#cbd5e1' }}>
                {r.bm_target_date ? fmt(parseISO(r.bm_target_date)) : '—'}
              </td>
              <td style={{ ...td, textAlign: 'right', color: r.days_past > 365 ? '#dc2626' : '#475569', fontVariantNumeric: 'tabular-nums' }}>
                {r.days_past}
              </td>
              <td style={td}>
                <span style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 999,
                  background: GROUP_COLOUR[r.status_group] + '22',
                  color: GROUP_COLOUR[r.status_group],
                  border: '1px solid ' + GROUP_COLOUR[r.status_group] + '55',
                }}>{r.bm_status}</span>
              </td>
              <td style={{ ...td, color: r.assignees.length ? '#0f172a' : '#94a3b8' }}>
                {r.assignees.length ? r.assignees.join(', ') : 'Unassigned'}
              </td>
              <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                <button
                  disabled={togglingId === r.entity_id}
                  onClick={() => onToggle(r.entity_id, !expedite)}
                  title={expedite ? 'Remove expedite — send back to normal box' : 'Expedite — promote to top box'}
                  style={{
                    fontSize: 11, padding: '3px 8px', fontFamily: font, cursor: togglingId === r.entity_id ? 'wait' : 'pointer',
                    borderRadius: 6,
                    border: expedite ? '1px solid #cbd5e1' : '1px solid #fcd34d',
                    background: expedite ? '#fff' : '#fef3c7',
                    color: expedite ? '#475569' : '#b45309',
                    fontWeight: 600,
                  }}
                >
                  {expedite ? 'Unexpedite' : '⚡ Expedite'}
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={10} style={{ ...td, textAlign: 'center', color: '#94a3b8', padding: 24 }}>
              {emptyText}
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const td = { padding: '7px 10px', verticalAlign: 'middle' };
const thStatic = { padding: '8px 10px', borderBottom: '1px solid #e5e7eb' };

function Th({ children, onClick, active, dir, align }) {
  return (
    <th
      onClick={onClick}
      style={{
        padding: '8px 10px', textAlign: align || 'left', fontWeight: 600, fontSize: 11,
        color: active ? '#0f172a' : '#64748b', textTransform: 'uppercase', letterSpacing: 0.4,
        cursor: 'pointer', userSelect: 'none', borderBottom: '1px solid #e5e7eb',
      }}
    >
      {children}{active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <label style={{ fontSize: 12, color: '#475569', display: 'flex', alignItems: 'center', gap: 6 }}>
      {label}
      <select
        value={value} onChange={(e) => onChange(e.target.value)}
        style={{
          padding: '4px 8px', fontSize: 12, fontFamily: font,
          border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', cursor: 'pointer',
        }}
      >
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}
