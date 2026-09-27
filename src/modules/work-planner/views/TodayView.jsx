import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { BTN } from '../../../lib/buttonStyles';
import { useAuth } from '../../../shell/AppShell';
import { callJobPlan } from '../plan/planQueries';
import EmailModal from '../components/EmailModal';
import SendStageModal from '../components/SendStageModal';
import OverviewDashboard from '../components/OverviewDashboard';
import { generateInstances } from '../lib/instanceEngine';
import { useWorkPlanner } from '../WorkPlannerModule';

// Overview — my committed job plans, one row per job (Bobby, 2026-09-26:
// a job listed once per stage was three rows for Accona and would be a mess
// for multi-client work). The row carries the next stage due, with Done /
// Send / Skip, and the stages that follow it in one line. Quick tasks render
// below this from the existing My Tasks list.

const font = "'Outfit', sans-serif";

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDaysISO(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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
// Stages that send an email to the client (sql/309).
const COMMS_STAGES = new Set(['request_records', 'chase_1', 'chase_2', 'client_meeting', 'approval']);


export default function TodayView({ onOpenTask, onOpenHolidays }) {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [stages, setStages] = useState([]);
  const [attention, setAttention] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [doneFor, setDoneFor] = useState(null); // milestone id with the minutes form open
  const [mins, setMins] = useState('');
  const [sendFor, setSendFor] = useState(null); // milestone with the send modal open
  const [emailFor, setEmailFor] = useState(null); // job with the generic email modal open
  const [busy, setBusy] = useState(false);
  const { staffList, staffMap, holidays = [], scheduledTasks = [], overridesMap, completedKeys } = useWorkPlanner();
  const [signals, setSignals] = useState([]); // plans where the client replied or uploaded (sql/319)
  const [handoverState, setHandoverState] = useState({}); // holiday id -> { undecided, unsent }
  const [toUpdate, setToUpdate] = useState([]); // BM jobs done here, not yet confirmed in BM (sql/311)
  const today = todayISO();

  const load = useCallback(async () => {
    if (!profile?.id) return;
    setLoading(true); setError(null);
    try {
      const horizon = addDaysISO(today, 14);
      const [{ data: ms, error: mErr }, { data: mine, error: aErr }] = await Promise.all([
        supabase.from('job_milestones')
          .select('id, stage_key, seq, label, kind, hours, owner_role, due_date, status, note, comms_sent_at, comms_to, job_plans!inner(id, entity_id, period_end, status, risk, risk_reason, entities(name))')
          .eq('owner_id', profile.id).eq('status', 'pending').eq('job_plans.status', 'committed')
          .lte('due_date', horizon).order('due_date').order('seq').limit(500),
        supabase.from('job_milestones')
          .select('plan_id, job_plans!inner(id, entity_id, period_end, status, risk, risk_reason, entities(name))')
          .eq('owner_id', profile.id).eq('owner_role', 'preparer').eq('job_plans.status', 'committed')
          .in('job_plans.risk', ['waiting_on_client', 'at_risk', 'urgent']).limit(500),
      ]);
      if (mErr) throw mErr;
      if (aErr) throw aErr;
      const { data: comps } = await supabase.from('bm_task_completions')
        .select('id, bm_task_name, completed_at, minutes, entities(name)')
        .eq('completed_by', profile.id).is('confirmed_at', null).order('completed_at', { ascending: false }).limit(200);
      setToUpdate(comps || []);
      setStages(ms || []);
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


  // One entry per job: its stages in date order; the first is what to do next.
  const jobs = useMemo(() => {
    const byPlan = new Map();
    stages.forEach((m) => { if (!byPlan.has(m.plan_id || m.job_plans.id)) byPlan.set(m.plan_id || m.job_plans.id, []); byPlan.get(m.plan_id || m.job_plans.id).push(m); });
    return [...byPlan.values()].map((list) => { list.sort((a, b) => a.due_date.localeCompare(b.due_date) || a.seq - b.seq); return { next: list[0], then: list.slice(1) }; })
      .sort((a, b) => a.next.due_date.localeCompare(b.next.due_date));
  }, [stages]);
  const groups = useMemo(() => ({
    overdue: jobs.filter((j) => j.next.due_date < today),
    week: jobs.filter((j) => j.next.due_date >= today && j.next.due_date <= addDaysISO(today, 7)),
    next: jobs.filter((j) => j.next.due_date > addDaysISO(today, 7)),
  }), [jobs, today]);

  const act = async (payload) => {
    setBusy(true); setError(null);
    try { await callJobPlan(payload); setDoneFor(null); setMins(''); await load(); }
    catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const Row = ({ job }) => {
    const m = job.next;
    const p = m.job_plans;
    const risk = RISK[p.risk];
    const open = doneFor === m.id;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderBottom: '1px solid #f1f5f9', fontSize: 13.5 }}>
        <div style={{ minWidth: 90, color: m.due_date < today ? '#b91c1c' : '#475569', fontWeight: 500 }}>{fmt(m.due_date)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <button onClick={() => navigate(`/planner/plan/${p.entity_id}/${p.period_end}`)} style={{ background: 'none', border: 'none', padding: 0, color: '#0e7fe0', cursor: 'pointer', fontFamily: font, fontSize: 13.5, fontWeight: 600 }}>
            {p.entities?.name}
          </button>
          <span style={{ color: '#94a3b8', fontSize: 12 }}> · YE {new Date(`${p.period_end}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}</span>
          {risk && <span style={{ marginLeft: 6, ...pill(risk) }} title={p.risk_reason || ''}>{risk.label}</span>}
          <div style={{ fontSize: 13 }}>
            <span style={{ fontWeight: 500 }}>{m.label}</span>
            {m.hours ? <span style={{ color: '#94a3b8', fontSize: 12 }}> · {Number(m.hours)}h</span> : null}
            {m.comms_sent_at && <span style={{ color: '#166534', fontSize: 12 }}> · sent {fmt(m.comms_sent_at.slice(0, 10))} to {m.comms_to}</span>}
            {job.then.length > 0 && (
              <span style={{ color: '#94a3b8', fontSize: 12 }}> · then {job.then.slice(0, 3).map((t) => `${t.label} ${fmt(t.due_date)}`).join(' · ')}{job.then.length > 3 ? ` · +${job.then.length - 3} more` : ''}</span>
            )}
          </div>
        </div>
        {open ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="number" min={0} step={5} value={mins} onChange={(e) => setMins(e.target.value)} placeholder="mins" autoFocus
              style={{ width: 70, padding: '5px 8px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6 }}
              onKeyDown={(e) => { if (e.key === 'Enter') act({ action: 'mark_done', milestone_id: m.id, minutes: Number(mins) || 0 }); if (e.key === 'Escape') setDoneFor(null); }} />
            <button onClick={() => act({ action: 'mark_done', milestone_id: m.id, minutes: Number(mins) || 0 })} disabled={busy} style={BTN.primary.sm}>Log &amp; done</button>
            <button onClick={() => setDoneFor(null)} style={BTN.secondary.sm}>Cancel</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6 }}>
            {COMMS_STAGES.has(m.stage_key) && !m.comms_sent_at && (
              <button onClick={() => setSendFor(m)} disabled={busy} style={BTN.primary.sm}>Preview &amp; send</button>
            )}
            <button onClick={() => { setDoneFor(m.id); setMins(m.hours ? String(Math.round(Number(m.hours) * 60)) : ''); }} disabled={busy} style={COMMS_STAGES.has(m.stage_key) && !m.comms_sent_at ? BTN.secondary.sm : BTN.primary.sm}>Done</button>
            <button onClick={() => { if (window.confirm(`Skip "${m.label}" on this job?`)) act({ action: 'skip', milestone_id: m.id }); }} disabled={busy} style={BTN.secondary.sm}>Skip</button>
            <button onClick={() => setEmailFor({ entity_id: p.entity_id, entity_name: p.entities?.name, task_label: m.label, task: { type: 'ms', id: m.id } })} disabled={busy} style={BTN.secondary.sm}>Email</button>
            {onOpenTask && <button onClick={() => onOpenTask({ type: 'ms', id: m.id })} style={BTN.secondary.sm}>Open</button>}
          </div>
        )}
      </div>
    );
  };

  const Section = ({ title, items, empty }) => (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', fontSize: 12.5, fontWeight: 600, color: '#64748b', borderBottom: '1px solid #e5e7eb', background: '#f8fafc' }}>
        {title} <span style={{ color: '#94a3b8', fontWeight: 500 }}>· {items.length}</span>
      </div>
      {items.length === 0 ? <div style={{ padding: '10px 12px', fontSize: 13, color: '#cbd5e1' }}>{empty}</div> : items.map((j) => <Row key={j.next.id} job={j} />)}
    </div>
  );

  return (
    <div style={{ padding: '12px 10px 0', fontFamily: font, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {sendFor && <SendStageModal milestone={sendFor} myEmail={profile?.email} onClose={() => setSendFor(null)} onSent={load} />}
      {emailFor && <EmailModal ctx={emailFor} staffList={staffList} profile={profile} onClose={() => setEmailFor(null)} />}
      {error && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13.5 }}>{error}</div>}
      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 13 }}>Loading your stages…</div>
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
          <Section title="Overdue" items={groups.overdue} empty="Nothing overdue." />
          <Section title="This week" items={groups.week} empty="Nothing due this week." />
          <Section title="Next two weeks" items={groups.next} empty="Nothing coming up." />
          <div style={{ fontSize: 12, color: '#94a3b8' }}>One row per job: the next stage, then what follows. Plan the day itself under Day plan.</div>
          {stages.length === 0 && attention.length === 0 && (
            <div style={{ fontSize: 12.5, color: '#94a3b8' }}>
              Stages appear here once a job plan you own is committed. Plan yours under <button onClick={() => navigate('/planner/plan')} style={{ background: 'none', border: 'none', padding: 0, color: '#0e7fe0', cursor: 'pointer', fontFamily: font, fontSize: 12.5 }}>Workflows</button>.
            </div>
          )}
          <div style={{ fontSize: 12.5, fontWeight: 600, color: '#64748b', marginTop: 4 }}>Actions and quick tasks</div>
        </>
      )}
    </div>
  );
}
