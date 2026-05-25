import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import ClientTypeAhead from '../components/ClientTypeAhead';

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

export default function ReadyNowView({ teamFilter = '', clientFilter = '', setClientFilter = () => {}, entityList = [] } = {}) {
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
  const [normalDaysBuffer, setNormalDaysBuffer] = useState(90);
  const [impendingDays, setImpendingDays] = useState(14);
  const [impendingCollapsed, setImpendingCollapsed] = useState(false);
  const [expediteCollapsed, setExpediteCollapsed] = useState(false);
  const [deprioritisedCollapsed, setDeprioritisedCollapsed] = useState(false);
  const [normalCollapsed, setNormalCollapsed] = useState(false);
  const [depriDialog, setDepriDialog] = useState(null); // { entityId, client } | null
  const [sortKey, setSortKey] = useState('period_end');
  const [sortDir, setSortDir] = useState('asc');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { data, error } = await supabase
          .from('bm_task_schedule')
          .select('id, service, bm_task_name, bm_status, bm_deadline, bm_target_date, entity_id, assignee_id, entities(name, grade, expedite, deprioritise_reason), staff_profiles:assignee_id(id, name)')
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

  async function setDeprioritise(entityId, reason /* string | null */) {
    setTogglingId(entityId);
    const prev = rows.find((r) => r.entity_id === entityId)?.entities?.deprioritise_reason ?? null;
    setRows((curr) => curr.map((r) =>
      r.entity_id === entityId ? { ...r, entities: { ...r.entities, deprioritise_reason: reason } } : r
    ));
    const payload = reason
      ? { deprioritise_reason: reason, deprioritised_at: new Date().toISOString() }
      : { deprioritise_reason: null, deprioritised_at: null };
    const { error } = await supabase.from('entities').update(payload).eq('id', entityId);
    setTogglingId(null);
    if (error) {
      setRows((curr) => curr.map((r) =>
        r.entity_id === entityId ? { ...r, entities: { ...r.entities, deprioritise_reason: prev } } : r
      ));
      alert('Could not update deprioritise flag: ' + error.message);
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
          deprioritise_reason: r.entities?.deprioritise_reason || null,
          service: r.service,
          period_end: pe,
          bm_deadline: r.bm_deadline,
          bm_target_date: r.bm_target_date || null,
          bm_status: r.bm_status,
          status_group: STATUS_TO_GROUP[r.bm_status] || 'Other',
          assignees: assigneeName ? [assigneeName] : [],
          assigneeIds: r.assignee_id ? [r.assignee_id] : [],
          days_past: Math.floor((today - pe) / 86400000),
        });
      } else {
        const e = byKey.get(key);
        // Earliest target date wins (most pressing)
        if (r.bm_target_date && (!e.bm_target_date || r.bm_target_date < e.bm_target_date)) {
          e.bm_target_date = r.bm_target_date;
        }
        if (assigneeName && !e.assignees.includes(assigneeName)) e.assignees.push(assigneeName);
        if (r.assignee_id && !e.assigneeIds.includes(r.assignee_id)) e.assigneeIds.push(r.assignee_id);
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
    if (teamFilter) out = out.filter((r) => r.assigneeIds.includes(teamFilter));
    if (serviceFilter === 'SA') out = out.filter((r) => r.service === 'Self Assessment');
    else if (serviceFilter === 'Acc') out = out.filter((r) => r.service === 'Annual Accounts');
    if (statusFilter !== 'all') out = out.filter((r) => r.status_group === statusFilter);
    if (assigneeFilter === 'unassigned') out = out.filter((r) => r.assignees.length === 0);
    else if (assigneeFilter !== 'all') out = out.filter((r) => r.assignees.includes(assigneeFilter));
    if (gradeFilter === 'none') out = out.filter((r) => !r.grade);
    else if (gradeFilter !== 'all') out = out.filter((r) => r.grade === gradeFilter);
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
    if (clientFilter) out = out.filter((r) => r.entity_id === clientFilter);
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

  // Impending box: bm_deadline within impendingDays of today (or overdue).
  // Expedite box: expedite-flagged client whose period_end has passed and
  // isn't already in Impending. Normal box: remaining rows with days_past
  // >= normalDaysBuffer. Each row appears in exactly one box.
  const sharedFiltered = useMemo(() => applySharedFilters(allReady), [allReady, teamFilter, clientFilter, serviceFilter, statusFilter, assigneeFilter, gradeFilter, dueFilter]);
  const partitioned = useMemo(() => {
    const today = todayUTC();
    const impending = [];
    const expedite = [];
    const deprioritised = [];
    const normal = [];
    for (const r of sharedFiltered) {
      if (r.deprioritise_reason) { deprioritised.push(r); continue; }
      const inImpending = r.bm_deadline
        && Math.floor((parseISO(r.bm_deadline) - today) / 86400000) <= impendingDays;
      if (inImpending) impending.push(r);
      else if (r.expedite && r.days_past >= 0) expedite.push(r);
      else if (!r.expedite && r.days_past >= normalDaysBuffer) normal.push(r);
    }
    return { impending, expedite, deprioritised, normal };
  }, [sharedFiltered, impendingDays, normalDaysBuffer]);
  const impendingRows = useMemo(() => applySort(partitioned.impending), [partitioned, sortKey, sortDir]);
  const expediteRows = useMemo(() => applySort(partitioned.expedite), [partitioned, sortKey, sortDir]);
  const deprioritisedRows = useMemo(() => applySort(partitioned.deprioritised), [partitioned, sortKey, sortDir]);
  const normalRows = useMemo(() => applySort(partitioned.normal), [partitioned, sortKey, sortDir]);

  // Summary by service x status_group, computed across every box. We exclude
  // both serviceFilter and statusFilter so all pills always show their
  // currently-available counts and stay clickable (the pill click sets both
  // filters together).
  const summary = useMemo(() => {
    const tally = { 'Self Assessment': {}, 'Annual Accounts': {} };
    const today = todayUTC();
    let pool = allReady;
    if (teamFilter) pool = pool.filter((r) => r.assigneeIds.includes(teamFilter));
    if (assigneeFilter === 'unassigned') pool = pool.filter((r) => r.assignees.length === 0);
    else if (assigneeFilter !== 'all') pool = pool.filter((r) => r.assignees.includes(assigneeFilter));
    if (gradeFilter === 'none') pool = pool.filter((r) => !r.grade);
    else if (gradeFilter !== 'all') pool = pool.filter((r) => r.grade === gradeFilter);
    if (dueFilter !== 'all') {
      pool = pool.filter((r) => {
        if (!r.bm_deadline) return false;
        const diff = Math.floor((parseISO(r.bm_deadline) - today) / 86400000);
        if (dueFilter === 'overdue') return diff < 0;
        const window = parseInt(dueFilter, 10);
        return diff >= 0 && diff <= window;
      });
    }
    if (clientFilter) pool = pool.filter((r) => r.entity_id === clientFilter);
    // Match the box partitioning (Deprioritised > Impending > Expedite > Normal)
    for (const r of pool) {
      const inDepri = !!r.deprioritise_reason;
      const inImpending = !inDepri && r.bm_deadline
        && Math.floor((parseISO(r.bm_deadline) - today) / 86400000) <= impendingDays;
      const inExpedite = !inDepri && !inImpending && r.expedite && r.days_past >= 0;
      const inNormal = !inDepri && !inImpending && !r.expedite && r.days_past >= normalDaysBuffer;
      if (!inDepri && !inImpending && !inExpedite && !inNormal) continue;
      if (!tally[r.service]) tally[r.service] = {};
      tally[r.service][r.status_group] = (tally[r.service][r.status_group] || 0) + 1;
    }
    return tally;
  }, [allReady, teamFilter, clientFilter, assigneeFilter, gradeFilter, dueFilter, impendingDays, normalDaysBuffer]);

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
    dump('Urgent', impendingRows);
    dump('Expedite', expediteRows);
    dump('Deprioritised', deprioritisedRows);
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
                  const svcKey = svc === 'Self Assessment' ? 'SA' : 'Acc';
                  const active = statusFilter === g && serviceFilter === svcKey;
                  return (
                    <button
                      key={g}
                      type="button"
                      onClick={() => {
                        if (active) {
                          setStatusFilter('all');
                          setServiceFilter('all');
                        } else {
                          setStatusFilter(g);
                          setServiceFilter(svcKey);
                        }
                      }}
                      title={active ? 'Clear filter' : `Filter to ${svc} · ${g}`}
                      style={{
                        fontSize: 11, padding: '2px 8px', borderRadius: 999,
                        background: active ? GROUP_COLOUR[g] : GROUP_COLOUR[g] + '22',
                        color: active ? '#fff' : GROUP_COLOUR[g],
                        border: '1px solid ' + GROUP_COLOUR[g] + (active ? '' : '55'),
                        cursor: 'pointer', fontFamily: font, fontWeight: active ? 600 : 400,
                      }}
                    >{g}: {n}</button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, color: '#475569', display: 'flex', alignItems: 'center', gap: 6 }}>
          Client
          <ClientTypeAhead
            entityList={entityList}
            value={clientFilter}
            onChange={setClientFilter}
            size="small"
          />
        </label>
        <Select label="Service" value={serviceFilter} onChange={setServiceFilter}
          options={[['all', 'All'], ['SA', 'Self Assessment'], ['Acc', 'Annual Accounts']]} />
        <Select label="Status" value={statusFilter} onChange={setStatusFilter}
          options={[['all', 'All'], ...Object.keys(STATUS_GROUPS).map((g) => [g, g])]} />
        <Select label="Assignee" value={assigneeFilter} onChange={setAssigneeFilter}
          options={[['all', 'All'], ['unassigned', '— Unassigned —'], ...assigneeOptions.map((n) => [n, n])]} />
        <Select label="Grade" value={gradeFilter} onChange={setGradeFilter}
          options={[['all', 'All'], ...gradeOptions.map((g) => [g, g]), ['none', '— No grade —']]} />
        <Select label="Statutory" value={dueFilter} onChange={setDueFilter}
          options={[['all', 'All'], ['overdue', 'Overdue'], ['30', 'Due in 30'], ['60', 'Due in 60'], ['90', 'Due in 90']]} />
        <label style={{ fontSize: 12, color: '#475569', display: 'flex', alignItems: 'center', gap: 6 }}>
          Urgent: due in ≤
          <input
            type="number" min={0} value={impendingDays}
            onChange={(e) => setImpendingDays(Math.max(0, parseInt(e.target.value || '0', 10)))}
            style={{
              width: 50, padding: '4px 6px', fontSize: 12, fontFamily: font,
              border: '1px solid #cbd5e1', borderRadius: 6,
            }}
          />
          days
        </label>
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
        <div style={{ flex: 1 }} />
        <button
          onClick={() => {
            setServiceFilter('all');
            setStatusFilter('all');
            setAssigneeFilter('all');
            setGradeFilter('all');
            setDueFilter('all');
            setClientFilter('');
            setImpendingDays(14);
            setNormalDaysBuffer(90);
          }}
          title="Clear all filters and restore defaults"
          style={{
            padding: '5px 12px', fontSize: 12, fontWeight: 500, fontFamily: font,
            border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', color: '#475569', cursor: 'pointer',
          }}
        >Reset filters</button>
        <button
          onClick={exportCsv}
          style={{
            padding: '5px 12px', fontSize: 12, fontWeight: 500, fontFamily: font,
            border: '1px solid #0f172a', borderRadius: 6, background: '#0f172a', color: '#fff', cursor: 'pointer',
          }}
        >Export CSV</button>
      </div>

      {/* Impending box — only shown when there's something inside the window */}
      {impendingRows.length > 0 && (
        <>
          <Box
            title="🔥 Urgent"
            subtitle={`Statutory deadline within ${impendingDays} days (or overdue).`}
            accent="#dc2626"
            titleColor="#b91c1c"
            background="#fff"
            rows={impendingRows}
            actionKind="deprioritise"
            togglingId={togglingId}
            onDeprioritise={(entityId, client) => setDepriDialog({ entityId, client })}
            sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort}
            emptyText=""
            collapsible
            collapsed={impendingCollapsed}
            onToggleCollapse={() => setImpendingCollapsed((c) => !c)}
          />
          <div style={{ height: 16 }} />
        </>
      )}

      {/* Expedite box */}
      <Box
        title="⚡ Expedite"
        subtitle="Skip the queue — shown as soon as period end passes."
        accent="#f59e0b"
        titleColor="#b45309"
        background="#fff"
        rows={expediteRows}
        expedite
        actionKind="unexpedite"
        togglingId={togglingId}
        onUnexpedite={(entityId) => toggleExpedite(entityId, false)}
        sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort}
        emptyText="No expedite clients with a passed period end."
        collapsible
        collapsed={expediteCollapsed}
        onToggleCollapse={() => setExpediteCollapsed((c) => !c)}
      />

      <div style={{ height: 16 }} />

      {/* Deprioritised box */}
      {deprioritisedRows.length > 0 && (
        <>
          <Box
            title="Deprioritised"
            subtitle="Parked with a reason — won't appear in Urgent or Normal until reactivated."
            accent="#94a3b8"
            titleColor="#475569"
            background="#fff"
            rows={deprioritisedRows}
            actionKind="reactivate"
            togglingId={togglingId}
            onReactivate={(entityId) => setDeprioritise(entityId, null)}
            showReason
            sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort}
            emptyText=""
            collapsible
            collapsed={deprioritisedCollapsed}
            onToggleCollapse={() => setDeprioritisedCollapsed((c) => !c)}
          />
          <div style={{ height: 16 }} />
        </>
      )}

      {/* Normal box */}
      <Box
        title="Normal priority"
        subtitle={`Period end ≥ ${normalDaysBuffer} days ago.`}
        accent="#64748b"
        background="#fff"
        rows={normalRows}
        actionKind="expedite"
        togglingId={togglingId}
        onExpedite={(entityId) => toggleExpedite(entityId, true)}
        sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort}
        emptyText="No normal-priority jobs match the current filters."
        collapsible
        collapsed={normalCollapsed}
        onToggleCollapse={() => setNormalCollapsed((c) => !c)}
      />

      {depriDialog && (
        <DeprioritiseDialog
          client={depriDialog.client}
          onCancel={() => setDepriDialog(null)}
          onConfirm={(reason) => {
            setDeprioritise(depriDialog.entityId, reason);
            setDepriDialog(null);
          }}
        />
      )}

      <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 14, lineHeight: 1.5 }}>
        Period end is derived: Annual Accounts = BM deadline − 9 months; Self Assessment = 5 April of the year before the BM deadline.
        Non-standard accounting periods (first-year, struck-off, overseas) may differ — spot-check anomalies.
        BM target is the internal deadline from BrightManager — to change it, update the task's Target Date in BM.
      </p>
    </div>
  );
}

