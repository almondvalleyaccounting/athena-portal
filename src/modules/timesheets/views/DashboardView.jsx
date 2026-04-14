import React, { useState, useEffect, useMemo } from 'react';
import { Download } from 'lucide-react';
import { fetchAllCompletedForRange, fetchAllTimesheetEntriesForRange, fetchStaffList, fetchEntities } from '../lib/timesheetQueries';

/* ─── Helpers ──────────────────────────────────────────────── */
function startOfWeek(d) {
  const date = new Date(d); const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff); date.setHours(0, 0, 0, 0); return date;
}
function startOfMonth(d) { const r = new Date(d); r.setDate(1); r.setHours(0,0,0,0); return r; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function addMonths(d, n) { const r = new Date(d); r.setMonth(r.getMonth() + n); return r; }
function formatISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function minutesToDisplay(mins) {
  if (!mins) return '0h';
  const h = Math.floor(mins / 60); const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function hoursDecimal(mins) { return mins ? (mins / 60).toFixed(2) : '0.00'; }

const PERIODS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This Week' },
  { id: 'month', label: 'This Month' },
  { id: 'last_month', label: 'Last Month' },
  { id: 'quarter', label: 'This Quarter' },
  { id: 'custom', label: 'Custom Range' },
];

function periodDates(period) {
  const now = new Date(); now.setHours(0,0,0,0);
  switch (period) {
    case 'today': return { from: now, to: addDays(now, 1) };
    case 'week': { const s = startOfWeek(now); return { from: s, to: addDays(s, 7) }; }
    case 'month': { const s = startOfMonth(now); return { from: s, to: addMonths(s, 1) }; }
    case 'last_month': { const s = addMonths(startOfMonth(now), -1); return { from: s, to: startOfMonth(now) }; }
    case 'quarter': {
      const q = Math.floor(now.getMonth() / 3) * 3;
      const s = new Date(now.getFullYear(), q, 1);
      return { from: s, to: addMonths(s, 3) };
    }
    default: return { from: startOfWeek(now), to: addDays(startOfWeek(now), 7) };
  }
}

/* ─── DashboardView ───────────────────────────────────────── */
export default function DashboardView() {
  const [period, setPeriod] = useState('week');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [staffList, setStaffList] = useState([]);
  const [entityList, setEntityList] = useState([]);
  const [completed, setCompleted] = useState([]);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  const dates = useMemo(() => {
    if (period === 'custom' && customFrom && customTo) {
      return { from: new Date(customFrom + 'T00:00:00'), to: addDays(new Date(customTo + 'T00:00:00'), 1) };
    }
    return periodDates(period);
  }, [period, customFrom, customTo]);

  const fromISO = formatISO(dates.from);
  const toISO = formatISO(dates.to);
  const rangeLabel = `${dates.from.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} — ${addDays(dates.to, -1).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;

  useEffect(() => {
    (async () => {
      try {
        const [staff, ents] = await Promise.all([fetchStaffList(), fetchEntities()]);
        setStaffList(staff);
        setEntityList(ents);
      } catch (e) { console.error(e); }
    })();
  }, []);

  useEffect(() => {
    setLoading(true);
    (async () => {
      try {
        const [c, e] = await Promise.all([
          fetchAllCompletedForRange(fromISO, toISO),
          fetchAllTimesheetEntriesForRange(fromISO, toISO),
        ]);
        setCompleted(c); setEntries(e);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, [fromISO, toISO]);

  const entityMap = useMemo(() => { const m = {}; entityList.forEach((e) => { m[e.id] = e; }); return m; }, [entityList]);
  const staffMap = useMemo(() => { const m = {}; staffList.forEach((s) => { m[s.id] = s; }); return m; }, [staffList]);

  // ── Aggregations ──
  const allMinutes = useMemo(() => {
    let t = 0;
    completed.forEach((c) => { t += c.completion_mins || 0; });
    entries.forEach((e) => { t += e.minutes || 0; });
    return t;
  }, [completed, entries]);

  const byStaff = useMemo(() => {
    const map = {};
    staffList.forEach((s) => { map[s.id] = { name: s.name, minutes: 0 }; });
    completed.forEach((t) => { if (map[t.assignee_id]) map[t.assignee_id].minutes += t.completion_mins || 0; });
    entries.forEach((e) => { if (map[e.staff_id]) map[e.staff_id].minutes += e.minutes || 0; });
    return Object.entries(map).map(([id, v]) => ({ id, ...v })).filter((s) => s.minutes > 0).sort((a, b) => b.minutes - a.minutes);
  }, [completed, entries, staffList]);

  const byService = useMemo(() => {
    const map = {};
    function add(svc, mins) { const k = svc || 'Other'; map[k] = (map[k] || 0) + mins; }
    completed.forEach((t) => { add(t.service, t.completion_mins || 0); });
    entries.forEach((e) => { add(e.service, e.minutes || 0); });
    return Object.entries(map).map(([service, minutes]) => ({ service, minutes })).sort((a, b) => b.minutes - a.minutes);
  }, [completed, entries]);

  const byClient = useMemo(() => {
    const map = {};
    function add(eid, mins) { const n = eid ? (entityMap[eid]?.name || 'Unknown') : 'No client'; map[n] = (map[n] || 0) + mins; }
    completed.forEach((t) => { add(t.entity_id, t.completion_mins || 0); });
    entries.forEach((e) => { add(e.entity_id, e.minutes || 0); });
    return Object.entries(map).map(([client, minutes]) => ({ client, minutes })).sort((a, b) => b.minutes - a.minutes).slice(0, 15);
  }, [completed, entries, entityMap]);

  // ── Billing-format export ──
  const handleExport = () => {
    const headers = ['Staff', 'Client', 'Service', 'Hours', 'Date Range'];
    const rows = [];

    // Group by staff → client → service
    const grouped = {};
    function addEntry(staffId, entityId, service, mins) {
      const sn = staffMap[staffId]?.name || 'Unknown';
      const cn = entityId ? (entityMap[entityId]?.name || 'Unknown') : 'No client';
      const sv = service || 'Other';
      const key = `${sn}|${cn}|${sv}`;
      grouped[key] = (grouped[key] || 0) + mins;
    }
    completed.forEach((t) => addEntry(t.assignee_id, t.entity_id, t.service, t.completion_mins || 0));
    entries.forEach((e) => addEntry(e.staff_id, e.entity_id, e.service, e.minutes || 0));

    Object.entries(grouped).sort().forEach(([key, mins]) => {
      const [staff, client, service] = key.split('|');
      rows.push([
        `"${staff}"`, `"${client}"`, `"${service}"`,
        hoursDecimal(mins),
        `"${rangeLabel}"`,
      ].join(','));
    });

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `timesheet-dashboard-${fromISO}-to-${formatISO(addDays(dates.to, -1))}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1100, fontFamily: "'Outfit', sans-serif" }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 500, color: '#0f172a', margin: 0 }}>
          Timesheets Dashboard
        </h2>
        <div style={{ flex: 1 }} />

        {/* Period selector */}
        <span style={labelStyle}>Period</span>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ ...selectStyle, fontWeight: 500 }}>
          {PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>

        {period === 'custom' && (
          <>
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} style={{ ...selectStyle, width: 130 }} />
            <span style={{ color: '#94a3b8' }}>to</span>
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} style={{ ...selectStyle, width: 130 }} />
          </>
        )}

        <span style={{ fontSize: 12, color: '#64748b' }}>{rangeLabel}</span>

        <button onClick={handleExport} style={{ ...navBtn, gap: 5 }}>
          <Download size={13} /> Export
        </button>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>Loading dashboard...</div>
      ) : (
        <>
          {/* Summary cards */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 28 }}>
            <StatCard label="Total Hours" value={minutesToDisplay(allMinutes)} accent="#0e7fe0" />
            <StatCard label="Staff Active" value={byStaff.length} accent="#059669" />
            <StatCard label="Services" value={byService.length} accent="#d97706" />
            <StatCard label="Clients" value={byClient.length} accent="#7c3aed" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            {/* Staff hours */}
            <div style={cardStyle}>
              <h3 style={sectionTitle}>Hours by Staff</h3>
              {byStaff.length === 0 ? <div style={emptyStyle}>No data</div> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {byStaff.map((s) => (
                    <BarRow key={s.id} label={s.name?.split(' ')[0]} value={s.minutes} max={byStaff[0]?.minutes} colour="#0e7fe0" />
                  ))}
                </div>
              )}
            </div>

            {/* Service breakdown */}
            <div style={cardStyle}>
              <h3 style={sectionTitle}>Hours by Service</h3>
              {byService.length === 0 ? <div style={emptyStyle}>No data</div> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {byService.map((s) => (
                    <BarRow key={s.service} label={s.service} value={s.minutes} max={byService[0]?.minutes} colour="#d97706" />
                  ))}
                </div>
              )}
            </div>

            {/* Top clients */}
            <div style={{ ...cardStyle, gridColumn: '1 / -1' }}>
              <h3 style={sectionTitle}>Top Clients by Hours</h3>
              {byClient.length === 0 ? <div style={emptyStyle}>No data</div> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {byClient.map((c) => (
                    <BarRow key={c.client} label={c.client} value={c.minutes} max={byClient[0]?.minutes} colour="#7c3aed" labelWidth={180} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ─── Sub-components ── */
function StatCard({ label, value, accent }) {
  return (
    <div style={{ flex: 1, background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '16px 20px' }}>
      <div style={{ fontSize: 11, fontWeight: 500, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: accent, fontFamily: "'Outfit', sans-serif" }}>{value}</div>
    </div>
  );
}

function BarRow({ label, value, max, colour, labelWidth = 100 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: '#0f172a', width: labelWidth, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <div style={{ flex: 1, background: '#f1f5f9', borderRadius: 4, height: 18, overflow: 'hidden' }}>
        <div style={{ width: `${Math.max(3, (value / (max || 1)) * 100)}%`, height: '100%', background: colour, borderRadius: 4, transition: 'width 0.3s ease' }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#0f172a', width: 60, textAlign: 'right', flexShrink: 0 }}>{minutesToDisplay(value)}</span>
    </div>
  );
}

const cardStyle = { background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '20px 24px' };
const sectionTitle = { fontFamily: "'Outfit', sans-serif", fontSize: 13, fontWeight: 600, textTransform: 'uppercase', color: '#94a3b8', letterSpacing: '0.03em', marginBottom: 16, marginTop: 0 };
const emptyStyle = { padding: 20, textAlign: 'center', color: '#cbd5e1', fontSize: 13 };
const navBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '5px 10px', fontSize: 13, fontWeight: 500, fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', color: '#1e293b', cursor: 'pointer', whiteSpace: 'nowrap' };
const selectStyle = { padding: '5px 10px', fontSize: 12, fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#1e293b', outline: 'none' };
const labelStyle = { fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.03em' };
