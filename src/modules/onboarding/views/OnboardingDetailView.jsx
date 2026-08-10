import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, Zap, ChevronDown, ChevronRight, Send, UserPlus } from 'lucide-react';
import { Btn } from '../../../components/ui';
import { tones, chipStyle, pillStyle } from '../../../lib/tokens';
import { useAuth } from '../../../shell/AppShell';
import PortalAccessPanel from '../components/PortalAccessPanel';
import DocumentsPanel from '../components/DocumentsPanel';
import EscalationPanel from '../components/EscalationPanel';
import CompaniesHousePanel from '../components/CompaniesHousePanel';
import ServicesPanel from '../components/ServicesPanel';
import HandoverPanel from '../components/HandoverPanel';
import CheckinPanel from '../components/CheckinPanel';
import DateField from '../components/DateField';
import {
  getOnboarding, listStaff, updateOnboarding, updateStep, addNote, addDirectorSa,
  isOverdue, daysSince, STEP_STATUSES, ONBOARDING_STATUSES,
} from '../api';

const font = "'Outfit', sans-serif";
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 };
const selectStyle = {
  padding: '5px 8px', fontSize: 12.5, fontFamily: font, background: '#fff',
  border: '1px solid #cbd5e1', borderRadius: 7,
};

function stepStatusMeta(value) {
  return STEP_STATUSES.find((s) => s.value === value) || STEP_STATUSES[0];
}

const KIND_LABEL = {
  note: 'Note', status_change: 'Update', system: 'System', email_out: 'Email sent', client_reply: 'Client reply',
};