function Box({
  title, subtitle, accent, titleColor, background,
  rows, expedite, actionKind, togglingId,
  onExpedite, onUnexpedite, onDeprioritise, onReactivate,
  showReason,
  sortKey, sortDir, toggleSort, emptyText,
  collapsible, collapsed, onToggleCollapse,
}) {
  return (
    <div style={{
      border: `1px solid ${accent}66`, borderRadius: 8, overflow: 'hidden', background,
    }}>
      <div
        onClick={collapsible ? onToggleCollapse : undefined}
        style={{
          display: 'flex', alignItems: 'baseline', gap: 10,
          padding: '8px 12px', background: accent + '14',
          borderBottom: collapsed ? 'none' : `1px solid ${accent}44`,
          cursor: collapsible ? 'pointer' : 'default',
          userSelect: 'none',
        }}
      >
        {collapsible && (
          <span style={{ fontSize: 10, color: titleColor || '#0f172a', width: 10, display: 'inline-block' }}>
            {collapsed ? '▶' : '▼'}
          </span>
        )}
        <span style={{ fontSize: 13, fontWeight: 700, color: titleColor || '#0f172a' }}>
          {title}
        </span>
        <span style={{ fontSize: 11, color: '#64748b' }}>{subtitle}</span>
        <div style={{ flex: 1 }} />
        <span style={{
          fontSize: 12, fontWeight: 700,
          padding: '2px 10px', borderRadius: 999,
          background: accent, color: '#fff',
          fontVariantNumeric: 'tabular-nums',
        }}>{rows.length} {rows.length === 1 ? 'job' : 'jobs'}</span>
      </div>
      {collapsed ? null : (
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
                ) : showReason && r.deprioritise_reason ? (
                  <div>
                    <div>{r.client}</div>
                    <div style={{ fontSize: 10, color: '#94a3b8', fontStyle: 'italic' }}>
                      {r.deprioritise_reason}
                    </div>
                  </div>
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
                <RowAction
                  kind={actionKind}
                  busy={togglingId === r.entity_id}
                  onExpedite={() => onExpedite && onExpedite(r.entity_id)}
                  onUnexpedite={() => onUnexpedite && onUnexpedite(r.entity_id)}
                  onDeprioritise={() => onDeprioritise && onDeprioritise(r.entity_id, r.client)}
                  onReactivate={() => onReactivate && onReactivate(r.entity_id)}
                />
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
      )}
    </div>
  );
}

