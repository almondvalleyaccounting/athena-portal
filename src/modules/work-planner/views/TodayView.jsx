import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { BTN } from '../../../lib/buttonStyles';
import { useAuth } from '../../../shell/AppShell';
import { callJobPlan } from '../plan/planQueries';

// Today — the stages of committed job plans that are mine and due soon, with
// one Done button that also logs time against the job (job-plan mark_done).
// Quick tasks render below this from the existing My Tasks list.

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

export default function TodayView() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [stages, setStages] = useState([]);
  const [attention, setAttention] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [doneFor, setDoneFor] = useState(null); // milestone id with the minutes form open
  const [mins, setMins] = useState('');
  const [busy, setBusy] = useState(false);
  const today = todayISO();

  const load = useCallback(async () => {
    if (!profile?.id) return;
    setLoading(true); setError(null);
    try {
      const horizon = addDaysISO(today, 14);
      const [{ data: ms, error: mErr }, { data: mine, error: aErr }] = await Promise.all([
        supabase.from('job_milestones')
          .select('id, stage_key, seq, label, kind, hours, owner_role, due_date, status, note, job_plans!inner(id, entity_id, period_end, status, risk, risk_reason, entities(name))')
          .eq('owner_id', profile.id).eq('status', 'pending').eq('job_plans.status', 'committed')
          .lte('due_date', horizon).order('due_date').order('seq').limit(500),
        supabase.from('job_milestones')
          .select('plan_id, job_plans!inner(id, entity_id, period_end, status, risk, risk_reason, entities(name))')
          .eq('owner_id', profile.id).eq('owner_role', 'preparer').eq('job_plans.status', 'committed')
          .in('job_plans.risk', ['waiting_on_client', 'at_risk', 'urgent']).limit(500),
      ]);
      if (mErr) throw mErr;
      if (aErr) throw aErr;
      setStages(ms || []);
      const seen = new Set();
      setAttention((mine || []).filter((r) => (seen.has(r.plan_id) ? false : seen.add(r.plan_id))).map((r) => r.job_plans));
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, [profile?.id, today]);
  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => ({
    overdue: stages.filter((m) => m.due_date < today),
    week: stages.filter((m) => m.due_date >= today && m.due_date <= addDaysISO(today, 7)),
    next: stages.filter((m) => m.due_date > addDaysISO(today, 7)),
  }), [stages, today]);

  const act = async (payload) => {
    setBusy(true); setError(null);
    try { await callJobPlan(payload); setDoneFor(null); setMins(''); await load(); }
    catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const Row = ({ m }) => {
    const p = m.job_plans;
    const risk = RISK[p.risk];
    const open = doneFor === m.id;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderBottom: '1px solid #f1f5f9', fontSize: 13.5 }}>
        <div style={{ minWidth: 90, color: m.due_date < today ? '#b91c1c' : '#475569', fontWeight: 500 }}>{fmt(m.due_date)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 500 }}>{m.label}</span>
          <span style={{ color: '#64748b' }}> · </span>
          <button onClick={() => navigate(`/planner/plan/${p.entity_id}/${p.period_end}`)} style={{ background: 'none', border: 'none', padding: 0, color: '#0e7fe0', cursor: 'pointer', fontFamily: font, fontSize: 13.5 }}>
            {p.entities?.name}
          </button>
          <span style={{ color: '#94a3b8', fontSize: 12 }}> · YE {new Date(`${p.period_end}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}</span>
          {m.hours ? <span style={{ color: '#94a3b8', fontSize: 12 }}> · {Number(m.hours)}h</span> : null}
          {risk && <span style={{ marginLeft: 6, ...pill(risk) }} title={p.risk_reason || ''}>{risk.label}</span>}
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
            <button onClick={() => { setDoneFor(m.id); setMins(m.hours ? String(Math.round(Number(m.hours) * 60)) : ''); }} disabled={busy} style={BTN.primary.sm}>Done</button>
            <button onClick={() => { if (window.confirm(`Skip "${m.label}" on this job?`)) act({ action: 'skip', milestone_id: m.id }); }} disabled={busy} style={BTN.secondary.sm}>Skip</button>
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
      {items.length === 0 ? <div style={{ padding: '10px 12px', fontSize: 13, color: '#cbd5e1' }}>{empty}</div> : items.map((m) => <Row key={m.id} m={m} />)}
    </div>
  );

  return (
    <div style={{ padding: '12px 10px 0', fontFamily: font, display: 'flex', flexDirection: 'column', gap: 10 }}>
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
          <Section title="Overdue" items={groups.overdue} empty="Nothing overdue." />
          <Section title="This week" items={groups.week} empty="Nothing due this week." />
          <Section title="Next two weeks" items={groups.next} empty="Nothing coming up." />
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