export default function OnboardingDetailView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { profile } = useAuth();

  const [ob, setOb] = useState(null);
  const [staff, setStaff] = useState([]);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [noteText, setNoteText] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [taskFilter, setTaskFilter] = useState('all'); // all | client | staff

  const load = useCallback(() => {
    getOnboarding(id).then(setOb).catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { listStaff().then(setStaff).catch(() => {}); }, []);

  const staffName = useCallback(
    (sid) => staff.find((s) => s.id === sid)?.name || null,
    [staff],
  );

  const groups = useMemo(() => {
    if (!ob) return [];
    const byGroup = new Map();
    ob.steps.forEach((s) => {
      if (!byGroup.has(s.group_name)) byGroup.set(s.group_name, []);
      byGroup.get(s.group_name).push(s);
    });
    return [...byGroup.entries()];
  }, [ob]);

  const progress = useMemo(() => {
    if (!ob) return { done: 0, total: 0 };
    const applicable = ob.steps.filter((s) => s.status !== 'na');
    return { done: applicable.filter((s) => s.status === 'complete').length, total: applicable.length };
  }, [ob]);

  // Optimistic local patch, then persist
  async function patchStep(step, patch, logBody) {
    setOb((prev) => ({
      ...prev,
      steps: prev.steps.map((s) => (s.id === step.id ? { ...s, ...patch } : s)),
    }));
    try {
      await updateStep(step, patch, { actorId: profile?.id, logBody });
      if (logBody) load(); // pick up new activity rows
    } catch (e) {
      setError(e.message);
      load();
    }
  }

  function handleStepStatus(step, status) {
    if (status === step.status) return;
    const today = new Date().toISOString().slice(0, 10);
    const patch = { status };
    if (['waiting_client', 'waiting_external'].includes(status) && !step.requested_at) patch.requested_at = today;
    if (status === 'complete') {
      patch.completed_at = new Date().toISOString();
      patch.completed_by = profile?.id || null;
    } else {
      patch.completed_at = null;
      patch.completed_by = null;
    }
    const meta = stepStatusMeta(status);
    patchStep(step, patch, `${step.name}: ${stepStatusMeta(step.status).label} → ${meta.label}`);
  }

  async function handleObStatus(status) {
    const prev = ob.status;
    const patch = { status, completed_at: status === 'complete' ? new Date().toISOString() : null };
    setOb((o) => ({ ...o, ...patch }));
    try {
      await updateOnboarding(ob.id, patch, {
        actorId: profile?.id,
        logBody: `Onboarding status: ${prev} → ${status}`,
      });
      load();
    } catch (e) { setError(e.message); load(); }
  }

  async function handleObField(patch) {
    setOb((o) => ({ ...o, ...patch }));
    try { await updateOnboarding(ob.id, patch); } catch (e) { setError(e.message); load(); }
  }

  async function submitNote() {
    if (!noteText.trim()) return;
    setSavingNote(true);
    try {
      await addNote(ob.id, noteText.trim(), { actorId: profile?.id });
      setNoteText('');
      load();
    } catch (e) { setError(e.message); }
    setSavingNote(false);
  }

  if (error && !ob) return <div style={{ padding: 28, fontFamily: font, color: tones.danger.fg, fontSize: 13 }}>Failed to load: {error}</div>;
  if (!ob) return <div style={{ padding: 28, fontFamily: font, color: '#64748b', fontSize: 13 }}>Loading…</div>;

  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div style={{ padding: '24px 28px', fontFamily: font }}>
      <button
        onClick={() => navigate('/onboarding')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: '#64748b', fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 14, fontFamily: font }}
      >
        <ArrowLeft size={14} /> Back to pipeline
      </button>

      {/* Header */}
      <div style={{ ...card, padding: '18px 22px', marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1
              onClick={() => navigate(`/clients/${ob.entity_id}`)}
              title="Open the client screen"
              style={{ margin: 0, fontSize: 21, fontWeight: 700, color: '#0f172a', cursor: 'pointer', display: 'inline-block' }}
              onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; e.currentTarget.style.color = '#0e7fe0'; }}
              onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; e.currentTarget.style.color = '#0f172a'; }}
            >
              {ob.entity?.name}
            </h1>
            <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
              {ob.template?.name} · started {new Date(ob.started_at).toLocaleDateString('en-GB')}
              {ob.quote_id ? ' · quote linked' : ' · no quote linked'}
              {ob.referred_by?.name ? ` · referred by ${ob.referred_by.name}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12, color: '#64748b' }}>Status</label>
            <select style={selectStyle} value={ob.status} onChange={(e) => handleObStatus(e.target.value)}>
              {ONBOARDING_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <label style={{ fontSize: 12, color: '#64748b' }}>Owner</label>
            <select style={selectStyle} value={ob.owner_id || ''} onChange={(e) => handleObField({ owner_id: e.target.value || null })}>
              <option value="">—</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <label style={{ fontSize: 12, color: '#64748b' }}>Target</label>
            <DateField
              style={selectStyle} value={ob.target_date || ''} title="Target completion date"
              onCommit={(target_date) => handleObField({ target_date })}
            />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
          <div style={{ flex: 1, height: 8, borderRadius: 999, background: '#e5e7eb', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', borderRadius: 999, background: pct === 100 ? tones.success.solid : '#F5C518' }} />
          </div>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', whiteSpace: 'nowrap' }}>
            {progress.done}/{progress.total} · {pct}%
          </span>
        </div>
      </div>

      {error && <div style={{ color: tones.danger.fg, fontSize: 13, marginBottom: 10 }}>{error}</div>}

      {ob.status === 'issues' && (
        <div style={{ ...card, borderColor: tones.danger.border, background: tones.danger.bg, padding: '14px 18px', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <AlertTriangle size={15} color={tones.danger.fg} />
            <span style={{ fontSize: 12, fontWeight: 700, color: tones.danger.fg, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              What's the issue?
            </span>
          </div>
          <textarea
            key={`issue-${ob.id}`}
            defaultValue={ob.issue_note || ''}
            placeholder="Describe what's blocking this onboarding — this shows on hover in the pipeline."
            onBlur={(e) => { if (e.target.value !== (ob.issue_note || '')) handleObField({ issue_note: e.target.value || null }); }}
            style={{ ...selectStyle, width: '100%', minHeight: 44, resize: 'vertical', boxSizing: 'border-box', background: '#fff' }}
          />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.8fr) minmax(280px, 1fr)', gap: 16, alignItems: 'start' }}>
        {/* Checklist */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {[['all', 'All tasks'], ['client', 'Client tasks'], ['staff', 'AVA tasks']].map(([v, lbl]) => (
              <button key={v} onClick={() => setTaskFilter(v)} style={pillStyle({ tone: 'info', active: taskFilter === v })}>
                {lbl}
              </button>
            ))}
            <button
              onClick={async () => {
                const name = window.prompt('Director name for the additional self-assessment steps:');
                if (!name?.trim()) return;
                try { await addDirectorSa(ob, name.trim(), { actorId: profile?.id }); load(); }
                catch (e) { setError(e.message); }
              }}
              style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: `1px solid ${tones.info.border}`, borderRadius: 999, color: tones.info.fg, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: font, padding: '5px 12px' }}
            >
              <UserPlus size={12} /> Add director SA
            </button>
          </div>
          {groups.map(([groupName, allSteps]) => {
            const steps = taskFilter === 'all' ? allSteps
              : allSteps.filter((s) => taskFilter === 'client' ? s.owner_type === 'client' : s.owner_type !== 'client');
            if (steps.length === 0) return null;
            const groupDone = allSteps.filter((s) => s.status === 'complete').length;
            const groupApplicable = allSteps.filter((s) => s.status !== 'na').length;
            const allNa = groupApplicable === 0;
            return (
              <div key={groupName} style={{ ...card, padding: '14px 18px', opacity: allNa ? 0.6 : 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    {groupName}
                  </div>
                  <div style={{ fontSize: 12, color: '#94a3b8' }}>
                    {allNa ? 'not applicable' : `${groupDone}/${groupApplicable}`}
                  </div>
                </div>
                {steps.map((step) => {
                  const meta = stepStatusMeta(step.status);
                  const overdue = isOverdue(step);
                  const waited = daysSince(step.requested_at);
                  const isOpen = expanded[step.id];
                  const na = step.status === 'na';
                  return (
                    <div key={step.id} style={{ borderTop: '1px solid #f1f5f9', padding: '8px 0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <button
                          onClick={() => setExpanded((x) => ({ ...x, [step.id]: !x[step.id] }))}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#94a3b8', display: 'flex' }}
                        >
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                        <span style={{
                          flex: 1, fontSize: 13.5,
                          color: na ? '#94a3b8' : '#0f172a',
                          textDecoration: na ? 'line-through' : 'none',
                        }}>
                          {step.name}
                        </span>
                        {step.owner_type === 'client' && <span style={chipStyle('warning')}>client</span>}
                        {step.owner_type === 'system' && (
                          <span style={{ ...chipStyle('info'), display: 'inline-flex', alignItems: 'center', gap: 3 }}><Zap size={9} /> auto</span>
                        )}
                        {['waiting_client', 'waiting_external'].includes(step.status) && waited != null && (
                          <span style={{ ...chipStyle(overdue ? 'danger' : 'neutral'), display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                            {overdue && <AlertTriangle size={9} />} {waited}d
                          </span>
                        )}
                        <select
                          value={step.status}
                          onChange={(e) => handleStepStatus(step, e.target.value)}
                          style={{
                            ...selectStyle,
                            background: tones[meta.tone].bg, color: tones[meta.tone].fg,
                            border: `1px solid ${tones[meta.tone].border}`, fontWeight: 600, minWidth: 130,
                          }}
                        >
                          {STEP_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                        </select>
                      </div>
                      {isOpen && (
                        <div style={{ margin: '8px 0 4px 34px', fontSize: 12.5, color: '#475569', display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {step.description && <div>{step.description}</div>}
                          {step.client_label && (
                            <div style={{ color: tones.warning.fg }}>Client sees: “{step.client_label}”</div>
                          )}
                          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span>
                              Assignee{' '}
                              <select
                                style={selectStyle}
                                value={step.assignee_id || ''}
                                onChange={(e) => patchStep(step, { assignee_id: e.target.value || null })}
                              >
                                <option value="">—</option>
                                {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                              </select>
                            </span>
                            <span>
                              Requested{' '}
                              <DateField
                                style={selectStyle} value={step.requested_at || ''} title="Date requested"
                                onCommit={(requested_at) => patchStep(step, { requested_at })}
                              />
                            </span>
                            {step.expected_days != null && <span style={{ color: '#94a3b8' }}>expect ~{step.expected_days}d</span>}
                            {step.completed_at && (
                              <span style={{ color: tones.success.fg }}>
                                done {new Date(step.completed_at).toLocaleDateString('en-GB')}
                                {step.completed_by && staffName(step.completed_by) ? ` by ${staffName(step.completed_by)}` : ''}
                              </span>
                            )}
                          </div>
                          <textarea
                            defaultValue={step.note || ''}
                            placeholder="Step note…"
                            onBlur={(e) => { if (e.target.value !== (step.note || '')) patchStep(step, { note: e.target.value || null }); }}
                            style={{ ...selectStyle, width: '100%', minHeight: 40, resize: 'vertical', boxSizing: 'border-box' }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Right column: portal access + activity */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, position: 'sticky', top: 16, maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', paddingRight: 2 }}>
        <EscalationPanel ob={ob} onChanged={load} />
        <ServicesPanel ob={ob} staff={staff} onChanged={load} />
        <CompaniesHousePanel ob={ob} onChanged={load} />
        <HandoverPanel ob={ob} staff={staff} onChanged={load} />
        <CheckinPanel ob={ob} staff={staff} onChanged={load} />
        <div style={{ ...card, padding: '14px 18px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
            Notes &amp; background
          </div>
          <textarea
            key={`notes-${ob.id}`}
            defaultValue={ob.notes || ''}
            placeholder="Internal notes / imported background…"
            onBlur={(e) => { if (e.target.value !== (ob.notes || '')) handleObField({ notes: e.target.value || null }); }}
            style={{ ...selectStyle, width: '100%', minHeight: 90, resize: 'vertical', boxSizing: 'border-box', whiteSpace: 'pre-wrap' }}
          />
        </div>
        <PortalAccessPanel entityId={ob.entity_id} onboardingId={ob.id} entityEmail={ob.entity?.prospect_email || ob.entity?.billing_email} />
        <DocumentsPanel onboarding={ob} documents={ob.documents || []} onChanged={load} />
        <div style={{ ...card, padding: '16px 18px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
            Activity
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Add a note…"
              style={{ ...selectStyle, flex: 1, minHeight: 40, resize: 'vertical', boxSizing: 'border-box' }}
            />
            <Btn onClick={submitNote} disabled={savingNote || !noteText.trim()} className="self-start">
              <Send size={14} />
            </Btn>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 560, overflowY: 'auto' }}>
            {ob.activity.length === 0 && <div style={{ fontSize: 12.5, color: '#94a3b8' }}>Nothing yet.</div>}
            {ob.activity.map((a) => (
              <div key={a.id} style={{ fontSize: 12.5 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 2 }}>
                  <span style={chipStyle(a.kind === 'note' ? 'info' : a.kind === 'system' ? 'accent' : 'neutral')}>
                    {KIND_LABEL[a.kind] || a.kind}
                  </span>
                  <span style={{ color: '#94a3b8' }}>
                    {a.author?.name || 'Athena'} · {new Date(a.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div style={{ color: '#334155', whiteSpace: 'pre-wrap' }}>{a.body}</div>
              </div>
            ))}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
