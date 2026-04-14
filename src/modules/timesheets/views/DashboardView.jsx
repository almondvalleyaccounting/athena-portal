import React, { useState, useEffect, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchAllCompletedForRange, fetchAllTimesheetEntriesForRange, fetchStaffList, fetchEntities } from '../lib/timesheetQueries';

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
function formatISO(d) { return d.toISOString().split('T')[0]; }

function formatWeekTitle(start) {
  const end = addDays(start, 6);
  return `${start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} — ${end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

function minutesToDisplay(mins) {
  if (!mins) return '0h';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/* ─── DashboardView ───────────────────────────────────────── */
export default function DashboardView() {
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const [staffList, setStaffList] = useState([]);
  const [entityList, setEntityList] = useState([]);
  const [completed, setCompleted] = useState([]);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  const weekStart = useMemo(() => startOfWeek(anchor), [anchor]);
  const weekStartISO = formatISO(weekStart);
  const weekEndISO = formatISO(addDays(weekStart, 7));

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
          fetchAllCompletedForRange(weekStartISO, weekEndISO),
          fetchAllTimesheetEntriesForRange(weekStartISO, weekEndISO),
        ]);
        setCompleted(c);
        setEntries(e);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, [weekStartISO, weekEndISO]);

  const entityMap = useMemo(() => {
    const m = {};
    entityList.forEach((e) => { m[e.id] = e; });
    return m;
  }, [entityList]);

  // ── Aggregations ──

  // Total minutes across all sources
  const allMinutes = useMemo(() => {
    let total = 0;
    completed.forEach((t) => { total += t.completion_mins || 0; });
    entries.forEach((e) => { total += e.minutes || 0; });
    return total;
  }, [completed, entries]);

  // By staff
  const byStaff = useMemo(() => {
    const map = {};
    staffList.forEach((s) => { map[s.id] = { name: s.name, minutes: 0 }; });

    completed.forEach((t) => {
      if (map[t.assignee_id]) map[t.assignee_id].minutes += t.completion_mins || 0;
    });
    entries.forEach((e) => {
      if (map[e.staff_id]) map[e.staff_id].minutes += e.minutes || 0;
    });

    return Object.entries(map)
      .map(([id, v]) => ({ id, ...v }))
      .filter((s) => s.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes);
  }, [completed, entries, staffList]);

  // By service
  const byService = useMemo(() => {
    const map = {};
    function add(svc, mins) {
      if (!svc) svc = 'Other';
      map[svc] = (map[svc] || 0) + mins;
    }
    completed.forEach((t) => { add(t.service, t.completion_mins || 0); });
    entries.forEach((e) => { add(e.service, e.minutes || 0); });
    return Object.entries(map)
      .map(([service, minutes]) => ({ service, minutes }))
      .sort((a, b) => b.minutes - a.minutes);
  }, [completed, entries]);

  // By client (top 10)
  const byClient = useMemo(() => {
    const map = {};
    function add(eid, mins) {
      const name = eid ? (entityMap[eid]?.name || 'Unknown') : 'No client';
      map[name] = (map[name] || 0) + mins;
    }
    completed.forEach((t) => { add(t.entity_id, t.completion_mins || 0); });
    entries.forEach((e) => { add(e.entity_id, e.minutes || 0); });
    return Object.entries(map)
      .map(([client, minutes]) => ({ client, minutes }))
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 10);
  }, [completed, entries, entityMap]);

  const maxServiceMins = byService.length > 0 ? byService[0].minutes : 1;
  const maxClientMins = byClient.length > 0 ? byClient[0].minutes : 1;

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1100, fontFamily: "'Outfit', sans-serif" }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 500, color: '#0f172a', margin: 0 }}>
          Timesheets Dashboard
        </h2>
        <div style={{ flex: 1 }} />
        <button onClick={() => setAnchor((p) => addDays(p, -7))} style={navBtn}><ChevronLeft size={16} /></button>
        <span style={{ fontSize: 14, fontWeight: 500, minWidth: 180, textAlign: 'center' }}>
          {formatWeekTitle(weekStart)}
        </span>
        <button onClick={() => setAnchor((p) => addDays(p, 7))} style={navBtn}><ChevronRight size={16} /></button>
        <button onClick={() => setAnchor(startOfWeek(new Date()))} style={navBtn}>Today</button>
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

          {/* Two-column layout */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            {/* Staff hours */}
            <div style={cardStyle}>
              <h3 style={sectionTitle}>Hours by Staff</h3>
              {byStaff.length === 0 ? (
                <div style={emptyStyle}>No data this week</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {byStaff.map((s) => (
                    <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 13, fontWeight: 500, color: '#0f172a', width: 100, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.name?.split(' ')[0]}
                      </span>
                      <div style={{ flex: 1, background: '#f1f5f9', borderRadius: 4, height: 18, overflow: 'hidden' }}>
                        <div style={{
                          width: `${Math.max(5, (s.minutes / (byStaff[0]?.minutes || 1)) * 100)}%`,
                          height: '100%', background: '#0e7fe0', borderRadius: 4,
                          transition: 'width 0.3s ease',
                        }} />
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#0f172a', width: 60, textAlign: 'right', flexShrink: 0 }}>
                        {minutesToDisplay(s.minutes)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Service breakdown */}
            <div style={cardStyle}>
              <h3 style={sectionTitle}>Hours by Service</h3>
              {byService.length === 0 ? (
                <div style={emptyStyle}>No data this week</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {byService.map((s) => (
                    <div key={s.service} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 12, color: '#64748b', width: 130, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.service}
                      </span>
                      <div style={{ flex: 1, background: '#f1f5f9', borderRadius: 4, height: 18, overflow: 'hidden' }}>
                        <div style={{
                          width: `${Math.max(5, (s.minutes / maxServiceMins) * 100)}%`,
                          height: '100%', background: '#d97706', borderRadius: 4,
                          transition: 'width 0.3s ease',
                        }} />
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#0f172a', width: 60, textAlign: 'right', flexShrink: 0 }}>
                        {minutesToDisplay(s.minutes)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Top clients */}
            <div style={{ ...cardStyle, gridColumn: '1 / -1' }}>
              <h3 style={sectionTitle}>Top Clients by Hours</h3>
              {byClient.length === 0 ? (
                <div style={emptyStyle}>No data this week</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {byClient.map((c) => (
                    <div key={c.client} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 12, fontWeight: 500, color: '#0f172a', width: 180, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.client}
                      </span>
                      <div style={{ flex: 1, background: '#f1f5f9', borderRadius: 4, height: 18, overflow: 'hidden' }}>
                        <div style={{
                          width: `${Math.max(5, (c.minutes / maxClientMins) * 100)}%`,
                          height: '100%', background: '#7c3aed', borderRadius: 4,
                          transition: 'width 0.3s ease',
                        }} />
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#0f172a', width: 60, textAlign: 'right', flexShrink: 0 }}>
                        {minutesToDisplay(c.minutes)}
                      </span>
                    </div>
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
    <div style={{
      flex: 1, background: '#fff', borderRadius: 12,
      border: '1px solid #e5e7eb', padding: '16px 20px',
    }}>
      <div style={{ fontSize: 11, fontWeight: 500, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: accent, fontFamily: "'Outfit', sans-serif" }}>
        {value}
      </div>
    </div>
  );
}

const cardStyle = {
  background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb',
  padding: '20px 24px',
};

const sectionTitle = {
  fontFamily: "'Outfit', sans-serif", fontSize: 13, fontWeight: 600,
  textTransform: 'uppercase', color: '#94a3b8', letterSpacing: '0.03em',
  marginBottom: 16, marginTop: 0,
};

const emptyStyle = {
  padding: 20, textAlign: 'center', color: '#cbd5e1', fontSize: 13,
};

const navBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  padding: '5px 10px', fontSize: 13, fontWeight: 500,
  fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb',
  borderRadius: 8, background: '#fff', color: '#1e293b',
  cursor: 'pointer', whiteSpace: 'nowrap',
};