const td = { padding: '7px 10px', verticalAlign: 'middle' };
const thStatic = { padding: '8px 10px', borderBottom: '1px solid #e5e7eb' };

const ACTION_STYLES = {
  expedite:    { label: '⚡ Expedite',  border: '#fcd34d', background: '#fef3c7', color: '#b45309', title: 'Expedite — promote to top box' },
  unexpedite:  { label: 'Unexpedite',   border: '#cbd5e1', background: '#fff',    color: '#475569', title: 'Remove expedite' },
  deprioritise:{ label: 'Deprioritise', border: '#cbd5e1', background: '#fff',    color: '#475569', title: 'Park this client with a reason' },
  reactivate:  { label: 'Reactivate',   border: '#86efac', background: '#dcfce7', color: '#166534', title: 'Clear deprioritise reason' },
};
function RowAction({ kind, busy, onExpedite, onUnexpedite, onDeprioritise, onReactivate }) {
  const s = ACTION_STYLES[kind] || ACTION_STYLES.expedite;
  const handler = kind === 'expedite' ? onExpedite
    : kind === 'unexpedite' ? onUnexpedite
    : kind === 'deprioritise' ? onDeprioritise
    : kind === 'reactivate' ? onReactivate
    : () => {};
  return (
    <button
      disabled={busy}
      onClick={handler}
      title={s.title}
      style={{
        fontSize: 11, padding: '3px 8px', fontFamily: font, cursor: busy ? 'wait' : 'pointer',
        borderRadius: 6,
        border: '1px solid ' + s.border,
        background: s.background,
        color: s.color,
        fontWeight: 600,
      }}
    >
      {s.label}
    </button>
  );
}

