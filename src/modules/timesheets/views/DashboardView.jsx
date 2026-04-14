import React, { useState, useEffect, useMemo } from 'react';
import { Download, ChevronDown } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
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
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function minutesToDisplay(mins) {
  if (!mins) return '0h';
  const h = Math.floor(mins / 60); const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function hoursDecimal(mins) { return mins ? (mins / 60).toFixed(2) : '0.00'; }
const fmt = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2 }).format(n || 0);

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
    case 'quarter': { const q = Math.floor(now.getMonth()/3)*3; const s = new Date(now.getFullYear(),q,1); return { from: s, to: addMonths(s, 3) }; }
    default: return { from: startOfWeek(now), to: addDays(startOfWeek(now), 7) };
  }
}

export default function DashboardView() {
  const [period, setPeriod] = useState('week');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [staffList, setStaffList] = useState([]);
  const [entityList, setEntityList] = useState([]);
  const [completed, setCompleted] = useState([]);
  const [entries, setEntries] = useState([]);
  const [billingData, setBillingData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedSection, setExpandedSection] = useState(null); // 'staff:id', 'service:name', 'client:name'

  const dates = useMemo(() => {
    if (period === 'custom' && customFrom && customTo)
      return { from: new Date(customFrom+'T00:00:00'), to: addDays(new Date(customTo+'T00:00:00'), 1) };
    return periodDates(period);
  }, [period, customFrom, customTo]);

  const fromISO = formatISO(dates.from);
  const toISO = formatISO(dates.to);
  const rangeLabel = `${dates.from.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})} — ${addDays(dates.to,-1).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}`;

  useEffect(() => {
    (async () => {
      try {
        const [staff, ents] = await Promise.all([fetchStaffList(), fetchEntities()]);
        setStaffList(staff); setEntityList(ents);
      } catch (e) { console.error(e); }
    })();
  }, []);

  useEffect(() => {
    setLoading(true);
    (async () => {
      try {
        const [c, e, { data: billing }] = await Promise.all([
          fetchAllCompletedForRange(fromISO, toISO),
          fetchAllTimesheetEntriesForRange(fromISO, toISO),
          supabase.from('live_billing').select('entity_id, service_description, monthly_fee').order('entity_id'),
        ]);
        setCompleted(c); setEntries(e); setBillingData(billing || []);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, [fromISO, toISO]);

  const entityMap = useMemo(() => { const m = {}; entityList.forEach((e) => { m[e.id] = e; }); return m; }, [entityList]);
  const staffMap = useMemo(() => { const m = {}; staffList.forEach((s) => { m[s.id] = s; }); return m; }, [staffList]);

  // All time entries merged
  const allEntries = useMemo(() => {
    const arr = [];
    completed.forEach((t) => arr.push({ ...t, _mins: t.completion_mins || 0, _source: 'completed', _staff: t.assignee_id, _entity: t.entity_id }));
    entries.forEach((e) => arr.push({ ...e, _mins: e.minutes || 0, _source: 'manual', _staff: e.staff_id, _entity: e.entity_id }));
    return arr;
  }, [completed, entries]);

  const allMinutes = allEntries.reduce((s, e) => s + e._mins, 0);

  // Aggregations
  const byStaff = useMemo(() => {
    const map = {};
    staffList.forEach((s) => { map[s.id] = { id: s.id, name: s.name, minutes: 0 }; });
    allEntries.forEach((e) => { if (map[e._staff]) map[e._staff].minutes += e._mins; });
    return Object.values(map).filter((s) => s.minutes > 0).sort((a, b) => b.minutes - a.minutes);
  }, [allEntries, staffList]);

  const byService = useMemo(() => {
    const map = {};
    allEntries.forEach((e) => { const k = e.service || 'Other'; map[k] = (map[k] || 0) + e._mins; });
    return Object.entries(map).map(([service, minutes]) => ({ service, minutes })).sort((a, b) => b.minutes - a.minutes);
  }, [allEntries]);

  const byClient = useMemo(() => {
    const map = {};
    allEntries.forEach((e) => {
      const eid = e._entity;
      const n = eid ? (entityMap[eid]?.name || 'Unknown') : 'No client';
      if (!map[n]) map[n] = { client: n, entityId: eid, minutes: 0 };
      map[n].minutes += e._mins;
    });
    return Object.values(map).sort((a, b) => b.minutes - a.minutes).slice(0, 20);
  }, [allEntries, entityMap]);

  // Billing by client (for comparison)
  const billingByClient = useMemo(() => {
    const map = {};
    billingData.forEach((b) => {
      const n = b.entity_id ? (entityMap[b.entity_id]?.name || 'Unknown') : 'No client';
      if (!map[n]) map[n] = { monthly: 0, annual: 0 };
      map[n].monthly += parseFloat(b.monthly_fee) || 0;
      map[n].annual += (parseFloat(b.monthly_fee) || 0) * 12;
    });
    return map;
  }, [billingData, entityMap]);

  // Get transactions for a drilldown
  const getTransactions = (filterFn) => allEntries.filter(filterFn).sort((a, b) => new Date(b.completed_at || b.work_date) - new Date(a.completed_at || a.work_date));

  const toggleExpand = (key) => setExpandedSection(expandedSection === key ? null : key);

  // Export
  const handleExport = () => {
    const headers = ['Staff', 'Client', 'Service', 'Hours', 'Date Range'];
    const grouped = {};
    allEntries.forEach((e) => {
      const sn = staffMap[e._staff]?.name || 'Unknown';
      const cn = e._entity ? (entityMap[e._entity]?.name || 'Unknown') : 'No client';
      const sv = e.service || 'Other';
      const key = `${sn}|${cn}|${sv}`;
      grouped[key] = (grouped[key] || 0) + e._mins;
    });
    const rows = Object.entries(grouped).sort().map(([key, mins]) => {
      const [staff, client, service] = key.split('|');
      return [`"${staff}"`,`"${client}"`,`"${service}"`,hoursDecimal(mins),`"${rangeLabel}"`].join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `timesheet-dashboard-${fromISO}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1100, fontFamily: "'Outfit', sans-serif" }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 500, color: '#0f172a', margin: 0 }}>Timesheets Dashboard</h2>
        <div style={{ flex: 1 }} />
        <span style={labelStyle}>Period</span>
        <select value={period} onChange={(e) => { setPeriod(e.target.value); setExpandedSection(null); }} style={{ ...selectStyle, fontWeight: 500 }}>
          {PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        {period === 'custom' && (<>
          <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} style={{ ...selectStyle, width: 130 }} />
          <span style={{ color: '#94a3b8' }}>to</span>
          <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} style={{ ...selectStyle, width: 130 }} />
        </>)}
        <span style={{ fontSize: 12, color: '#64748b' }}>{rangeLabel}</span>
        <button onClick={handleExport} style={{ ...navBtn, gap: 5 }}><Download size={13} /> Export</button>
      </div>

      {loading ? <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>Loading dashboard...</div> : (<>
        {/* Summary cards */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 28 }}>
          <StatCard label="Total Hours" value={minutesToDisplay(allMinutes)} accent="#0e7fe0" />
          <StatCard label="Staff Active" value={byStaff.length} accent="#059669" />
          <StatCard label="Services" value={byService.length} accent="#d97706" />
          <StatCard label="Clients" value={byClient.length} accent="#7c3aed" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          {/* Staff hours — clickable */}
          <div style={cardStyle}>
            <h3 style={sectionTitle}>Hours by Staff</h3>
            {byStaff.length === 0 ? <div style={emptyStyle}>No data</div> : byStaff.map((s) => {
              const key = `staff:${s.id}`;
              const isOpen = expandedSection === key;
              const txns = isOpen ? getTransactions((e) => e._staff === s.id) : [];
              return (
                <div key={s.id}>
                  <BarRow label={s.name?.split(' ')[0]} value={s.minutes} max={byStaff[0]?.minutes} colour="#0e7fe0" onClick={() => toggleExpand(key)} active={isOpen} />
                  {isOpen && <TransactionList items={txns} entityMap={entityMap} staffMap={staffMap} />}
                </div>
              );
            })}
          </div>

          {/* Service breakdown — clickable */}
          <div style={cardStyle}>
            <h3 style={sectionTitle}>Hours by Service</h3>
            {byService.length === 0 ? <div style={emptyStyle}>No data</div> : byService.map((s) => {
              const key = `service:${s.service}`;
              const isOpen = expandedSection === key;
              const txns = isOpen ? getTransactions((e) => (e.service || 'Other') === s.service) : [];
              return (
                <div key={s.service}>
                  <BarRow label={s.service} value={s.minutes} max={byService[0]?.minutes} colour="#d97706" onClick={() => toggleExpand(key)} active={isOpen} />
                  {isOpen && <TransactionList items={txns} entityMap={entityMap} staffMap={staffMap} />}
                </div>
              );
            })}
          </div>

          {/* Top 20 clients — clickable + billing comparison */}
          <div style={{ ...cardStyle, gridColumn: '1 / -1' }}>
            <h3 style={sectionTitle}>Top 20 Clients — Hours vs Billing</h3>
            {byClient.length === 0 ? <div style={emptyStyle}>No data</div> : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                    <th style={thStyle}>Client</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Hours Logged</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Monthly Billing</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Annual Billing</th>
                    <th style={{ ...thStyle, width: 30 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {byClient.map((c) => {
                    const key = `client:${c.client}`;
                    const isOpen = expandedSection === key;
                    const bill = billingByClient[c.client];
                    const txns = isOpen ? getTransactions((e) => {
                      const n = e._entity ? (entityMap[e._entity]?.name || 'Unknown') : 'No client';
                      return n === c.client;
                    }) : [];
                    return (
                      <React.Fragment key={c.client}>
                        <tr onClick={() => toggleExpand(key)} style={{ cursor: 'pointer', borderBottom: '1px solid #f1f5f9', background: isOpen ? '#f8fafc' : 'transparent' }}>
                          <td style={{ padding: '8px 10px', fontWeight: 500, color: '#0f172a' }}>{c.client}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600, color: '#0f172a' }}>{minutesToDisplay(c.minutes)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', color: bill ? '#059669' : '#cbd5e1' }}>{bill ? fmt(bill.monthly) : '—'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', color: bill ? '#059669' : '#cbd5e1' }}>{bill ? fmt(bill.annual) : '—'}</td>
                          <td style={{ padding: '8px 4px', textAlign: 'center' }}>
                            <ChevronDown size={14} style={{ color: '#94a3b8', transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
                          </td>
                        </tr>
                        {isOpen && (
                          <tr><td colSpan={5} style={{ padding: 0 }}>
                            <TransactionList items={txns} entityMap={entityMap} staffMap={staffMap} />
                          </td></tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </>)}
    </div>
  );
}

/* ─── Transaction drilldown list ── */
function TransactionList({ items, entityMap, staffMap }) {
  if (items.length === 0) return <div style={{ padding: '8px 16px', fontSize: 11, color: '#cbd5e1' }}>No transactions</div>;
  return (
    <div style={{ background: '#f8fafc', borderRadius: 6, margin: '4px 0 8px', padding: '6px 0', maxHeight: 200, overflowY: 'auto' }}>
      {items.slice(0, 30).map((t, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, padding: '4px 12px', fontSize: 11, borderBottom: '1px solid #f1f5f9' }}>
          <span style={{ color: '#0f172a', fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title || t.service || '—'}</span>
          <span style={{ color: '#64748b', flexShrink: 0 }}>{t._entity ? (entityMap[t._entity]?.name || '') : ''}</span>
          <span style={{ color: '#94a3b8', flexShrink: 0 }}>{staffMap[t._staff]?.name?.split(' ')[0] || ''}</span>
          <span style={{ fontWeight: 600, color: '#0f172a', flexShrink: 0, width: 50, textAlign: 'right' }}>{minutesToDisplay(t._mins)}</span>
          <span style={{ color: '#cbd5e1', flexShrink: 0, width: 55, textAlign: 'right', fontSize: 10 }}>{new Date(t.completed_at || t.work_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
        </div>
      ))}
      {items.length > 30 && <div style={{ padding: '4px 12px', fontSize: 10, color: '#94a3b8' }}>...and {items.length - 30} more</div>}
    </div>
  );
}

function StatCard({ label, value, accent }) {
  return (
    <div style={{ flex: 1, background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '16px 20px' }}>
      <div style={{ fontSize: 11, fontWeight: 500, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: accent, fontFamily: "'Outfit', sans-serif" }}>{value}</div>
    </div>
  );
}

function BarRow({ label, value, max, colour, labelWidth = 100, onClick, active }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: onClick ? 'pointer' : 'default', padding: '4px 0', borderRadius: 4, background: active ? '#f8fafc' : 'transparent', marginBottom: 2 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: '#0f172a', width: labelWidth, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <div style={{ flex: 1, background: '#f1f5f9', borderRadius: 4, height: 18, overflow: 'hidden' }}>
        <div style={{ width: `${Math.max(3, (value / (max || 1)) * 100)}%`, height: '100%', background: colour, borderRadius: 4, transition: 'width 0.3s ease' }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#0f172a', width: 60, textAlign: 'right', flexShrink: 0 }}>{minutesToDisplay(value)}</span>
      {onClick && <ChevronDown size={12} style={{ color: '#94a3b8', flexShrink: 0, transform: active ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />}
    </div>
  );
}

const thStyle = { padding: '8px 10px', fontSize: 11, fontWeight: 600, color: '#64748b', textAlign: 'left', textTransform: 'uppercase', fontFamily: "'Outfit', sans-serif" };
const cardStyle = { background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '20px 24px' };
const sectionTitle = { fontFamily: "'Outfit', sans-serif", fontSize: 13, fontWeight: 600, textTransform: 'uppercase', color: '#94a3b8', letterSpacing: '0.03em', marginBottom: 16, marginTop: 0 };
const emptyStyle = { padding: 20, textAlign: 'center', color: '#cbd5e1', fontSize: 13 };
const navBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '5px 10px', fontSize: 13, fontWeight: 500, fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', color: '#1e293b', cursor: 'pointer', whiteSpace: 'nowrap' };
const selectStyle = { padding: '5px 10px', fontSize: 12, fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#1e293b', outline: 'none' };
const labelStyle = { fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.03em' };
