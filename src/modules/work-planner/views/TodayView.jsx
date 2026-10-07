import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { BTN } from '../../../lib/buttonStyles';
import { useAuth } from '../../../shell/AppShell';
import { callJobPlan } from '../plan/planQueries';
import OverviewDashboard from '../components/OverviewDashboard';
import { generateInstances } from '../lib/instanceEngine';
import { useWorkPlanner } from '../WorkPlannerModule';

// Overview — the team dashboard (OverviewDashboard) and, under it, the things
// that need a decision: a client who has been in touch, a holiday handover,
// jobs at risk, and BM jobs completed here but not yet in BrightManager.
// The per-stage lists went on 2026-09-27; the dashboard tiles replace them.

const font = "'Outfit', sans-serif";

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmt(iso) {
  if (!iso) return '';
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
const RISK = {
  urgent: { label: 'Urgent', bg: '#fee2e2', fg: '#991b1b' },
  at_risk: { label: 'At risk', bg: '#ffedd5', fg: '#9a3412' },
  waiting_on_client: { label: 'Waiting on client', bg: '#fef3c7', fg: '#92400e' },
  slipped: { label: 'Slipped', bg: '#e0f2fe', fg: '#075985' },
};
const pill = (r) => ({
  display: 'inline-block', padding: '1px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
  background: r.bg, color: r.fg, whiteSpace: 'nowrap',
});


export default function TodayView({ onOpenTask, onOpenHolidays }) {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [attention, setAttention] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const { staffMap, holidays = [], scheduledTasks = [], overridesMap, completedKeys } = useWorkPlanner();
  const [signals, setSignals] = useState([]); // plans where the client replied or uploaded (sql/319)
  const [handoverState, setHandoverState] = useState({}); // holiday id -> { undecided, unsent }
  const [toUpdate, setToUpdate] = useState([]); // BM jobs done here, not yet confirmed in BM (sql/311)
  // Delay and stuck reports still open (sql/350), for managers. Nobody is
  // asked for updates any more; this is the only progress box on Overview.
  const [reports, setReports] = useState([]);
  const today = todayISO();
  useEffect(() => {
    if (!profile?.can_manage_portal) return;
    callJobPlan({ action: 'progress_reports' }).then((r) => setReports(r.reports || [])).catch(() => { /* the box just stays hidden */ });
  }, [profile?.can_manage_portal]);

  const load = useCallback(async () => {
    if (!profile?.id) return;
    setLoading(true); setError(null);
    try {
      const { data: mine, error: aErr } = await supabase.from('job_milestones')
        .select('plan_id, job_plans!inner(id, entity_id, period_end, status, risk, risk_reason, entities(name))')
        .eq('owner_id', profile.id).eq('owner_role', 'preparer').eq('job_plans.status', 'committed')
        .in('job_plans.risk', ['waiting_on_client', 'at_risk', 'urgent']).limit(500);
      if (aErr) throw aErr;
      const { data: comps } = await supabase.from('bm_task_completions')
        .select('id, bm_task_name, completed_at, minutes, entities(name)')
        .eq('completed_by', profile.id).is('confirmed_at', null).order('completed_at', { ascending: false }).limit(200);
      setToUpdate(comps || []);
      const seen = new Set();
      setAttention((mine || []).filter((r) => (seen.has(r.plan_id) ? false : seen.add(r.plan_id))).map((r) => r.job_plans));
      const { data: sig } = await supabase.from('job_milestones')
        .select('plan_id, job_plans!inner(id, entity_id, client_signal_at, client_signal_kind, signal_handled_at, entities(name))')
        .eq('owner_id', profile.id).eq('owner_role', 'preparer').eq('job_plans.status', 'committed')
        .not('job_plans.client_signal_at', 'is', null).is('job_plans.signal_handled_at', null).limit(200);
      const seen2 = new Set();
      setSignals((sig || []).filter((r) => (seen2.has(r.plan_id) ? false : seen2.add(r.plan_id))).map((r) => r.job_plans));
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, [profile?.id, today]);
  useEffect(() => { load(); }, [load]);

  // Handover state for my upcoming holidays, and overdue ones for a manager (sql/320).
  const myHols = useMemo(() => holidays.filter((h) => h.staff_id === profile?.id && h.date_to >= today).sort((a, b) => a.date_from.localeCompare(b.date_from)), [holidays, profile?.id, today]);
  const otherHols = useMemo(() => (profile?.can_manage_portal ? holidays.filter((h) => h.staff_id !== profile?.id && h.date_to >= today && h.handover_due && h.handover_due < today) : []), [holidays, profile, today]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out = {};
      for (const h of [...myHols, ...otherHols].slice(0, 8)) {
        try {
          const res = await callJobPlan({ action: 'holiday_tasks', holiday_id: h.id });
          let n = res.tasks.length;
          const from = new Date(`${h.date_from}T12:00:00`), to = new Date(`${h.date_to}T12:00:00`);
          scheduledTasks.filter((m) => m.assignee_id === h.staff_id && m.planned_date).forEach((m) => { n += generateInstances(m, from, to, overridesMap, completedKeys).length; });
          out[h.id] = { undecided: Math.max(0, n - res.decisions.length), unsent: res.decisions.filter((d) => d.decision === 'covered' && d.cover_staff_id && !d.sent_at).length };
        } catch { /* shown as unknown */ }
      }
      if (!cancelled) setHandoverState(out);
    })();
    return () => { cancelled = true; };
  }, [myHols, otherHols, scheduledTasks, overridesMap, completedKeys]);


  const act = async (payload) => {
    setBusy(true); setError(null);
    try { await callJobPlan(payload); await load(); }
    catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ padding: '12px 10px 0', fontFamily: font, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {error && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13.5 }}>{error}</div>}
      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          <OverviewDashboard onOpenTask={onOpenTask} />
          {signals.length > 0 && (
            <div style={{ background: '#ecfdf5', border: '1px solid #6ee7b7', borderRadius: 10, padding: '8px 12px' }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#065f46', marginBottom: 2 }}>The client has been in touch · {signals.length}</div>
              <div style={{ fontSize: 12, color: '#047857', marginBottom: 6 }}>Chases are on hold until you say. Records in, or still waiting?</div>
              {signals.map((p) => (
                <div key={p.id} style={{ fontSize: 13.5, display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0' }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <button onClick={() => navigate(`/clients/${p.entity_id}`)} style={{ background: 'none', border: 'none', padding: 0, color: '#0e7fe0', cursor: 'pointer', fontFamily: font, fontSize: 13.5, fontWeight: 600 }}>{p.entities?.name}</button>
                    <span style={{ color: '#64748b' }}> {p.client_signal_kind === 'upload' ? 'uploaded a document' : 'replied'} on {fmt(String(p.client_signal_at).slice(0, 10))}</span>
                  </span>
                  <button onClick={() => act({ action: 'records_signal_handle', plan_id: p.id, outcome: 'records_in' })} disabled={busy} style={BTN.primary.sm}>Records in</button>
                  <button onClick={() => act({ action: 'records_signal_handle', plan_id: p.id, outcome: 'still_waiting' })} disabled={busy} style={BTN.secondary.sm}>Still waiting</button>
                </div>
              ))}
            </div>
          )}
          {[...myHols, ...otherHols].filter((h) => { const s = handoverState[h.id]; return s && (s.undecided > 0 || s.unsent > 0); }).map((h) => {
            const s = handoverState[h.id];
            const overdue = h.handover_due && today > h.handover_due && s.unsent > 0;
            const mine = h.staff_id === profile?.id;
            return (
              <div key={h.id} style={{ background: overdue ? '#fee2e2' : '#fff7ed', border: `1px solid ${overdue ? '#fca5a5' : '#fdba74'}`, borderRadius: 10, padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5 }}>
                <span style={{ flex: 1 }}>
                  <b style={{ color: overdue ? '#991b1b' : '#9a3412' }}>{overdue ? 'Handover overdue' : 'Holiday handover'}</b>
                  <span style={{ color: '#475569' }}> · {mine ? 'you are' : `${staffMap?.[h.staff_id]?.name?.split(' ')[0] || 'someone'} is`} off {fmt(h.date_from)}{h.date_to !== h.date_from ? ` to ${fmt(h.date_to)}` : ''}
                    {s.undecided ? ` · ${s.undecided} task${s.undecided === 1 ? '' : 's'} with no plan` : ''}{s.unsent ? ` · ${s.unsent} handover${s.unsent === 1 ? '' : 's'} not sent` : ''}{h.handover_due ? ` · due ${fmt(h.handover_due)}` : ''}</span>
                </span>
                {mine && onOpenHolidays && <button onClick={onOpenHolidays} style={BTN.primary.sm}>Sort it out</button>}
              </div>
            );
          })}
          {reports.length > 0 && (
            <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10, padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5 }}>
              <span style={{ flex: 1 }}>
                <b style={{ color: '#92400e' }}>Delays and stuck jobs reported · {reports.length}</b>
                <span style={{ color: '#475569' }}> · {reports.slice(0, 4).map((r) => `${r.entities?.name || 'Client'} (${r.confidence === 'red' ? 'stuck' : 'delayed'})`).join(', ')}{reports.length > 4 ? ` and ${reports.length - 4} more` : ''}</span>
              </span>
              <button onClick={() => navigate('/planner/priority?report=open')} style={BTN.primary.sm}>See them</button>
            </div>
          )}
          {attention.length > 0 && (
            <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10, padding: '8px 12px' }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#92400e', marginBottom: 4 }}>Jobs needing attention · {attention.length}</div>
              {attention.map((p) => (
                <div key={p.id} style={{ fontSize: 13.5, display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>
                  <span style={pill(RISK[p.risk] || RISK.slipped)}>{(RISK[p.risk] || RISK.slipped).label}</span>
                  <button onClick={() => navigate(`/planner/plan/${p.entity_id}/${p.period_end}`)} style={{ background: 'none', border: 'none', padding: 0, color: '#0e7fe0', cursor: 'pointer', fontFamily: font, fontSize: 13.5 }}>{p.entities?.name}</button>
                  <span style={{ color: '#64748b', fontSize: 12.5 }}>{p.risk_reason}</span>
                </div>
              ))}
            </div>
          )}
          {toUpdate.length > 0 && (
            <div style={{ background: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: 10, padding: '8px 12px' }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#5b21b6', marginBottom: 2 }}>Completed in Athena, update in BrightManager · {toUpdate.length}</div>
              <div style={{ fontSize: 12, color: '#6d28d9', marginBottom: 6 }}>Mark these complete in BM. They clear themselves when the next import shows the job gone, or tick them off here.</div>
              {toUpdate.map((c) => (
                <div key={c.id} style={{ fontSize: 13.5, display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0' }}>
                  <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <span style={{ fontWeight: 500 }}>{c.entities?.name || 'Client'}</span>
                    <span style={{ color: '#64748b' }}> · {c.bm_task_name}</span>
                    <span style={{ color: '#94a3b8', fontSize: 12 }}> · done {fmt(c.completed_at.slice(0, 10))}{c.minutes ? ` · ${c.minutes} min` : ''}</span>
                  </span>
                  <button onClick={() => act({ action: 'confirm_bm_completion', completion_id: c.id })} disabled={busy} style={BTN.secondary.sm}>Done in BM</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
