import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Bug, Plus, Copy, Check, ChevronDown, ChevronRight, Paperclip, X, Filter } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import { MODULES } from '../../modules.config';

/* ─── Bug Reports Module ───────────────────────────────────────────────
 *
 * Team members raise bugs through a GUIDED form so each report arrives as a
 * spec Claude can act on — Bobby triages instead of translating. Kept
 * separate from Issues Log (operational issues) and the Work triage board
 * (client work). See sql/157.
 * ---------------------------------------------------------------------- */

// The area of Athena the bug is in — drawn from the live module list, plus
// a few cross-cutting surfaces and an escape hatch.
const MODULE_OPTIONS = [
  'Home / Dashboard',
  ...MODULES.map((m) => m.label),
  'Client page',
  'Login / access',
  'Notifications / email',
  'Other / not sure',
];

const FREQUENCY = [
  { id: 'always', label: 'Every time', hint: 'Happens whenever I do this' },
  { id: 'sometimes', label: 'Sometimes', hint: 'Intermittent — not every time' },
  { id: 'once', label: 'Happened once', hint: "Saw it once, hasn't repeated" },
  { id: 'unsure', label: 'Not sure', hint: "Haven't checked if it repeats" },
];

const IMPACT = [
  { id: 'blocking', label: 'Blocking', hint: "I can't do my work at all", colour: '#dc2626' },
  { id: 'workaround', label: 'Painful', hint: 'There is a workaround but it hurts', colour: '#ea580c' },
  { id: 'minor', label: 'Minor', hint: 'Annoying but I can carry on', colour: '#d97706' },
  { id: 'cosmetic', label: 'Cosmetic', hint: 'Looks wrong / typo, no real effect', colour: '#059669' },
];

const PRIORITIES = [
  { id: 'critical', label: 'Critical', icon: '🔴', colour: '#dc2626' },
  { id: 'high', label: 'High', icon: '🟠', colour: '#ea580c' },
  { id: 'medium', label: 'Medium', icon: '🟡', colour: '#d97706' },
  { id: 'low', label: 'Low', icon: '🟢', colour: '#059669' },
];

const STATUSES = [
  { id: 'new', label: 'New', colour: '#0e7fe0', bg: '#eff6ff', lane: 'To triage' },
  { id: 'needs_info', label: 'Needs info', colour: '#7c3aed', bg: '#f5f3ff', lane: 'Waiting on reporter' },
  { id: 'accepted', label: 'Accepted', colour: '#d97706', bg: '#fffbeb', lane: 'Queue' },
  { id: 'in_progress', label: 'In progress', colour: '#0891b2', bg: '#ecfeff', lane: 'Building' },
  { id: 'fixed', label: 'Fixed — verify', colour: '#059669', bg: '#f0fdf4', lane: 'Verify' },
  { id: 'verified', label: 'Verified', colour: '#16a34a', bg: '#f0fdf4', lane: 'Done' },
  { id: 'rejected', label: 'Rejected', colour: '#64748b', bg: '#f1f5f9', lane: 'Closed' },
];
const statusCfg = (id) => STATUSES.find((s) => s.id === id) || STATUSES[0];
const prioCfg = (id) => PRIORITIES.find((p) => p.id === id) || null;

const REJECT_REASONS = [
  { id: 'not_a_bug', label: 'Not a bug / works as intended' },
  { id: 'duplicate', label: 'Duplicate of another report' },
  { id: 'cannot_repro', label: "Can't reproduce" },
  { id: 'wont_fix', label: "Won't fix (out of scope)" },
  { id: 'other', label: 'Other' },
];

// Suggest a priority from impact + frequency so triage is a nudge, not a blank box.
function suggestPriority(impact, frequency) {
  if (impact === 'blocking') return frequency === 'always' ? 'critical' : 'high';
  if (impact === 'workaround') return frequency === 'always' ? 'high' : 'medium';
  if (impact === 'minor') return 'low';
  if (impact === 'cosmetic') return 'low';
  return 'medium';
}

