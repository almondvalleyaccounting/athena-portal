import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { BTN } from '../../../lib/buttonStyles';
import { addMonthsClamped } from '../../../lib/monthMath';

// Team — one row per person, the signals a practice director asked for:
// unplanned jobs, slipped and upcoming stages, plans waiting on the client or
// at risk, past-deadline BM jobs, open actions, load against capacity, hours
// logged. Every count opens the list behind it. Reads v_work_signals (sql/305).

const font = "'Outfit', sans-serif";

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDaysISO(iso, n) { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function fmt(iso) { return iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
function ago(ts) {
  if (!ts) return 'never';
  const days = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`;
}

const COLS = [
  { key: 'unplanned_jobs', label: 'Unplanned', hint: 'Accounts jobs with a statutory date inside seven months and no committed plan', bad: (v) => v > 0 },
  { key: 'slipped_stages', label: 'Slipped', hint: 'Stages past their date on committed plans', bad: (v) => v > 0 },
  { key: 'waiting_on_client', label: 'Waiting on client', hint: 'Plans where records or approval are overdue', bad: () => false },
  { key: 'at_risk', label: 'At risk', hint: 'Plans clamped to, or inside, the statutory buffer', bad: (v) => v > 0 },
  { key: 'past_deadline_jobs', label: 'Past deadline', hint: 'BrightManager jobs past their statutory date, still open', bad: (v) => v > 0 },
  { key: 'stages_this_week', label: 'Due this week', hint: 'Stages due in the next seven days', bad: () => false },
  { key: 'open_actions', label: 'Actions', hint: 'Open quick tasks (overdue in brackets)', bad: () => false },
];

export default function TeamView() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [drawer, setDrawer] = useState(null); // { staff, col, items, loading }

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { data, error: e } = await supabase.from('v_work_signals').select('*').order('name');
      if (e) throw e;
      setRows(data || []);
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openList = async (staff, col) => {
    setDrawer({ staff, col, items: [], loading: true });
    const today = todayISO();
    let items = [];
    try {
      if (col.key === 'unplanned_jobs') {
        const { data } = await supabase.from('v_accounts_jobs').select('entity_id, client, period_end, ch_deadline, plan_status')
          .eq('preparer_id', staff.staff_id).lte('ch_deadline', addMonthsClamped(today, 7)).order('ch_deadline').limit(200);
        items = (data || []).filter((j) => j.plan_status !== 'committed').map((j) => ({
          key: `${j.entity_id}|${j.period_end}`, title: j.client, sub: `Year end ${fmt(j.period_end)} · Companies House ${fmt(j.ch_deadline)} · ${j.plan_status || 'not planned'}`,
          go: () => navigate(`/planner/plan/${j.entity_id}/${j.period_end}`),
        }));
      } else if (col.key === 'slipped_stages' || col.key === 'stages_this_week') {
        let q = supabase.from('job_milestones').select('id, label, due_date, job_plans!inner(entity_id, period_end, status, risk, entities(name))')
          .eq('owner_id', staff.staff_id).eq('status', 'pending').eq('job_plans.status', 'committed').order('due_date').limit(200);
        q = col.key === 'slipped_stages' ? q.lt('due_date', today) : q.gte('due_date', today).lte('due_date', addDaysISO(today, 7));
        const { data } = await q;
        items = (data || []).map((m) => ({
          key: m.id, title: `${m.label} · ${m.job_plans.entities?.name}`, sub: `Due ${fmt(m.due_date)}`,
          go: () => navigate(`/planner/plan/${m.job_plans.entity_id}/${m.job_plans.period_end}`),
        }));
      } else if (col.key === 'waiting_on_client' || col.key === 'at_risk') {
        const risks = col.key === 'waiting_on_client' ? ['waiting_on_client'] : ['at_risk', 'urgent'];
        const { data } = await supabase.from('job_milestones').select('plan_id, job_plans!inner(id, entity_id, period_end, status, risk, risk_reason, entities(name))')
          .eq('owner_id', staff.staff_id).eq('owner_role', 'preparer').eq('job_plans.status', 'committed').in('job_plans.risk', risks).limit(300);
        const seen = new Set();
        items = (data || []).filter((r) => (seen.has(r.plan_id) ? false : seen.add(r.plan_id))).map((r) => ({
          key: r.plan_id, title: r.job_plans.entities?.name, sub: `${r.job_plans.risk_reason || r.job_plans.risk} · Year end ${fmt(r.job_plans.period_end)}`,
          go: () => navigate(`/planner/plan/${r.job_plans.entity_id}/${r.job_plans.period_end}`),
        }));
      } else if (col.key === 'past_deadline_jobs') {
        const { data } = await supabase.from('bm_task_schedule').select('id, bm_task_name, bm_deadline, bm_status, entities(name)')
          .eq('assignee_id', staff.staff_id).eq('state', 'planned').is('excluded_at', null).lt('bm_deadline', today).order('bm_deadline').limit(200);
        items = (data || []).map((b) => ({ key: b.id, title: `${b.entities?.name} · ${b.bm_task_name}`, sub: `Deadline ${fmt(b.bm_deadline)} · ${b.bm_status || ''}` }));
      } else if (col.key === 'open_actions') {
        const { data } = await supabase.from('quick_tasks').select('id, title, due_date, entities(name)')
          .eq('assignee_id', staff.staff_id).order('due_date', { ascending: true, nullsFirst: false }).limit(200);
        items = (data || []).map((t) => ({ key: t.id, title: t.title, sub: `${t.entities?.name || ''}${t.due_date ? ` · due ${fmt(t.due_date.slice(0, 10))}` : ''}`, go: () => navigate('/planner/quick') }));
      }
    } catch (e) { setError(e.message || String(e)); }
    setDrawer({ staff, col, items, loading: false });
  };

  const loadColour = (r) => {
    const cap = Number(r.capacity_hours_14d) || 0;
    const used = Number(r.scheduled_hours_14d) || 0;
    const pct = cap ? used / cap : 0;
    return pct > 1.2 ? '#991b1b' : pct > 1 ? '#9a3412' : pct > 0.8 ? '#92400e' : '#166534';
  };

  return (
    <div style={{ padding: '16px 20px', fontFamily: font, display: 'flex', flexDirection: 'column', gap: 12, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#0f172a' }}>Team</div>
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>Who is behind, who is waiting on a client, who is loaded. Click a number for the list behind it.</div>
        </div>
        <button onClick={load} style={BTN.secondary.sm}>Refresh</button>
      </div>
      {error && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13.5 }}>{error}</div>}

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'auto' }}>
        {loading ? <div style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>Loading…</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
            <thead>
              <tr>
                <th style={th}>Person</th>
                {COLS.map((c) => <th key={c.key} style={{ ...th, textAlign: 'right' }} title={c.hint}>{c.label}</th>)}
                <th style={{ ...th, textAlign: 'right' }} title="BrightManager hours scheduled in the next 14 days against capacity">Load 14d</th>
                <th style={{ ...th, textAlign: 'right' }} title="Hours logged on timesheets in the last 7 days">Logged 7d</th>
                <th style={{ ...th, textAlign: 'right' }}>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.staff_id}>
                  <td style={{ ...td, fontWeight: 500 }}>{r.name}</td>
                  {COLS.map((c) => {
                    const v = Number(r[c.key]) || 0;
                    const extra = c.key === 'open_actions' && Number(r.overdue_actions) ? ` (${r.overdue_actions})` : '';
                    return (
                      <td key={c.key} style={{ ...td, textAlign: 'right' }}>
                        {v === 0 ? <span style={{ color: '#cbd5e1' }}>0</span> : (
                          <button onClick={() => openList(r, c)} style={{ ...BTN.secondary.sm, padding: '2px 8px', color: c.bad(v) ? '#b91c1c' : '#0f172a', fontWeight: 600, borderColor: c.bad(v) ? '#fecaca' : '#cbd5e1' }}>
                            {v}{extra}
                          </button>
                        )}
                      </td>
                    );
                  })}
                  <td style={{ ...td, textAlign: 'right', color: loadColour(r), fontWeight: 600 }}>{Number(r.scheduled_hours_14d)}h / {Number(r.capacity_hours_14d)}h</td>
                  <td style={{ ...td, textAlign: 'right', color: Number(r.hours_logged_7d) ? '#0f172a' : '#cbd5e1' }}>{Number(r.hours_logged_7d)}h</td>
                  <td style={{ ...td, textAlign: 'right', color: '#64748b' }}>{ago(r.last_activity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {drawer && (
        <div onClick={() => setDrawer(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.2)', zIndex: 100, display: 'flex', justifyContent: 'flex-end' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 460, maxWidth: '92vw', background: '#fff', height: '100%', overflow: 'auto', padding: 18, boxShadow: '-4px 0 16px rgba(0,0,0,0.12)', fontFamily: font }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{drawer.col.label} · {drawer.staff.name}</div>
                <div style={{ fontSize: 12.5, color: '#64748b' }}>{drawer.col.hint}</div>
              </div>
              <button onClick={() => setDrawer(null)} style={BTN.secondary.sm}>Close</button>
            </div>
            {drawer.loading ? <div style={{ color: '#94a3b8' }}>Loading…</div> : drawer.items.length === 0 ? <div style={{ color: '#94a3b8' }}>Nothing here.</div> : drawer.items.map((it) => (
              <div key={it.key} style={{ padding: '8px 0', borderBottom: '1px solid #f1f5f9' }}>
                {it.go ? (
                  <button onClick={it.go} style={{ background: 'none', border: 'none', padding: 0, color: '#0e7fe0', cursor: 'pointer', fontFamily: font, fontSize: 13.5, fontWeight: 500, textAlign: 'left' }}>{it.title}</button>
                ) : <div style={{ fontSize: 13.5, fontWeight: 500 }}>{it.title}</div>}
                <div style={{ fontSize: 12.5, color: '#64748b' }}>{it.sub}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const th = { padding: '8px 10px', fontSize: 11.5, fontWeight: 600, color: '#64748b', textAlign: 'left', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
const td = { padding: '7px 10px', borderBottom: '1px solid #f1f5f9', whiteSpace: 'nowrap' };
