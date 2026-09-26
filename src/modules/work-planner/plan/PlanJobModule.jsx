import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Routes, Route, useNavigate, useParams, Link } from 'react-router-dom';
import { useAuth } from '../../../shell/AppShell';
import { supabase } from '../../../lib/supabase';
import { BTN } from '../../../lib/buttonStyles';
import { addMonthsClamped, addMonthsKeepMonthEnd } from '../../../lib/monthMath';
import {
  fetchAccountsJobs, fetchAccountsJob, fetchPlan, fetchActiveStaff, callJobPlan,
} from './planQueries';

// Plan the Job — docs/WORKFLOW_TEMPLATE_ACCOUNTS_2026-09-25.md §5.
//
// /planner/plan                        every planned accounts job, one row per
//                                      client and year end, with its plan status
// /planner/plan/:entityId/:periodEnd   one job: the proposed chain, adjusted and
//                                      committed by the preparer
//
// Reads are direct; every write is the job-plan edge function.

const font = "'Outfit', sans-serif";

const KIND_LABEL = { comms: 'Client comms', milestone: 'Milestone', work: 'Work', calendar: 'Calendar' };
// Why a client has (or lacks) the meeting stages — v_client_review_meeting (sql/306).
const MEETING_BASIS = {
  billed: 'billed on the recurring invoice',
  package: 'included in their package',
  included_in_accounts: 'included in the accounts fee',
  manual: 'set by the team',
  none: 'not billed',
};
const ROLE_LABEL = {
  client_manager: 'Client manager', preparer: 'Preparer', reviewer: 'Reviewer',
  bookkeeper: 'Bookkeeper', client: 'Client',
};

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The two backstops from the design: nudge at YE + 1 month, unplanned flag
// when the statutory date is inside seven months. Both only while not committed.
// The seven months clamp like the SQL interval behind the Team count; the month
// after a year end stays on a month end (YE 31 Jan → 28 Feb, not 3 March).
function flagsFor(job, today) {
  if (job.plan_status === 'committed') return [];
  const out = [];
  if (job.ch_deadline && job.ch_deadline <= addMonthsClamped(today, 7)) out.push('unplanned');
  else if (job.period_end && addMonthsKeepMonthEnd(job.period_end, 1) <= today) out.push('nudge');
  return out;
}

const pill = (bg, fg) => ({
  display: 'inline-block', padding: '1px 8px', borderRadius: 10, fontSize: 11.5, fontWeight: 600,
  background: bg, color: fg, whiteSpace: 'nowrap',
});
const PLAN_PILL = {
  committed: pill('#dcfce7', '#166534'),
  draft: pill('#fef3c7', '#92400e'),
  none: pill('#f1f5f9', '#64748b'),
};
const FLAG_PILL = {
  unplanned: pill('#fee2e2', '#991b1b'),
  nudge: pill('#ffedd5', '#9a3412'),
};