function daysSince(dateStr) {
  if (!dateStr) return 0;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

// A single clean markdown spec for a bug — the thing Claude reads.
function buildBrief(bug, entityName) {
  const p = prioCfg(bug.priority);
  const L = [];
  L.push(`# BUG-${bug.seq}: ${bug.title}`);
  L.push('');
  L.push(`- **Status:** ${statusCfg(bug.status).label}${p ? `  ·  **Priority:** ${p.label}` : ''}`);
  L.push(`- **Where:** ${bug.module || '—'}${bug.page_url ? `  (\`${bug.page_url}\`)` : ''}`);
  if (entityName || bug.record_ref) L.push(`- **Client / record:** ${[entityName, bug.record_ref].filter(Boolean).join(' · ')}`);
  L.push(`- **Frequency:** ${FREQUENCY.find((f) => f.id === bug.frequency)?.label || '—'}  ·  **Impact:** ${IMPACT.find((i) => i.id === bug.impact)?.label || '—'}`);
  L.push(`- **Reported by:** ${bug.reported_by_name || '—'} on ${new Date(bug.created_at).toLocaleDateString('en-GB')}`);
  L.push('');
  if (bug.goal) { L.push('## What they were trying to do'); L.push(bug.goal); L.push(''); }
  if (bug.expected) { L.push('## Expected'); L.push(bug.expected); L.push(''); }
  if (bug.actual) { L.push('## Actual'); L.push(bug.actual); L.push(''); }
  if (bug.steps) { L.push('## Steps to reproduce'); L.push(bug.steps); L.push(''); }
  if (bug.started) { L.push('## When it started'); L.push(bug.started); L.push(''); }
  if (bug.triage_notes) { L.push('## Triage notes'); L.push(bug.triage_notes); L.push(''); }
  const ctx = bug.context || {};
  if (ctx.userAgent || ctx.viewport) {
    L.push('## Environment');
    if (ctx.route) L.push(`- Route: \`${ctx.route}\``);
    if (ctx.viewport) L.push(`- Viewport: ${ctx.viewport}`);
    if (ctx.userAgent) L.push(`- Browser: ${ctx.userAgent}`);
    L.push('');
  }
  return L.join('\n');
}

export default function BugReportPage() {
  const { profile } = useAuth();
  const canTriage = !!(profile?.can_triage_bugs || profile?.is_portal_admin);

  const [bugs, setBugs] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [entities, setEntities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState(canTriage ? 'triage' : 'report');

  useEffect(() => { loadData(); }, []);

  const loadData = useCallback(async () => {
    try {
      const [{ data: bg }, { data: staff }, { data: ents }] = await Promise.all([
        supabase.from('bugs').select('*').order('created_at', { ascending: false }),
        supabase.from('staff_profiles').select('id, name, email').eq('is_active', true).order('name'),
        supabase.from('entities').select('id, name').order('name'),
      ]);
      setBugs(bg || []);
      setStaffList((staff || []).map((s) => ({ ...s, name: s.name || s.email })));
      setEntities(ents || []);
    } catch (e) { console.error('[Bugs] load error:', e); }
    setLoading(false);
  }, []);

  const entityMap = useMemo(() => { const m = {}; entities.forEach((e) => { m[e.id] = e.name; }); return m; }, [entities]);
  const myBugs = useMemo(() => bugs.filter((b) => b.reported_by === profile?.id), [bugs, profile]);

  const patchBug = async (id, patch) => {
    // Stamp lifecycle timestamps.
    const now = new Date().toISOString();
    const p = { ...patch };
    if (patch.status) {
      if (['accepted', 'needs_info', 'rejected'].includes(patch.status) && !bugs.find((b) => b.id === id)?.triaged_at) p.triaged_at = now;
      if (patch.status === 'fixed') p.fixed_at = now;
      if (patch.status === 'verified') { p.verified_at = now; p.closed_at = now; }
      if (patch.status === 'rejected') p.closed_at = now;
    }
    setBugs((prev) => prev.map((b) => (b.id === id ? { ...b, ...p } : b)));
    const { error } = await supabase.from('bugs').update(p).eq('id', id);
    if (error) { console.error('[Bugs] update:', error); loadData(); return; }

    // Notify the reporter when the ball is back in their court.
    const bug = bugs.find((b) => b.id === id);
    if (bug?.reported_by && bug.reported_by !== profile?.id) {
      const msg = patch.status === 'needs_info'
        ? { kind: 'bug_needs_info', title: `More info needed on your bug: ${bug.title}` }
        : patch.status === 'fixed'
        ? { kind: 'bug_fixed', title: `Bug fixed — please verify: ${bug.title}` }
        : null;
      if (msg) supabase.rpc('notify_staff', { p_recipient: bug.reported_by, p_kind: msg.kind, p_title: msg.title, p_link: '/bugs' })
        .then(({ error: e }) => { if (e) console.error('[Bugs] notify', e); });
    }
  };

  const deleteBug = async (bug) => {
    if (!window.confirm(`Delete BUG-${bug.seq} "${bug.title}"? This can't be undone.`)) return;
    setBugs((prev) => prev.filter((b) => b.id !== bug.id));
    await supabase.from('bugs').delete().eq('id', bug.id);
  };

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '32px 24px', fontFamily: "'Outfit', sans-serif" }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, fontWeight: 500, color: '#0f172a', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 10 }}>
          <Bug size={24} style={{ color: '#0e7fe0' }} /> Bug Reports
        </h1>
        <p style={{ fontSize: 13.5, color: '#64748b', lineHeight: 1.5 }}>
          Found something in Athena that's broken or wrong? Report it here. The more you tell us,
          the faster it gets fixed — the questions below are what Claude needs to reproduce and fix it.
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap' }}>
        {[
          { id: 'report', label: 'Report a bug' },
          { id: 'mine', label: `My reports (${myBugs.length})` },
          ...(canTriage
            ? [{ id: 'triage', label: 'Triage board' }]
            : [{ id: 'all', label: `All bugs (${bugs.length})` }]),
        ].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} style={tabBtn(tab === t.id)}>{t.label}</button>
        ))}
      </div>

      {tab === 'report' && (
        <ReportForm profile={profile} entities={entities} onSaved={() => { loadData(); setTab('mine'); }} canTriage={canTriage} staffList={staffList} />
      )}
      {tab === 'mine' && (
        <BugList bugs={myBugs} loading={loading} entityMap={entityMap} staffList={staffList}
          canTriage={false} onPatch={patchBug} onDelete={deleteBug} profile={profile} emptyMsg="You haven't reported any bugs yet." />
      )}
      {tab === 'all' && (
        <BugList bugs={bugs} loading={loading} entityMap={entityMap} staffList={staffList}
          canTriage={false} onPatch={patchBug} onDelete={deleteBug} profile={profile} emptyMsg="No bugs reported yet." />
      )}
      {tab === 'triage' && canTriage && (
        <TriageBoard bugs={bugs} loading={loading} entityMap={entityMap} staffList={staffList}
          onPatch={patchBug} onDelete={deleteBug} profile={profile} />
      )}
    </div>
  );
}

