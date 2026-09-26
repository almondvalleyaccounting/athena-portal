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
// Stages that send an email to the client (sql/309).
const COMMS_STAGES = new Set(['request_records', 'chase_1', 'chase_2', 'client_meeting', 'approval']);

// Preview & send: the rendered email, the address it goes to (editable), a
// copy-to-me test, and Send. Requests and chases close on send.
const GRP_LABEL = { company: 'Company records', personal: 'Director’s personal tax', other: 'Other' };

function SendModal({ milestone, onClose, onSent, myEmail }) {
  const [preview, setPreview] = useState(null);
  const [to, setTo] = useState('');
  const [picker, setPicker] = useState(null); // [{ key, label, grp, ticked, remembered }]
  const [custom, setCustom] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const picked = () => (picker || []).filter((i) => i.ticked).map((i) => (i.key ? { key: i.key } : { text: i.label }));

  const render = async (items) => {
    const res = await callJobPlan({ action: 'preview_comms', milestone_id: milestone.id, ...(items ? { items } : {}) });
    setPreview(res.preview);
    if (!picker && res.preview.picker) setPicker(res.preview.picker);
    if (!items) setTo(res.preview.to || '');
    if (res.sent_at) setNote(`Already sent ${res.sent_at.slice(0, 10)} to ${res.sent_to}`);
  };
  useEffect(() => {
    let cancelled = false;
    render().catch((e) => { if (!cancelled) setError(e.message || String(e)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [milestone.id]);

  // Re-render the text as the ticks change, so what is shown is what goes.
  const setTick = (idx, ticked) => {
    const next = picker.map((i, n) => (n === idx ? { ...i, ticked } : i));
    setPicker(next);
    render(next.filter((i) => i.ticked).map((i) => (i.key ? { key: i.key } : { text: i.label }))).catch((e) => setError(e.message || String(e)));
  };
  const addCustom = () => {
    const t = custom.trim();
    if (!t) return;
    const next = [...picker, { key: null, label: t, grp: 'other', ticked: true, remembered: false }];
    setPicker(next); setCustom('');
    render(next.filter((i) => i.ticked).map((i) => (i.key ? { key: i.key } : { text: i.label }))).catch((e) => setError(e.message || String(e)));
  };

  const send = async (test) => {
    setBusy(true); setError(null);
    try {
      const res = await callJobPlan({
        action: 'send_comms', milestone_id: milestone.id, test,
        to: test ? myEmail : (to !== preview?.to ? to : undefined),
        ...(picker ? { items: picked() } : {}),
      });
      if (test) setNote(`Test copy sent to ${res.to}.`);
      else { onSent(); onClose(); }
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };
  const p = milestone.job_plans;
  const groups = picker ? ['company', 'personal', 'other'].filter((g) => picker.some((i) => i.grp === g)) : [];
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.25)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, width: picker ? 980 : 620, maxWidth: '96vw', maxHeight: '92vh', overflow: 'auto', padding: 18, fontFamily: font, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 2 }}>{milestone.label} · {p.entities?.name}</div>
        <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 10 }}>
          {preview?.from_email ? `Goes from your mailbox (${preview.from_email})` : `Goes from the practice mailbox with ${preview?.from_name ? `${preview.from_name}’s` : 'your'} name on it`}, plain text, and is logged on the client page.
        </div>
        {error && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13, marginBottom: 8 }}>{error}</div>}
        {note && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#dcfce7', color: '#166534', fontSize: 13, marginBottom: 8 }}>{note}</div>}
        {!preview ? <div style={{ color: '#94a3b8' }}>Rendering…</div> : (
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            {picker && (
              <div style={{ width: 330, flexShrink: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 4 }}>What to ask this client for</div>
                <div style={{ fontSize: 11.5, color: '#94a3b8', marginBottom: 8 }}>
                  {picker.some((i) => i.remembered) ? 'Pre-ticked from what we asked them for last time.' : 'Pre-ticked defaults for this kind of request.'} Your ticks are remembered for next year.
                </div>
                {groups.map((g) => (
                  <div key={g} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: '#475569', margin: '4px 0' }}>{GRP_LABEL[g]}</div>
                    {picker.map((i, idx) => i.grp === g && (
                      <label key={i.key || `c${idx}`} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12.5, padding: '2px 0', cursor: 'pointer' }}>
                        <input type="checkbox" checked={i.ticked} onChange={(e) => setTick(idx, e.target.checked)} style={{ marginTop: 3 }} />
                        <span>{i.label}{i.remembered && <span style={{ color: '#94a3b8' }}> · last year</span>}</span>
                      </label>
                    ))}
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <input value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addCustom(); }} placeholder="Something specific, e.g. the invoice for the new van" style={{ flex: 1, padding: '5px 8px', fontSize: 12.5, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6 }} />
                  <button onClick={addCustom} style={BTN.secondary.sm}>Add</button>
                </div>
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', width: 56 }}>To</span>
              <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="No email address on file" style={{ flex: 1, padding: '6px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6 }} />
              {preview.to_reason && <span style={{ fontSize: 11.5, color: '#94a3b8' }}>{preview.to_reason}</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', width: 56 }}>Subject</span>
              <span style={{ fontSize: 13.5, fontWeight: 500 }}>{preview.subject}</span>
            </div>
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: font, fontSize: 13.5, lineHeight: 1.5, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, margin: '0 0 12px' }}>{preview.text}</pre>
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button onClick={onClose} style={BTN.secondary.sm}>Cancel</button>
              {myEmail && <button onClick={() => send(true)} disabled={busy} style={BTN.secondary.sm}>Send a copy to me</button>}
              <button onClick={() => send(false)} disabled={busy || !to} style={{ ...BTN.primary.sm, opacity: busy || !to ? 0.5 : 1 }}>{busy ? 'Sending…' : `Send to client${preview.completes ? ' and mark done' : ''}`}</button>
            </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function TodayView() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [stages, setStages] = useState([]);
  const [attention, setAttention] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [doneFor, setDoneFor] = useState(null); // milestone id with the minutes form open
  const [mins, setMins] = useState('');
  const [sendFor, setSendFor] = useState(null); // milestone with the send modal open
  const [busy, setBusy] = useState(false);
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
          {m.comms_sent_at && <span style={{ color: '#166534', fontSize: 12 }}> · sent {fmt(m.comms_sent_at.slice(0, 10))} to {m.comms_to}</span>}
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
            {COMMS_STAGES.has(m.stage_key) && !m.comms_sent_at && (
              <button onClick={() => setSendFor(m)} disabled={busy} style={BTN.primary.sm}>Preview &amp; send</button>
            )}
            <button onClick={() => { setDoneFor(m.id); setMins(m.hours ? String(Math.round(Number(m.hours) * 60)) : ''); }} disabled={busy} style={COMMS_STAGES.has(m.stage_key) && !m.comms_sent_at ? BTN.secondary.sm : BTN.primary.sm}>Done</button>
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
      {sendFor && <SendModal milestone={sendFor} myEmail={profile?.email} onClose={() => setSendFor(null)} onSent={load} />}
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