const selStyle = {
  padding: '6px 10px', fontSize: 13, fontFamily: font,
  border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#0f172a',
};
const th = { padding: '8px 10px', fontSize: 11.5, fontWeight: 600, color: '#64748b', textAlign: 'left', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
const td = { padding: '8px 10px', fontSize: 13.5, borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle' };

export default function PlanJobModule() {
  return (
    <Routes>
      <Route path="/" element={<PlanList />} />
      <Route path="/review" element={<ReviewDrafts />} />
      <Route path="/:entityId/:periodEnd" element={<PlanEditor />} />
    </Routes>
  );
}

// ── List ─────────────────────────────────────────────────────────────────────

function PlanList() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [mine, setMine] = useState(true);
  const [status, setStatus] = useState('all'); // all | none | draft | committed | flagged
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [batchResult, setBatchResult] = useState(null);
  const today = todayISO();

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setJobs(await fetchAccountsJobs()); }
    catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    let list = jobs.map((j) => ({ ...j, flags: flagsFor(j, today) }));
    if (mine && profile?.id) list = list.filter((j) => j.preparer_id === profile.id);
    if (status === 'none') list = list.filter((j) => !j.plan_status);
    else if (status === 'draft') list = list.filter((j) => j.plan_status === 'draft');
    else if (status === 'committed') list = list.filter((j) => j.plan_status === 'committed');
    else if (status === 'flagged') list = list.filter((j) => j.flags.length);
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      list = list.filter((j) => (j.client || '').toLowerCase().includes(s));
    }
    return list;
  }, [jobs, mine, status, q, profile, today]);

  const counts = useMemo(() => ({
    none: rows.filter((j) => !j.plan_status).length,
    draft: rows.filter((j) => j.plan_status === 'draft').length,
    committed: rows.filter((j) => j.plan_status === 'committed').length,
    flagged: rows.filter((j) => j.flags.length).length,
  }), [rows]);

  const keyOf = (j) => `${j.entity_id}|${j.period_end}`;
  const selectable = rows.filter((j) => j.plan_status !== 'committed');
  const allSelected = selectable.length > 0 && selectable.every((j) => selected.has(keyOf(j)));

  // Propose drafts for the selection, then go and review them together.
  const proposeDefaults = async () => {
    const items = rows.filter((j) => selected.has(keyOf(j)) && !j.plan_status).map((j) => ({ entity_id: j.entity_id, period_end: j.period_end }));
    const already = rows.filter((j) => selected.has(keyOf(j)) && j.plan_status === 'draft').length;
    if (!items.length && !already) return;
    setBusy(true); setBatchResult(null); setError(null);
    try {
      if (items.length) {
        const res = await callJobPlan({ action: 'batch_propose', items });
        const failed = res.results.filter((r) => !r.ok);
        if (failed.length) setBatchResult({ committed: res.proposed, results: res.results, verb: 'Proposed' });
      }
      setSelected(new Set());
      navigate('/planner/plan/review');
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };
  const draftCount = rows.filter((j) => j.plan_status === 'draft').length;

  return (
    <div style={{ padding: '16px 20px', fontFamily: font, display: 'flex', flexDirection: 'column', gap: 12, height: '100%', overflow: 'auto' }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 600, color: '#0f172a' }}>Plan the Job</div>
        <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
          Every planned set of accounts, worked back from its year end. The preparer confirms the chain; the jobs that take the default can be committed together.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => setMine(true)} style={mine ? activeBtn : BTN.secondary.sm}>My jobs</button>
        <button onClick={() => setMine(false)} style={!mine ? activeBtn : BTN.secondary.sm}>Everyone</button>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={selStyle}>
          <option value="all">All plans</option>
          <option value="flagged">Flagged ({counts.flagged})</option>
          <option value="none">Not planned ({counts.none})</option>
          <option value="draft">Draft ({counts.draft})</option>
          <option value="committed">Committed ({counts.committed})</option>
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Client…" style={{ ...selStyle, minWidth: 200 }} />
        <div style={{ flex: 1 }} />
        <button onClick={load} style={BTN.secondary.sm}>Refresh</button>
        {draftCount > 0 && (
          <button onClick={() => navigate('/planner/plan/review')} style={BTN.secondary.sm}>Review drafts ({draftCount})</button>
        )}
        <button
          onClick={proposeDefaults}
          disabled={busy || selected.size === 0}
          style={{ ...BTN.primary.sm, opacity: busy || selected.size === 0 ? 0.5 : 1 }}
          title="Draft the default chain for the selected jobs, then review them together before committing"
        >
          {busy ? 'Proposing…' : `Propose defaults for ${selected.size || ''}`}
        </button>
      </div>

      {error && <div style={banner('#fee2e2', '#991b1b', '#fca5a5')}>{error}</div>}
      {batchResult && (
        <div style={banner('#dcfce7', '#166534', '#86efac')}>
          {batchResult.verb || 'Committed'} {batchResult.committed} of {batchResult.results.length}.
          {batchResult.results.filter((r) => !r.ok).map((r) => (
            <div key={`${r.entity_id}|${r.period_end}`} style={{ fontSize: 12.5, marginTop: 2 }}>
              {jobs.find((j) => j.entity_id === r.entity_id && j.period_end === r.period_end)?.client || r.entity_id}: {r.error}
            </div>
          ))}
        </div>
      )}

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>
            No accounts jobs match. {mine && 'Try "Everyone".'}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 30 }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map(keyOf)) : new Set())}
                    title="Select every job that is not yet committed"
                  />
                </th>
                <th style={th}>Client</th>
                <th style={th}>Year end</th>
                <th style={th}>Companies House</th>
                <th style={th}>Preparer</th>
                <th style={th}>BM status</th>
                <th style={th} title="Annual review meeting, and why">Meeting</th>
                <th style={th}>Plan</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => {
                const k = keyOf(j);
                return (
                  <tr key={k} style={{ background: selected.has(k) ? '#eff6ff' : undefined }}>
                    <td style={td}>
                      {j.plan_status !== 'committed' && (
                        <input type="checkbox" checked={selected.has(k)} onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(k); else next.delete(k);
                          setSelected(next);
                        }} />
                      )}
                    </td>
                    <td style={td}>
                      <Link to={`/clients/${j.entity_id}`} style={{ color: '#0e7fe0', textDecoration: 'none', fontWeight: 500 }}>{j.client}</Link>
                    </td>
                    <td style={td}>{fmtDate(j.period_end)}</td>
                    <td style={td}>{fmtDate(j.ch_deadline)}</td>
                    <td style={td}>{j.preparer_name || <span style={{ color: '#94a3b8' }}>Unassigned</span>}</td>
                    <td style={{ ...td, color: '#64748b' }}>{j.bm_status}</td>
                    <td style={td} title={MEETING_BASIS[j.meeting_basis] || ''}>
                      {j.meeting_default
                        ? <span style={pill('#ede9fe', '#5b21b6')}>{j.meeting_basis === 'billed' ? 'Yes · billed' : 'Yes · set'}</span>
                        : <span style={{ color: '#cbd5e1' }}>—</span>}
                    </td>
                    <td style={td}>
                      <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                        <span style={PLAN_PILL[j.plan_status || 'none']}>{j.plan_status || 'not planned'}</span>
                        {j.flags.map((f) => (
                          <span key={f} style={FLAG_PILL[f]} title={f === 'unplanned' ? 'Statutory date inside seven months and no committed plan' : 'A month past the year end and no committed plan'}>
                            {f === 'unplanned' ? 'Unplanned' : 'Nudge due'}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <button onClick={() => navigate(`/planner/plan/${j.entity_id}/${j.period_end}`)} style={j.plan_status === 'committed' ? BTN.secondary.sm : BTN.primary.sm}>
                        {j.plan_status === 'committed' ? 'Open' : j.plan_status === 'draft' ? 'Continue' : 'Plan'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const activeBtn = { ...BTN.secondary.sm, background: '#dbeafe', borderColor: '#0e7fe0', color: '#0e7fe0' };
const banner = (bg, fg, border) => ({ padding: '8px 12px', borderRadius: 8, background: bg, color: fg, border: `1px solid ${border}`, fontSize: 13.5 });

// What committing does, and does not yet do. Kept honest: the client-facing
// emails are the playbook phase and are not sent today.
const COMMIT_CONSEQUENCES = (n) => [
  `Commit ${n} plan${n === 1 ? '' : 's'}?`,
  '',
  'From tonight:',
  '• Each stage lands on its owner’s Today list on its date, and the nightly tick moves the dates as records arrive or slip.',
  '• Requests and chases are skipped automatically once BrightManager shows Records Received.',
  '',
  'Not yet, until the client-comms playbooks are switched on:',
  '• Clients with a meeting will get a meeting invite request for the date shown.',
  '• Clients whose records are outstanding will get a year-end paperwork request — a gap request where our VAT returns already cover the year.',
  '',
  'Any plan can be taken back to draft from its page.',
].join('\n');

// ── Review drafts together ───────────────────────────────────────────────────

const KEY_STAGES = [
  { key: 'request_records', label: 'Request' },
  { key: 'records_in|close_books', label: 'Records in' },
  { key: 'prepare', label: 'Prepare' },
  { key: 'internal_review', label: 'Review' },
  { key: 'client_meeting|send_for_approval', label: 'Meeting / send' },
  { key: 'file_ch', label: 'File' },
];

function ReviewDrafts() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [jobs, setJobs] = useState([]);
  const [stages, setStages] = useState(new Map()); // plan_id -> { stage_key -> milestone }
  const [mine, setMine] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const all = await fetchAccountsJobs();
      const drafts = all.filter((j) => j.plan_status === 'draft');
      setJobs(drafts);
      const map = new Map();
      const ids = drafts.map((j) => j.plan_id);
      for (let i = 0; i < ids.length; i += 150) {
        const { data, error: e } = await supabase.from('job_milestones')
          .select('plan_id, stage_key, label, due_date, status, owner_id').in('plan_id', ids.slice(i, i + 150));
        if (e) throw e;
        for (const m of data || []) {
          if (!map.has(m.plan_id)) map.set(m.plan_id, {});
          map.get(m.plan_id)[m.stage_key] = m;
        }
      }
      setStages(map);
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => (mine && profile?.id ? jobs.filter((j) => j.preparer_id === profile.id) : jobs), [jobs, mine, profile]);
  const stageDate = (j, keys) => {
    const s = stages.get(j.plan_id) || {};
    for (const k of keys.split('|')) if (s[k] && s[k].status !== 'removed') return s[k].due_date;
    return null;
  };
  const hasMeeting = (j) => !!(stages.get(j.plan_id) || {}).client_meeting && (stages.get(j.plan_id) || {}).client_meeting.status !== 'removed';

  const commitAll = async () => {
    if (!rows.length) return;
    if (!window.confirm(COMMIT_CONSEQUENCES(rows.length))) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await callJobPlan({ action: 'batch_commit', items: rows.map((j) => ({ entity_id: j.entity_id, period_end: j.period_end })) });
      setResult(res);
      await load();
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ padding: '16px 20px', fontFamily: font, display: 'flex', flexDirection: 'column', gap: 12, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <button onClick={() => navigate('/planner/plan')} style={{ ...BTN.secondary.sm, marginBottom: 8 }}>← All jobs</button>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#0f172a' }}>Review drafts</div>
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
            What the default plan schedules for each job. Open any row to adjust it; commit the rest together.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => setMine(true)} style={mine ? activeBtn : BTN.secondary.sm}>My jobs</button>
          <button onClick={() => setMine(false)} style={!mine ? activeBtn : BTN.secondary.sm}>Everyone</button>
          <button onClick={load} style={BTN.secondary.sm}>Refresh</button>
          <button onClick={commitAll} disabled={busy || rows.length === 0} style={{ ...BTN.primary.sm, opacity: busy || rows.length === 0 ? 0.5 : 1 }}>
            {busy ? 'Committing…' : `Commit these ${rows.length}`}
          </button>
        </div>
      </div>

      {error && <div style={banner('#fee2e2', '#991b1b', '#fca5a5')}>{error}</div>}
      {result && (
        <div style={banner('#dcfce7', '#166534', '#86efac')}>
          Committed {result.committed} of {result.results.length}.
          {result.results.filter((r) => !r.ok).map((r) => (
            <div key={`${r.entity_id}|${r.period_end}`} style={{ fontSize: 12.5, marginTop: 2 }}>{r.entity_id}: {r.error}</div>
          ))}
        </div>
      )}

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'auto' }}>
        {loading ? <div style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>Loading…</div>
        : rows.length === 0 ? <div style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>No drafts to review. Select jobs on the list and propose defaults first.</div>
        : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Client</th>
                <th style={th}>Year end</th>
                <th style={th}>Meeting</th>
                <th style={th} title="A VAT return we prepare ends at or within two months of the year end, so the request is for the gaps">Records</th>
                {KEY_STAGES.map((s) => <th key={s.key} style={th}>{s.label}</th>)}
                <th style={th}>Companies House</th>
                {!mine && <th style={th}>Preparer</th>}
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => (
                <tr key={j.plan_id}>
                  <td style={{ ...td, fontWeight: 500 }}>{j.client}</td>
                  <td style={td}>{fmtDate(j.period_end)}</td>
                  <td style={td}>{hasMeeting(j) ? <span style={pill('#ede9fe', '#5b21b6')}>Yes</span> : <span style={{ color: '#cbd5e1' }}>—</span>}</td>
                  <td style={td}>
                    {(stages.get(j.plan_id) || {}).close_books && (stages.get(j.plan_id) || {}).close_books.status !== 'removed'
                      ? <span style={pill('#e0f2fe', '#075985')} title="We keep the books: close them to the year end instead of requesting records">we keep the books</span>
                      : j.vat_covers_year_end
                        ? <span style={pill('#dcfce7', '#166534')} title="A VAT return we prepare covers the year end, so the request is for the gaps">via VAT</span>
                        : <span style={{ color: '#64748b' }}>full request</span>}
                  </td>
                  {KEY_STAGES.map((s) => <td key={s.key} style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(stageDate(j, s.key)) || <span style={{ color: '#cbd5e1' }}>—</span>}</td>)}
                  <td style={{ ...td, color: '#64748b' }}>{fmtDate(j.ch_deadline)}</td>
                  {!mine && <td style={td}>{j.preparer_name}</td>}
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button onClick={() => navigate(`/planner/plan/${j.entity_id}/${j.period_end}`)} style={BTN.secondary.sm}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Editor ───────────────────────────────────────────────────────────────────

function PlanEditor() {
  const { entityId, periodEnd } = useParams();
  const navigate = useNavigate();
  const [job, setJob] = useState(null);
  const [plan, setPlan] = useState(null);
  const [milestones, setMilestones] = useState([]);
  const [defaults, setDefaults] = useState(null);
  const [staff, setStaff] = useState([]);
  const [edits, setEdits] = useState({}); // stage_key -> patch
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);

  const applyResult = (res) => {
    setPlan(res.plan);
    setMilestones(res.milestones || []);
    if (res.defaults) setDefaults(res.defaults);
    setNote(res.plan?.note || '');
    setEdits({});
  };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [j, s] = await Promise.all([fetchAccountsJob(entityId, periodEnd), fetchActiveStaff()]);
      setStaff(s);
      if (!j) throw new Error('No planned accounts job for this client and year end.');
      setJob(j);
      if (j.plan_id) {
        const { plan: p, milestones: ms } = await fetchPlan(j.plan_id);
        setPlan(p); setMilestones(ms); setNote(p?.note || '');
      } else {
        // First visit: propose the default chain so there is something to adjust.
        const res = await callJobPlan({ action: 'propose', entity_id: entityId, period_end: periodEnd });
        applyResult(res);
      }
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, [entityId, periodEnd]);
  useEffect(() => { load(); }, [load]);

  const staffName = (id) => staff.find((s) => s.id === id)?.name || (id ? 'Former staff' : '');
  const committed = plan?.status === 'committed';
  const dirty = Object.keys(edits).length > 0 || (plan && (note || '') !== (plan.note || ''));

  const edit = (key, patch) => setEdits((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), ...patch } }));
  const view = (m) => ({ ...m, ...(edits[m.stage_key] || {}) });

  const run = async (payload, okMsg) => {
    setBusy(true); setError(null); setInfo(null);
    try {
      const res = await callJobPlan(payload);
      applyResult(res);
      if (okMsg) setInfo(okMsg);
      const j = await fetchAccountsJob(entityId, periodEnd);
      if (j) setJob(j);
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const save = () => run({
    action: 'save', plan_id: plan.id, note,
    milestones: Object.entries(edits).map(([stage_key, patch]) => ({ stage_key, ...patch })),
  }, 'Draft saved.');
  const setVariant = (field, value) => run({ action: 'save', plan_id: plan.id, [field]: value, milestones: [] });
  const repropose = () => {
    if (!window.confirm('Recompute every stage that is not pinned from the template? Pinned stages keep their dates.')) return;
    run({ action: 'propose', entity_id: entityId, period_end: periodEnd, replan: true }, 'Chain recomputed.');
  };
  const commit = async () => {
    if (!window.confirm(COMMIT_CONSEQUENCES(1))) return;
    if (dirty) { await save(); }
    run({ action: 'commit', plan_id: plan.id }, 'Plan committed.');
  };
  const uncommit = () => run({ action: 'uncommit', plan_id: plan.id }, 'Back to draft.');

  if (loading) return <div style={{ padding: 30, color: '#94a3b8', fontFamily: font }}>Loading…</div>;

  return (
    <div style={{ padding: '16px 20px', fontFamily: font, display: 'flex', flexDirection: 'column', gap: 12, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <button onClick={() => navigate('/planner/plan')} style={{ ...BTN.secondary.sm, marginBottom: 8 }}>← All jobs</button>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#0f172a' }}>
            {job?.client} <span style={{ color: '#64748b', fontWeight: 500 }}>· year end {fmtDate(periodEnd)}</span>
          </div>
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 2, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <span>Companies House by <b>{fmtDate(job?.ch_deadline) || '—'}</b></span>
            <span>CT600 by <b>{fmtDate(job?.ct_deadline) || '—'}</b></span>
            <span>Preparer <b>{job?.preparer_name || 'Unassigned'}</b></span>
            <span>BM status <b>{job?.bm_status || '—'}</b></span>
            {plan && <span style={PLAN_PILL[plan.status]}>{plan.status}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {committed ? (
            <button onClick={uncommit} disabled={busy} style={BTN.secondary.sm}>Back to draft</button>
          ) : (
            <>
              <button onClick={repropose} disabled={busy} style={BTN.secondary.sm}>Recompute</button>
              <button onClick={save} disabled={busy || !dirty} style={{ ...BTN.secondary.sm, opacity: dirty ? 1 : 0.5 }}>Save draft</button>
              <button onClick={commit} disabled={busy} style={BTN.primary.sm}>{busy ? 'Working…' : 'Commit plan'}</button>
            </>
          )}
        </div>
      </div>

      {error && <div style={banner('#fee2e2', '#991b1b', '#fca5a5')}>{error}</div>}
      {info && <div style={banner('#dcfce7', '#166534', '#86efac')}>{info}</div>}

      {plan && (
        <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 14px' }}>
          <Switch
            label="Annual meeting"
            value={plan.has_meeting ?? job?.meeting_default ?? defaults?.has_meeting ?? milestones.some((m) => m.stage_key === 'client_meeting')}
            hint={plan.has_meeting == null
              ? (MEETING_BASIS[job?.meeting_basis || defaults?.meeting_basis] || 'from the client')
              : 'this job only'}
            disabled={committed || busy}
            onChange={(v) => setVariant('has_meeting', v)}
          />
          {plan.has_meeting != null && !committed && (
            <RememberForClient
              entityId={entityId}
              hasMeeting={plan.has_meeting}
              busy={busy}
              onSaved={async () => { const j = await fetchAccountsJob(entityId, periodEnd); if (j) setJob(j); setInfo('Remembered for this client.'); }}
              onError={setError}
            />
          )}
          <Switch
            label="We keep the books"
            value={plan.books_with_us ?? defaults?.books_with_us ?? milestones.some((m) => m.stage_key === 'close_books')}
            hint={plan.books_with_us == null ? 'from the allocations' : 'set here'}
            disabled={committed || busy}
            onChange={(v) => setVariant('books_with_us', v)}
          />
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 12, color: '#94a3b8' }}>
            {plan.committed_at ? `Committed ${fmtDate(plan.committed_at.slice(0, 10))}` : plan.planned_at ? `Proposed ${fmtDate(plan.planned_at.slice(0, 10))}` : ''}
          </div>
        </div>
      )}

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 28 }}>#</th>
              <th style={th}>Stage</th>
              <th style={th}>Owner</th>
              <th style={th}>Due</th>
              <th style={{ ...th, textAlign: 'right' }}>Hours</th>
              <th style={th}>Pinned</th>
              <th style={th}>Note</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {milestones.map((m0) => {
              const m = view(m0);
              const removed = m.status === 'removed';
              const done = m.status === 'done';
              const ro = committed || busy || done;
              return (
                <tr key={m.stage_key} style={{ opacity: removed ? 0.45 : 1, background: done ? '#f0fdf4' : undefined }}>
                  <td style={{ ...td, color: '#94a3b8' }}>{m.seq}</td>
                  <td style={td}>
                    <div style={{ fontWeight: 500, textDecoration: removed ? 'line-through' : 'none' }}>{m.label}</div>
                    <div style={{ fontSize: 11.5, color: '#94a3b8' }}>
                      {KIND_LABEL[m.kind] || m.kind} · {ROLE_LABEL[m.owner_role] || m.owner_role}
                      {done && ` · done ${fmtDate((m.done_at || '').slice(0, 10))}`}
                    </div>
                  </td>
                  <td style={td}>
                    {m.owner_role === 'client' ? (
                      <span style={{ color: '#64748b' }}>Client</span>
                    ) : (
                      <select value={m.owner_id || ''} disabled={ro || removed} onChange={(e) => edit(m.stage_key, { owner_id: e.target.value || null })} style={selStyle}>
                        <option value="">— choose —</option>
                        {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        {m.owner_id && !staff.some((s) => s.id === m.owner_id) && <option value={m.owner_id}>{staffName(m.owner_id)}</option>}
                      </select>
                    )}
                  </td>
                  <td style={td}>
                    <input type="date" value={m.due_date || ''} disabled={ro || removed} onChange={(e) => e.target.value && edit(m.stage_key, { due_date: e.target.value })} style={selStyle} />
                  </td>
                  <td style={{ ...td, textAlign: 'right', color: '#64748b' }}>{m.hours ? `${Number(m.hours)}h` : ''}</td>
                  <td style={td}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, color: '#475569', cursor: ro ? 'default' : 'pointer' }}>
                      <input type="checkbox" checked={!!(edits[m.stage_key]?.pinned ?? m.pinned_by)} disabled={ro || removed} onChange={(e) => edit(m.stage_key, { pinned: e.target.checked })} />
                      {(edits[m.stage_key]?.pinned ?? m.pinned_by) ? 'Pinned' : 'Free'}
                    </label>
                  </td>
                  <td style={td}>
                    <input value={m.note || ''} disabled={ro || removed} placeholder="—" onChange={(e) => edit(m.stage_key, { note: e.target.value })} style={{ ...selStyle, width: 180 }} />
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {!ro && (removed ? (
                      <button onClick={() => edit(m.stage_key, { status: 'pending' })} style={BTN.secondary.sm}>Restore</button>
                    ) : (
                      <button onClick={() => edit(m.stage_key, { status: 'removed' })} style={BTN.danger.sm}>Remove</button>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: '#94a3b8', marginBottom: 3 }}>Plan note</div>
        <textarea value={note} disabled={committed || busy} onChange={(e) => setNote(e.target.value)} rows={2}
          placeholder="Anything the next person should know about this job's timeline"
          style={{ ...selStyle, width: '100%', resize: 'vertical', fontFamily: font }} />
      </div>

      <div style={{ fontSize: 12, color: '#94a3b8' }}>
        A date or owner you change is pinned automatically, so a recompute or the nightly pass leaves it alone. Removing a stage takes it out of this job only.
      </div>
    </div>
  );
}

// A meeting switched on or off for one job can be remembered for the client,
// so every later year end starts from the right answer and the billing cross
// check knows we meet them. Writes client_review_meetings through job-plan.
function RememberForClient({ entityId, hasMeeting, busy, onSaved, onError }) {
  const [open, setOpen] = useState(false);
  const [basis, setBasis] = useState(hasMeeting ? 'package' : 'manual');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await callJobPlan({ action: 'set_client_meeting', entity_id: entityId, has_meeting: hasMeeting, basis, note });
      setOpen(false);
      await onSaved();
    } catch (e) { onError(e.message || String(e)); }
    finally { setSaving(false); }
  };
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} disabled={busy} style={BTN.secondary.sm} title="Keep this answer for the client, not just this job">
        Remember for client
      </button>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {hasMeeting ? (
        <select value={basis} onChange={(e) => setBasis(e.target.value)} style={selStyle}>
          <option value="package">Included in their package</option>
          <option value="included_in_accounts">Included in the accounts fee</option>
          <option value="manual">We meet them (not billed)</option>
        </select>
      ) : <span style={{ fontSize: 12.5, color: '#64748b' }}>No meeting for this client</span>}
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" style={{ ...selStyle, width: 160 }} />
      <button onClick={save} disabled={saving} style={BTN.primary.sm}>{saving ? 'Saving…' : 'Save'}</button>
      <button onClick={() => setOpen(false)} style={BTN.secondary.sm}>Cancel</button>
    </span>
  );
}

function Switch({ label, value, hint, disabled, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 13.5, fontWeight: 500, color: '#0f172a' }}>{label}</span>
      <div style={{ display: 'inline-flex', border: '1px solid #cbd5e1', borderRadius: 6, overflow: 'hidden' }}>
        {[true, false].map((v) => (
          <button
            key={String(v)}
            disabled={disabled}
            onClick={() => value !== v && onChange(v)}
            style={{
              ...BTN.secondary.sm, border: 'none', borderRadius: 0,
              background: value === v ? '#dbeafe' : '#fff', color: value === v ? '#0e7fe0' : '#334155',
              fontWeight: value === v ? 600 : 500, cursor: disabled ? 'default' : 'pointer',
            }}
          >
            {v ? 'Yes' : 'No'}
          </button>
        ))}
      </div>
      <span style={{ fontSize: 11.5, color: '#94a3b8' }}>{hint}</span>
    </div>
  );
}