/* ─── Guided report form ─────────────────────────────────────────────── */
function ReportForm({ profile, entities, onSaved, canTriage, staffList }) {
  const [f, setF] = useState({
    title: '', module: '', page_url: '', entity_id: '', record_ref: '',
    goal: '', expected: '', actual: '', steps: '', frequency: '', impact: '', started: '',
  });
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [entityQuery, setEntityQuery] = useState('');
  const set = (k) => (e) => setF((prev) => ({ ...prev, [k]: e.target?.value ?? e }));

  const entMatches = useMemo(() => {
    if (!entityQuery.trim()) return [];
    const q = entityQuery.toLowerCase();
    return entities.filter((e) => e.name.toLowerCase().includes(q)).slice(0, 6);
  }, [entityQuery, entities]);

  const canSubmit = f.title.trim() && f.actual.trim() && f.impact && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const context = {
        url: window.location.href,
        route: window.location.pathname,
        userAgent: navigator.userAgent,
        viewport: `${window.innerWidth}×${window.innerHeight}`,
        reportedByEmail: profile?.email || null,
        appVersion: import.meta.env?.VITE_COMMIT_SHA || import.meta.env?.VITE_VERCEL_GIT_COMMIT_SHA || null,
        ts: new Date().toISOString(),
      };

      let screenshot_url = null;
      if (file) {
        const safe = (file.name || 'shot').replace(/[^\w.\-]+/g, '_');
        const path = `bug-screenshots/${crypto.randomUUID()}-${safe}`;
        const { error: upErr } = await supabase.storage.from('client-documents').upload(path, file, { contentType: file.type || undefined });
        if (!upErr) screenshot_url = path; else console.error('[Bugs] upload', upErr);
      }

      const { data, error } = await supabase.from('bugs').insert({
        title: f.title.trim(),
        module: f.module || null,
        page_url: f.page_url.trim() || context.url,
        entity_id: f.entity_id || null,
        record_ref: f.record_ref.trim() || null,
        goal: f.goal.trim() || null,
        expected: f.expected.trim() || null,
        actual: f.actual.trim(),
        steps: f.steps.trim() || null,
        frequency: f.frequency || null,
        impact: f.impact,
        started: f.started.trim() || null,
        screenshot_url,
        context,
        status: 'new',
        reported_by: profile?.id,
        reported_by_name: profile?.full_name || profile?.name || 'Unknown',
      }).select('id, seq').single();

      if (error) throw error;

      // Let the triagers know a bug landed.
      if (data?.id) {
        supabase.rpc('notify_triagers_bug', { p_bug_title: f.title.trim(), p_bug_seq: data.seq })
          .then(({ error: e }) => { if (e) console.warn('[Bugs] notify triagers', e.message); });
      }
      onSaved();
    } catch (e) {
      console.error('[Bugs] submit error:', e);
      alert('Could not save the bug report. Please try again.');
    }
    setSaving(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <Section n={1} title="What's the one-line summary?" required>
        <input value={f.title} onChange={set('title')} placeholder="e.g. VAT reviewer change doesn't show on Sophie's report" style={input} autoFocus />
      </Section>

      <Section n={2} title="Where in Athena did it happen?">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <select value={f.module} onChange={set('module')} style={{ ...input, flex: 1, minWidth: 200 }}>
            <option value="">— Pick the area —</option>
            {MODULE_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <input value={f.page_url} onChange={set('page_url')} placeholder="Exact screen / URL (optional — we capture the page you're on)" style={{ ...input, flex: 1.4, minWidth: 220 }} />
        </div>
      </Section>

      <Section n={3} title="Which client or record? (if it's about a specific one)">
        {f.entity_id ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={chip}>{entities.find((e) => e.id === f.entity_id)?.name}</span>
            <button onClick={() => { setF((p) => ({ ...p, entity_id: '' })); setEntityQuery(''); }} style={linkBtn}>change</button>
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            <input value={entityQuery} onChange={(e) => setEntityQuery(e.target.value)} placeholder="Start typing a client name…" style={input} />
            {entMatches.length > 0 && (
              <div style={{ position: 'absolute', zIndex: 5, top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, marginTop: 2, boxShadow: '0 4px 12px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
                {entMatches.map((e) => (
                  <div key={e.id} onClick={() => { setF((p) => ({ ...p, entity_id: e.id })); setEntityQuery(''); }}
                    style={{ padding: '8px 12px', fontSize: 13, cursor: 'pointer' }}
                    onMouseEnter={(ev) => (ev.currentTarget.style.background = '#f1f5f9')} onMouseLeave={(ev) => (ev.currentTarget.style.background = '#fff')}>
                    {e.name}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <input value={f.record_ref} onChange={set('record_ref')} placeholder="…or a record reference if it's not a client (e.g. invoice #, quote name)" style={{ ...input, marginTop: 8 }} />
      </Section>

      <Section n={4} title="What were you trying to do?">
        <textarea value={f.goal} onChange={set('goal')} rows={2} placeholder="The task you were doing when it went wrong" style={textarea} />
      </Section>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <Section n={5} title="What did you expect to happen?" style={{ flex: 1, minWidth: 260 }}>
          <textarea value={f.expected} onChange={set('expected')} rows={3} placeholder="The correct / expected behaviour" style={textarea} />
        </Section>
        <Section n={6} title="What actually happened?" required style={{ flex: 1, minWidth: 260 }}>
          <textarea value={f.actual} onChange={set('actual')} rows={3} placeholder="The symptom. Paste any error message word-for-word." style={textarea} />
        </Section>
      </div>

      <Section n={7} title="Steps to reproduce it">
        <textarea value={f.steps} onChange={set('steps')} rows={3} placeholder={"1. Go to…\n2. Click…\n3. See…"} style={textarea} />
      </Section>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <Section n={8} title="How often does it happen?" style={{ flex: 1, minWidth: 260 }}>
          <ChoiceRow options={FREQUENCY} value={f.frequency} onChange={(v) => setF((p) => ({ ...p, frequency: v }))} />
        </Section>
        <Section n={9} title="How much is it blocking you?" required style={{ flex: 1, minWidth: 260 }}>
          <ChoiceRow options={IMPACT} value={f.impact} onChange={(v) => setF((p) => ({ ...p, impact: v }))} colouredBy="colour" />
        </Section>
      </div>

      <Section n={10} title="When did it start / did it ever work before?">
        <input value={f.started} onChange={set('started')} placeholder="e.g. started after last week's update / never worked / worked yesterday" style={input} />
      </Section>

      <Section n={11} title="Screenshot (optional but very helpful)">
        {file ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={chip}><Paperclip size={12} /> {file.name}</span>
            <button onClick={() => setFile(null)} style={linkBtn}>remove</button>
          </div>
        ) : (
          <label style={{ ...btnOutline, cursor: 'pointer', width: 'fit-content' }}>
            <Paperclip size={14} /> Attach a screenshot
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </label>
        )}
      </Section>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', paddingTop: 4 }}>
        <button onClick={submit} disabled={!canSubmit} style={{ ...btnPrimary, opacity: canSubmit ? 1 : 0.4 }}>
          {saving ? 'Submitting…' : <><Plus size={15} /> Submit bug report</>}
        </button>
        {!canSubmit && !saving && <span style={{ fontSize: 12, color: '#94a3b8' }}>Summary, what actually happened, and impact are required.</span>}
      </div>
    </div>
  );
}

/* ─── Reporter's list / generic list ─────────────────────────────────── */
function BugList({ bugs, loading, entityMap, staffList, canTriage, onPatch, onDelete, profile, emptyMsg }) {
  const [expandedId, setExpandedId] = useState(null);
  if (loading) return <p style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: 40 }}>Loading…</p>;
  if (bugs.length === 0) return (
    <div style={{ textAlign: 'center', padding: 60, background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb' }}>
      <Bug size={32} style={{ color: '#e5e7eb', marginBottom: 12 }} />
      <p style={{ fontSize: 14, color: '#94a3b8' }}>{emptyMsg || 'No bugs.'}</p>
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {bugs.map((b) => (
        <BugCard key={b.id} bug={b} entityMap={entityMap} staffList={staffList} canTriage={canTriage}
          expanded={expandedId === b.id} onToggle={() => setExpandedId(expandedId === b.id ? null : b.id)}
          onPatch={onPatch} onDelete={onDelete} profile={profile} />
      ))}
    </div>
  );
}

/* ─── Triage board (gated) ───────────────────────────────────────────── */
function TriageBoard({ bugs, loading, entityMap, staffList, onPatch, onDelete, profile }) {
  const [expandedId, setExpandedId] = useState(null);
  const [showClosed, setShowClosed] = useState(false);

  const lanes = useMemo(() => {
    const order = ['new', 'needs_info', 'accepted', 'in_progress', 'fixed'];
    const grouped = {};
    order.forEach((s) => { grouped[s] = []; });
    const closed = [];
    bugs.forEach((b) => {
      if (['verified', 'rejected'].includes(b.status)) closed.push(b);
      else (grouped[b.status] ||= []).push(b);
    });
    // Sort each active lane by priority then age.
    const prioRank = { critical: 0, high: 1, medium: 2, low: 3, null: 4 };
    Object.values(grouped).forEach((arr) => arr.sort((a, b) =>
      (prioRank[a.priority] ?? 4) - (prioRank[b.priority] ?? 4) || new Date(a.created_at) - new Date(b.created_at)));
    return { order, grouped, closed };
  }, [bugs]);

  const thisWeek = useMemo(() => bugs.filter((b) => b.target === 'this_week' && ['accepted', 'in_progress'].includes(b.status)), [bugs]);
  const newCount = lanes.grouped.new?.length || 0;

  if (loading) return <p style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: 40 }}>Loading…</p>;

  return (
    <div>
      {/* This-week review strip */}
      <div style={{ background: 'linear-gradient(135deg,#0f172a,#1e293b)', borderRadius: 14, padding: '18px 22px', marginBottom: 20, color: '#fff' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 3 }}>Friday review</div>
            <div style={{ fontSize: 12.5, color: '#cbd5e1' }}>
              {newCount} new to triage · {thisWeek.length} accepted for this week · {(lanes.grouped.fixed?.length || 0)} awaiting verify
            </div>
          </div>
          <CopyButton
            label="Copy this week's brief"
            dark
            getText={() => {
              if (!thisWeek.length && !newCount) return 'No bugs to review this week.';
              const parts = ['# Bug review — this week', ''];
              if (thisWeek.length) {
                parts.push('## Accepted for this week', '');
                thisWeek.forEach((b) => parts.push(buildBrief(b, entityMap[b.entity_id]), '\n---\n'));
              }
              if (newCount) {
                parts.push('## New — need a decision', '');
                lanes.grouped.new.forEach((b) => parts.push(buildBrief(b, entityMap[b.entity_id]), '\n---\n'));
              }
              return parts.join('\n');
            }}
          />
        </div>
      </div>

      {/* Active lanes */}
      {lanes.order.map((s) => {
        const arr = lanes.grouped[s] || [];
        if (!arr.length) return null;
        const cfg = statusCfg(s);
        return (
          <div key={s} style={{ marginBottom: 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: cfg.colour }} />
              <h3 style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', textTransform: 'uppercase', letterSpacing: 0.3 }}>{cfg.lane}</h3>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>{arr.length}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {arr.map((b) => (
                <BugCard key={b.id} bug={b} entityMap={entityMap} staffList={staffList} canTriage
                  expanded={expandedId === b.id} onToggle={() => setExpandedId(expandedId === b.id ? null : b.id)}
                  onPatch={onPatch} onDelete={onDelete} profile={profile} />
              ))}
            </div>
          </div>
        );
      })}

      {/* Closed */}
      {lanes.closed.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button onClick={() => setShowClosed((v) => !v)} style={{ ...linkBtn, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
            {showClosed ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {lanes.closed.length} closed (verified / rejected)
          </button>
          {showClosed && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {lanes.closed.map((b) => (
                <BugCard key={b.id} bug={b} entityMap={entityMap} staffList={staffList} canTriage
                  expanded={expandedId === b.id} onToggle={() => setExpandedId(expandedId === b.id ? null : b.id)}
                  onPatch={onPatch} onDelete={onDelete} profile={profile} />
              ))}
            </div>
          )}
        </div>
      )}

      {bugs.length === 0 && (
        <div style={{ textAlign: 'center', padding: 60, background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb' }}>
          <p style={{ fontSize: 14, color: '#94a3b8' }}>No bugs reported. 🎉</p>
        </div>
      )}
    </div>
  );
}

/* ─── One bug card (list row + expanded brief/controls) ──────────────── */
function BugCard({ bug, entityMap, staffList, canTriage, expanded, onToggle, onPatch, onDelete, profile }) {
  const cfg = statusCfg(bug.status);
  const p = prioCfg(bug.priority);
  const entityName = entityMap[bug.entity_id];
  const suggested = suggestPriority(bug.impact, bug.frequency);
  const [shotUrl, setShotUrl] = useState(null);

  useEffect(() => {
    if (expanded && bug.screenshot_url && !shotUrl) {
      supabase.storage.from('client-documents').createSignedUrl(bug.screenshot_url, 3600)
        .then(({ data }) => { if (data?.signedUrl) setShotUrl(data.signedUrl); });
    }
  }, [expanded, bug.screenshot_url, shotUrl]);

  return (
    <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', borderLeft: `3px solid ${cfg.colour}` }}>
      <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer' }}>
        {expanded ? <ChevronDown size={15} style={{ color: '#94a3b8', flexShrink: 0 }} /> : <ChevronRight size={15} style={{ color: '#cbd5e1', flexShrink: 0 }} />}
        <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', flexShrink: 0 }}>BUG-{bug.seq}</span>
        {p && <span title={p.label} style={{ fontSize: 12, flexShrink: 0 }}>{p.icon}</span>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500, color: '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{bug.title}</div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {bug.module && <span style={{ background: '#f1f5f9', padding: '1px 6px', borderRadius: 4 }}>{bug.module}</span>}
            {entityName && <span>{entityName}</span>}
            <span>{bug.reported_by_name}</span>
            <span>{daysSince(bug.created_at)}d old</span>
          </div>
        </div>
        <span style={{ fontSize: 10, fontWeight: 600, padding: '3px 9px', borderRadius: 6, background: cfg.bg, color: cfg.colour, flexShrink: 0 }}>{cfg.label}</span>
      </div>

      {expanded && (
        <div style={{ padding: '4px 16px 16px', borderTop: '1px solid #f1f5f9' }}>
          {/* Reporter-supplied structured detail */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 20px', padding: '14px 0', fontSize: 12.5 }}>
            <Field label="Where">{bug.module || '—'}{bug.page_url ? <div style={{ fontSize: 11, color: '#94a3b8', wordBreak: 'break-all' }}>{bug.page_url}</div> : null}</Field>
            <Field label="Client / record">{[entityName, bug.record_ref].filter(Boolean).join(' · ') || '—'}</Field>
            <Field label="Frequency">{FREQUENCY.find((x) => x.id === bug.frequency)?.label || '—'}</Field>
            <Field label="Impact">{IMPACT.find((x) => x.id === bug.impact)?.label || '—'}</Field>
          </div>
          {bug.goal && <Detail label="Trying to do">{bug.goal}</Detail>}
          {bug.expected && <Detail label="Expected">{bug.expected}</Detail>}
          {bug.actual && <Detail label="Actual">{bug.actual}</Detail>}
          {bug.steps && <Detail label="Steps to reproduce">{bug.steps}</Detail>}
          {bug.started && <Detail label="When it started">{bug.started}</Detail>}
          {bug.screenshot_url && (
            <Detail label="Screenshot">
              {shotUrl ? <a href={shotUrl} target="_blank" rel="noopener noreferrer"><img src={shotUrl} alt="screenshot" style={{ maxWidth: '100%', maxHeight: 260, borderRadius: 8, border: '1px solid #e5e7eb', marginTop: 4 }} /></a> : <span style={{ color: '#94a3b8' }}>Loading…</span>}
            </Detail>
          )}
          {bug.context?.userAgent && (
            <Detail label="Environment">
              <span style={{ fontSize: 11, color: '#64748b' }}>{bug.context.viewport} · {bug.context.userAgent}</span>
            </Detail>
          )}

          {/* Triage controls */}
          {canTriage ? (
            <TriageControls bug={bug} suggested={suggested} staffList={staffList} entityName={entityName} onPatch={onPatch} onDelete={onDelete} profile={profile} />
          ) : (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #f1f5f9', display: 'flex', gap: 8, alignItems: 'center' }}>
              {bug.status === 'fixed' && bug.reported_by === profile?.id && (
                <button onClick={() => onPatch(bug.id, { status: 'verified' })} style={{ ...btnPrimary, background: '#16a34a' }}><Check size={14} /> Confirm it's fixed</button>
              )}
              {bug.reject_reason && <span style={{ fontSize: 12, color: '#64748b' }}>Closed: {REJECT_REASONS.find((r) => r.id === bug.reject_reason)?.label}</span>}
              {bug.resolution_notes && <span style={{ fontSize: 12, color: '#64748b' }}>{bug.resolution_notes}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Triage controls block ──────────────────────────────────────────── */
function TriageControls({ bug, suggested, staffList, entityName, onPatch, onDelete, profile }) {
  const [notes, setNotes] = useState(bug.triage_notes || '');
  const [resolution, setResolution] = useState(bug.resolution_notes || '');
  const isClosed = ['verified', 'rejected'].includes(bug.status);

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #f1f5f9' }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
        <div>
          <label style={miniLabel}>Priority {bug.priority !== suggested && <span style={{ color: '#0e7fe0', fontWeight: 500 }}>· suggested: {prioCfg(suggested)?.label}</span>}</label>
          <select value={bug.priority || ''} onChange={(e) => onPatch(bug.id, { priority: e.target.value || null })} style={miniSelect}>
            <option value="">— set —</option>
            {PRIORITIES.map((x) => <option key={x.id} value={x.id}>{x.icon} {x.label}</option>)}
          </select>
        </div>
        <div>
          <label style={miniLabel}>Status</label>
          <select value={bug.status} onChange={(e) => onPatch(bug.id, { status: e.target.value })} style={miniSelect}>
            {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <label style={miniLabel}>Target</label>
          <select value={bug.target || ''} onChange={(e) => onPatch(bug.id, { target: e.target.value || null })} style={miniSelect}>
            <option value="">—</option>
            <option value="this_week">This week</option>
            <option value="backlog">Backlog</option>
          </select>
        </div>
        <div>
          <label style={miniLabel}>Owner</label>
          <select value={bug.assignee_id || ''} onChange={(e) => onPatch(bug.id, { assignee_id: e.target.value || null })} style={miniSelect}>
            <option value="">Claude / unassigned</option>
            {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      {/* Quick disposition buttons */}
      {!isClosed && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {bug.status === 'new' && (
            <>
              <button onClick={() => onPatch(bug.id, { status: 'accepted', priority: bug.priority || suggested, target: bug.target || 'backlog' })} style={{ ...btnSmall, borderColor: '#fcd34d', color: '#b45309' }}>✓ Accept</button>
              <button onClick={() => onPatch(bug.id, { status: 'needs_info' })} style={{ ...btnSmall, borderColor: '#ddd6fe', color: '#6d28d9' }}>? Need info</button>
            </>
          )}
          {bug.status === 'accepted' && <button onClick={() => onPatch(bug.id, { status: 'in_progress' })} style={{ ...btnSmall, borderColor: '#a5f3fc', color: '#0e7490' }}>▶ Start</button>}
          {bug.status === 'in_progress' && <button onClick={() => onPatch(bug.id, { status: 'fixed' })} style={{ ...btnSmall, borderColor: '#86efac', color: '#15803d' }}>✓ Mark fixed</button>}
          {bug.status === 'fixed' && <button onClick={() => onPatch(bug.id, { status: 'verified' })} style={{ ...btnSmall, borderColor: '#86efac', color: '#15803d' }}>✓✓ Verified</button>}
          <RejectControl bug={bug} onPatch={onPatch} />
        </div>
      )}

      {/* Notes */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <label style={miniLabel}>Triage notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== bug.triage_notes && onPatch(bug.id, { triage_notes: notes })}
            rows={2} placeholder="Context for the fix, root-cause guess, links…" style={{ ...textarea, fontSize: 12 }} />
        </div>
        {['fixed', 'verified'].includes(bug.status) && (
          <div style={{ flex: 1, minWidth: 240 }}>
            <label style={miniLabel}>Resolution notes</label>
            <textarea value={resolution} onChange={(e) => setResolution(e.target.value)} onBlur={() => resolution !== bug.resolution_notes && onPatch(bug.id, { resolution_notes: resolution })}
              rows={2} placeholder="What was fixed / commit ref" style={{ ...textarea, fontSize: 12 }} />
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
        <CopyButton label="Copy Claude brief" getText={() => buildBrief(bug, entityName)} />
        <div style={{ flex: 1 }} />
        <button onClick={() => onDelete(bug)} style={{ ...btnSmall, borderColor: '#fecaca', color: '#dc2626' }}>Delete</button>
      </div>
    </div>
  );
}

function RejectControl({ bug, onPatch }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button onClick={() => setOpen(true)} style={{ ...btnSmall, borderColor: '#e2e8f0', color: '#64748b' }}>✕ Reject</button>;
  return (
    <select autoFocus defaultValue="" onChange={(e) => { if (e.target.value) { onPatch(bug.id, { status: 'rejected', reject_reason: e.target.value }); setOpen(false); } }}
      onBlur={() => setOpen(false)} style={{ ...miniSelect, borderColor: '#fecaca' }}>
      <option value="" disabled>Reject reason…</option>
      {REJECT_REASONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
    </select>
  );
}

/* ─── Small pieces ───────────────────────────────────────────────────── */
function Section({ n, title, required, children, style }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 16px', ...style }}>
      <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: '#334155', marginBottom: 8 }}>
        <span style={{ color: '#cbd5e1', fontWeight: 700, marginRight: 6 }}>{n}</span>{title}
        {required && <span style={{ color: '#dc2626', marginLeft: 4 }}>*</span>}
      </label>
      {children}
    </div>
  );
}

function ChoiceRow({ options, value, onChange, colouredBy }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {options.map((o) => {
        const active = value === o.id;
        const c = colouredBy ? o[colouredBy] : '#0e7fe0';
        return (
          <button key={o.id} onClick={() => onChange(o.id)} title={o.hint} style={{
            padding: '7px 12px', fontSize: 12, fontWeight: active ? 600 : 400,
            border: `1px solid ${active ? c : '#e5e7eb'}`, borderRadius: 8, cursor: 'pointer',
            background: active ? `${c}12` : '#fff', color: active ? c : '#475569',
            fontFamily: "'Outfit', sans-serif",
          }}>{o.label}</button>
        );
      })}
    </div>
  );
}

function Field({ label, children }) {
  return <div><div style={{ fontSize: 10, textTransform: 'uppercase', fontWeight: 600, color: '#94a3b8', marginBottom: 2 }}>{label}</div><div style={{ color: '#1e293b' }}>{children}</div></div>;
}
function Detail({ label, children }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', fontWeight: 600, color: '#94a3b8', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 13, color: '#1e293b', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{children}</div>
    </div>
  );
}

function CopyButton({ getText, label, dark }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(getText()); setDone(true); setTimeout(() => setDone(false), 1600); } catch (e) { console.error(e); }
  };
  return (
    <button onClick={copy} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', fontSize: 12, fontWeight: 600,
      borderRadius: 9, cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
      background: dark ? 'rgba(255,255,255,0.12)' : '#fff', color: dark ? '#fff' : '#0f172a',
      border: dark ? '1px solid rgba(255,255,255,0.25)' : '1px solid #e5e7eb',
    }}>
      {done ? <Check size={14} /> : <Copy size={14} />} {done ? 'Copied' : label}
    </button>
  );
}

/* ─── Styles ─────────────────────────────────────────────────────────── */
const tabBtn = (active) => ({
  padding: '9px 14px', fontSize: 13, fontWeight: active ? 600 : 400,
  color: active ? '#0f172a' : '#94a3b8', background: 'none', border: 'none',
  borderBottom: active ? '2px solid #0e7fe0' : '2px solid transparent',
  cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
});
const input = { width: '100%', padding: '9px 12px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 8, outline: 'none', fontFamily: "'Outfit', sans-serif", boxSizing: 'border-box' };
const textarea = { ...input, resize: 'vertical', lineHeight: 1.5 };
const btnPrimary = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 18px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" };
const btnOutline = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', fontSize: 13, fontWeight: 600, background: '#fff', color: '#0f172a', border: '1px solid #e5e7eb', borderRadius: 10, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" };
const btnSmall = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', fontSize: 12, fontWeight: 600, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" };
const linkBtn = { background: 'none', border: 'none', color: '#0e7fe0', fontSize: 12, cursor: 'pointer', fontFamily: "'Outfit', sans-serif", padding: 0 };
const chip = { display: 'inline-flex', alignItems: 'center', gap: 5, background: '#eff6ff', color: '#0e7fe0', fontSize: 12.5, fontWeight: 500, padding: '5px 10px', borderRadius: 7 };
const miniLabel = { display: 'block', fontSize: 10, textTransform: 'uppercase', fontWeight: 600, color: '#94a3b8', marginBottom: 3 };
const miniSelect = { fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 7, padding: '5px 8px', outline: 'none', fontFamily: "'Outfit', sans-serif", background: '#fff' };
