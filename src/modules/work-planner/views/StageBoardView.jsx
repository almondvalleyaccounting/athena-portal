import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { fetchAccountsJobs } from '../plan/planQueries';
import { useWorkPlanner } from '../WorkPlannerModule';
import Avatar from '../components/Avatar';

// Stage board — the management report Bobby wanted the Kanban to be: every
// accounts job in the column of its current stage, filtered by the team bar.
// Nothing here is dragged; a job moves when its plan's stages are done.

const font = "'Outfit', sans-serif";

const GROUPS = [
  { id: 'unplanned', label: 'Not planned', colour: '#94a3b8' },
  { id: 'records', label: 'Records', colour: '#d97706', keys: ['request_records', 'chase_1', 'chase_2', 'records_in', 'close_books'] },
  { id: 'prepare', label: 'Prepare', colour: '#0e7fe0', keys: ['prepare'] },
  { id: 'review', label: 'Review', colour: '#7c3aed', keys: ['internal_review'] },
  { id: 'client', label: 'With client', colour: '#db2777', keys: ['client_meeting', 'send_for_approval', 'approval'] },
  { id: 'filing', label: 'Filing', colour: '#059669', keys: ['file_ch', 'file_ct600', 'ct_payment_reminder'] },
  { id: 'done', label: 'Done', colour: '#166534' },
];
const KEY_TO_GROUP = {};
GROUPS.forEach((g) => (g.keys || []).forEach((k) => { KEY_TO_GROUP[k] = g.id; }));

const RISK = {
  urgent: { label: 'Urgent', bg: '#fee2e2', fg: '#991b1b' },
  at_risk: { label: 'At risk', bg: '#ffedd5', fg: '#9a3412' },
  waiting_on_client: { label: 'Waiting', bg: '#fef3c7', fg: '#92400e' },
  slipped: { label: 'Slipped', bg: '#e0f2fe', fg: '#075985' },
};

function fmt(iso) { return iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''; }

export default function StageBoardView() {
  const navigate = useNavigate();
  const { filters, staffMap, staffColours } = useWorkPlanner();
  const [jobs, setJobs] = useState([]);
  const [plans, setPlans] = useState(new Map()); // plan_id -> { risk, milestones[] }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const js = await fetchAccountsJobs();
      setJobs(js);
      const ids = js.filter((j) => j.plan_status === 'committed').map((j) => j.plan_id);
      const map = new Map();
      for (let i = 0; i < ids.length; i += 150) {
        const slice = ids.slice(i, i + 150);
        const [{ data: ms, error: mErr }, { data: ps, error: pErr }] = await Promise.all([
          supabase.from('job_milestones').select('plan_id, stage_key, seq, label, status, due_date').in('plan_id', slice).order('seq'),
          supabase.from('job_plans').select('id, risk, risk_reason').in('id', slice),
        ]);
        if (mErr) throw mErr;
        if (pErr) throw pErr;
        for (const p of ps || []) map.set(p.id, { risk: p.risk, risk_reason: p.risk_reason, milestones: [] });
        for (const m of ms || []) map.get(m.plan_id)?.milestones.push(m);
      }
      setPlans(map);
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const columns = useMemo(() => {
    const cols = Object.fromEntries(GROUPS.map((g) => [g.id, []]));
    let list = jobs;
    if (filters.teamFilter) list = list.filter((j) => j.preparer_id === filters.teamFilter);
    if (filters.clientFilter) list = list.filter((j) => j.entity_id === filters.clientFilter);
    for (const j of list) {
      let group = 'unplanned';
      let next = null;
      let risk = null;
      const p = j.plan_status === 'committed' ? plans.get(j.plan_id) : null;
      if (p) {
        risk = p.risk;
        const pending = p.milestones.filter((m) => m.status === 'pending');
        if (pending.length === 0) group = 'done';
        else { next = pending[0]; group = KEY_TO_GROUP[next.stage_key] || 'records'; }
      }
      cols[group].push({ ...j, next, risk, risk_reason: p?.risk_reason });
    }
    for (const g of GROUPS) cols[g.id].sort((a, b) => (a.next?.due_date || a.ch_deadline || '').localeCompare(b.next?.due_date || b.ch_deadline || ''));
    return cols;
  }, [jobs, plans, filters.teamFilter, filters.clientFilter]);

  if (loading) return <div style={{ padding: 20, color: '#94a3b8', fontFamily: font }}>Loading the board…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: font }}>
      {error && <div style={{ margin: 10, padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13.5 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 10, padding: 10, flex: 1, overflowX: 'auto', minHeight: 0 }}>
        {GROUPS.map((g) => {
          const items = columns[g.id];
          return (
            <div key={g.id} style={{ flex: 1, minWidth: 190, maxWidth: 260, display: 'flex', flexDirection: 'column', background: '#f8fafc', borderRadius: 10, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 10, borderBottom: '1px solid #e5e7eb', background: '#fff' }}>
                <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: g.colour }} />{g.label}
                </div>
                <span style={{ fontSize: 12, color: '#94a3b8', padding: '1px 5px', borderRadius: 6, border: '1px solid #f1f5f9' }}>{items.length}</span>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: 5 }}>
                {items.map((j) => {
                  const r = RISK[j.risk];
                  return (
                    <div key={`${j.entity_id}|${j.period_end}`} onClick={() => navigate(`/planner/plan/${j.entity_id}/${j.period_end}`)}
                      style={{ padding: '7px 9px', background: '#fff', border: '1px solid #e5e7eb', borderLeft: `3px solid ${g.colour}`, borderRadius: 6, marginBottom: 5, cursor: 'pointer' }}>
                      <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 2 }}>{j.client}</div>
                      <div style={{ fontSize: 11.5, color: '#64748b', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                        {j.preparer_id && <Avatar id={j.preparer_id} staffMap={staffMap} size={16} customColour={staffColours?.[j.preparer_id]} />}
                        <span>YE {fmt(j.period_end)}</span>
                        {r && <span title={j.risk_reason || ''} style={{ padding: '0 6px', borderRadius: 8, fontSize: 10.5, fontWeight: 600, background: r.bg, color: r.fg }}>{r.label}</span>}
                      </div>
                      <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 2 }}>
                        {j.next ? `${j.next.label} · ${fmt(j.next.due_date)}` : g.id === 'unplanned' ? `Companies House ${fmt(j.ch_deadline)}` : g.id === 'done' ? 'All stages done' : ''}
                      </div>
                    </div>
                  );
                })}
                {items.length === 0 && <div style={{ padding: 14, fontSize: 12.5, color: '#cbd5e1', textAlign: 'center' }}>None</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