const DEPRI_REASONS = ['Client Unresponsive', 'Being Struck Off', 'Awaiting Client', 'Other'];
function DeprioritiseDialog({ client, onCancel, onConfirm }) {
  const [choice, setChoice] = useState('');
  const [otherText, setOtherText] = useState('');
  const disabled = !choice || (choice === 'Other' && !otherText.trim());
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 10, padding: '18px 20px',
          width: 380, fontFamily: font, boxShadow: '0 20px 60px rgba(15,23,42,0.25)',
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', marginBottom: 4 }}>
          Deprioritise {client}
        </div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 14 }}>
          Pick a reason — the client will move into the Deprioritised box and stop appearing in Urgent.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {DEPRI_REASONS.map((r) => (
            <label key={r} style={{
              display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#0f172a',
              padding: '8px 10px', border: '1px solid ' + (choice === r ? '#0e7fe0' : '#e5e7eb'),
              borderRadius: 6, cursor: 'pointer', background: choice === r ? '#eff6ff' : '#fff',
            }}>
              <input type="radio" name="depri" checked={choice === r} onChange={() => setChoice(r)} />
              {r}
            </label>
          ))}
        </div>
        {choice === 'Other' && (
          <input
            autoFocus
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            placeholder="Reason…"
            style={{
              width: '100%', padding: '8px 10px', fontSize: 13, fontFamily: font,
              border: '1px solid #cbd5e1', borderRadius: 6, marginBottom: 14, boxSizing: 'border-box',
            }}
          />
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              fontSize: 12, padding: '6px 14px', fontFamily: font, cursor: 'pointer',
              borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', color: '#475569', fontWeight: 500,
            }}
          >Cancel</button>
          <button
            disabled={disabled}
            onClick={() => onConfirm(choice === 'Other' ? otherText.trim() : choice)}
            style={{
              fontSize: 12, padding: '6px 14px', fontFamily: font, cursor: disabled ? 'not-allowed' : 'pointer',
              borderRadius: 6, border: '1px solid #0f172a',
              background: disabled ? '#94a3b8' : '#0f172a', color: '#fff', fontWeight: 600,
            }}
          >Deprioritise</button>
        </div>
      </div>
    </div>
  );
}

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
