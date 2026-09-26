import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { BTN } from '../../../lib/buttonStyles';
import { useAuth } from '../../../shell/AppShell';
import { callJobPlan } from '../plan/planQueries';
import EmailModal from '../components/EmailModal';
import SendStageModal from '../components/SendStageModal';
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

export default function TodayView({ onOpenTask }) {
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
  const { staffList } = useWorkPlanner();
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
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, [profile?.id, today]);
  useEffect(() => { load(); }, [load]);

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
              Stages appear here once a job plan you own is committed. Plan yours under <button onClick={() => navigate('/planner/plan')} style={{ background: 'none', border: 'none', padding: 0, color: '#0e7fe0', cursor: 'pointer', fontFamily: font, fontSize: 12.5 }}>Plan the Job</button>.
            </div>
          )}
          <div style={{ fontSize: 12.5, fontWeight: 600, color: '#64748b', marginTop: 4 }}>Actions and quick tasks</div>
        </>
      )}
    </div>
  );
}
