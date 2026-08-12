import React, { useEffect, useMemo, useState } from 'react';
import {
  Clock, ChevronRight, ChevronDown, RefreshCw, Database,
  Cpu, UserCheck, AlertTriangle, Pause, Play, Pencil, Check, X, Bot, History,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AppShell';
import {
  describeCron, nextRun, formatLondon, formatUtcTime, relativeTo, parseCron,
} from './cronSchedule';

/*
  Scheduled Jobs — /admin/schedules (can_manage_portal only).

  What runs on a timer, when it next fires, where its data comes from — and,
  since sql/224, the settings each job obeys, editable here.

  Rows come from list_scheduled_jobs(): the live pg_cron table joined to the
  descriptions in scheduled_job_docs, each job's last run, and the config
  switch that arms it. Settings are NOT stored on this page's tables — each
  one is a binding to the real config column the job reads
  (onboarding_chase_config.weekly_enabled and friends), so there is one source
  of truth and the edge functions carry on reading what they always read.
  set_scheduled_job_setting() will only write a column that has a binding row.

  Next-due is worked out in the browser from the cron expression, in UTC —
  pg_cron runs on the database clock, which is UTC all year. London time is
  shown alongside because it is an hour ahead through the summer.

  An automation reads its own settings back with scheduled_job_brief(job_key)
  and reports the outcome with scheduled_job_report_run(...), which is what
  fills the last-run column for work scheduled outside the database.
*/

const font = "'Outfit', sans-serif";
const serif = "'Playfair Display', serif";
const mono = 'ui-monospace, monospace';

const CATEGORY_ORDER = [
  'Client data ingest',
  'Client-facing automation',
  'Internal digests & alerts',
  'Control checks',
  'Housekeeping',
  'Undocumented',
];

const CATEGORY_BLURB = {
  'Client data ingest': 'Pulling facts in from outside — Companies House, QuickBooks, HMRC, the mailboxes.',
  'Client-facing automation': 'Jobs that can put something in front of a client.',
  'Internal digests & alerts': 'What Athena tells the team, and when.',
  'Control checks': 'Recurring checks that our records and the client’s agree.',
  Housekeeping: 'Plumbing. Nothing user-facing.',
  Undocumented: 'Scheduled in the database with no description written yet.',
};

/* Live / Disarmed / Paused — the distinction that actually matters.
   A job can fire every night with its config switch off, in which case the
   wrapper returns immediately and no work is done. */
function jobState(job) {
  if (job.source === 'external') return { label: 'Needs sign-in', tone: 'blue' };
  if (job.cron_active === false) return { label: 'Paused', tone: 'grey' };
  if (job.gate_enabled === false) return { label: 'Disarmed', tone: 'amber' };
  return { label: 'Live', tone: 'green' };
}

const TONES = {
  green: { bg: '#dcfce7', fg: '#166534' },
  amber: { bg: '#fef3c7', fg: '#92400e' },
  grey: { bg: '#f1f5f9', fg: '#475569' },
  blue: { bg: '#dbeafe', fg: '#1e40af' },
  red: { bg: '#fee2e2', fg: '#991b1b' },
};

function Pill({ tone, children }) {
  const t = TONES[tone] || TONES.grey;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 999,
      fontSize: 11, fontWeight: 600, background: t.bg, color: t.fg,
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function Field({ icon: Icon, label, children }) {
  if (!children) return null;
  return (
    <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
      <Icon size={15} color="#94a3b8" style={{ flexShrink: 0, marginTop: 2 }} />
      <div>
        <div style={{
          fontSize: 11, fontWeight: 700, color: '#94a3b8',
          textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2,
        }}>
          {label}
        </div>
        <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.55 }}>{children}</div>
      </div>
    </div>
  );
}

const btn = (primary) => ({
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '5px 11px', fontSize: 12.5, fontWeight: 600, fontFamily: font,
  color: primary ? '#fff' : '#0f172a',
  background: primary ? '#0f172a' : '#fff',
  border: `1px solid ${primary ? '#0f172a' : '#e2e8f0'}`,
  borderRadius: 7, cursor: 'pointer',
});

const inputStyle = {
  fontFamily: mono, fontSize: 13, padding: '5px 8px',
  border: '1px solid #cbd5e1', borderRadius: 6, color: '#0f172a',
};

/* ── A single setting, bound to the real config column ─────────────────── */
function SettingControl({ jobKey, setting, onSave, busy }) {
  const [draft, setDraft] = useState(String(setting.value ?? ''));
  useEffect(() => { setDraft(String(setting.value ?? '')); }, [setting.value]);

  const clientFacing = setting.risk === 'client_facing';

  if (setting.value_type === 'boolean') {
    const on = setting.value === true;
    const flip = () => {
      // Turning ON something that can reach a client is worth a beat.
      if (!on && clientFacing) {
        const ok = window.confirm(
          `${setting.label}\n\n${setting.risk_note || 'This can send email to clients.'}\n\nTurn it on?`,
        );
        if (!ok) return;
      }
      onSave(jobKey, setting.setting_key, !on);
    };
    return (
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 14 }}>
        <button
          onClick={flip}
          disabled={busy}
          aria-pressed={on}
          style={{
            flexShrink: 0, width: 38, height: 21, borderRadius: 999, border: 'none',
            background: on ? '#16a34a' : '#cbd5e1', position: 'relative',
            cursor: busy ? 'wait' : 'pointer', marginTop: 1, padding: 0,
          }}
        >
          <span style={{
            position: 'absolute', top: 2, left: on ? 19 : 2, width: 17, height: 17,
            borderRadius: 999, background: '#fff', transition: 'left .12s',
          }} />
        </button>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>
            {setting.label}
            {clientFacing && (
              <span style={{ marginLeft: 8 }}><Pill tone="amber">client-facing</Pill></span>
            )}
          </div>
          {setting.help && (
            <div style={{ fontSize: 12.5, color: '#64748b', lineHeight: 1.5, marginTop: 1 }}>
              {setting.help}
            </div>
          )}
          <div style={{ fontSize: 11, color: '#b6c2d1', fontFamily: mono, marginTop: 2 }}>
            {setting.binding}
          </div>
        </div>
      </div>
    );
  }

  const dirty = draft !== String(setting.value ?? '');
  const commit = () => {
    if (!dirty) return;
    const v = setting.value_type === 'int' ? Number(draft) : draft;
    if (setting.value_type === 'int' && !Number.isFinite(v)) return;
    onSave(jobKey, setting.setting_key, v);
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', marginBottom: 3 }}>
        {setting.label}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type={setting.value_type === 'int' ? 'number' : 'text'}
          value={draft}
          min={setting.min_value ?? undefined}
          max={setting.max_value ?? undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
          disabled={busy}
          style={{ ...inputStyle, width: setting.value_type === 'int' ? 80 : 260 }}
        />
        {dirty && (
          <>
            <button onClick={commit} disabled={busy} style={btn(true)}><Check size={13} /> Save</button>
            <button onClick={() => setDraft(String(setting.value ?? ''))} style={btn(false)}>
              <X size={13} />
            </button>
          </>
        )}
        {setting.value_type === 'int' && (setting.min_value != null || setting.max_value != null) && (
          <span style={{ fontSize: 11.5, color: '#94a3b8' }}>
            {setting.min_value}–{setting.max_value}
          </span>
        )}
      </div>
      {setting.help && (
        <div style={{ fontSize: 12.5, color: '#64748b', lineHeight: 1.5, marginTop: 3 }}>
          {setting.help}
        </div>
      )}
      <div style={{ fontSize: 11, color: '#b6c2d1', fontFamily: mono, marginTop: 2 }}>
        {setting.binding}
      </div>
    </div>
  );
}

/* ── Schedule: edit the cron expression, with a preview ────────────────── */
function ScheduleEditor({ job, onSaveSchedule, onToggleActive, busy }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(job.cron_expression || '');
  useEffect(() => { setDraft(job.cron_expression || ''); }, [job.cron_expression]);

  const valid = !!parseCron(draft);
  const preview = useMemo(() => {
    if (!valid) return [];
    const out = [];
    let from = new Date();
    for (let i = 0; i < 3; i += 1) {
      const n = nextRun(draft, from);
      if (!n) break;
      out.push(n);
      from = n;
    }
    return out;
  }, [draft, valid]);

  if (!editing) {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: '#334155' }}>
          {job.cron_expression ? describeCron(job.cron_expression) : (job.external_schedule || 'No schedule recorded')}
        </span>
        {job.cron_expression && (
          <code style={{ fontFamily: mono, fontSize: 12, background: '#eef2f7', padding: '1px 5px', borderRadius: 4 }}>
            {job.cron_expression}
          </code>
        )}
        <button onClick={() => setEditing(true)} style={btn(false)}><Pencil size={12} /> Change</button>
        {job.source === 'pg_cron' && (
          job.cron_active
            ? <button onClick={() => onToggleActive(job.job_key, false)} disabled={busy} style={btn(false)}><Pause size={12} /> Pause</button>
            : <button onClick={() => onToggleActive(job.job_key, true)} disabled={busy} style={btn(true)}><Play size={12} /> Resume</button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && valid) { onSaveSchedule(job.job_key, draft.trim()); setEditing(false); } }}
          placeholder="minute hour day-of-month month day-of-week"
          style={{ ...inputStyle, width: 240 }}
        />
        <button
          onClick={() => { onSaveSchedule(job.job_key, draft.trim()); setEditing(false); }}
          disabled={!valid || busy}
          style={{ ...btn(true), opacity: valid ? 1 : 0.5 }}
        >
          <Check size={13} /> Save
        </button>
        <button onClick={() => { setDraft(job.cron_expression || ''); setEditing(false); }} style={btn(false)}>
          <X size={13} /> Cancel
        </button>
      </div>
      <div style={{ fontSize: 12.5, color: valid ? '#334155' : '#b91c1c', marginTop: 6 }}>
        {valid ? describeCron(draft) : 'Five fields, separated by spaces — minute hour day-of-month month day-of-week.'}
      </div>
      {valid && preview.length > 0 && (
        <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>
          Would next run {preview.map((p) => `${formatLondon(p)} (${formatUtcTime(p)})`).join(' · ')}
        </div>
      )}
      {job.source === 'external' && (
        <div style={{ fontSize: 12.5, color: '#92400e', marginTop: 6 }}>
          Athena only records the intended cadence for this one — the scheduler on the
          machine that runs it has to be pointed at the same time separately.
        </div>
      )}
    </div>
  );
}

/* ── Free text an automation reads before it runs ──────────────────────── */
function TextBlock({ label, hint, value, placeholder, onSave, busy, monoFont }) {
  const [draft, setDraft] = useState(value || '');
  const [open, setOpen] = useState(false);
  useEffect(() => { setDraft(value || ''); }, [value]);
  const dirty = draft !== (value || '');

  return (
    <div style={{ marginTop: 14 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          fontFamily: font, fontSize: 11, fontWeight: 700, color: '#94a3b8',
          textTransform: 'uppercase', letterSpacing: 0.5,
          display: 'flex', alignItems: 'center', gap: 5,
        }}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Bot size={13} /> {label}
        {!open && value && <span style={{ textTransform: 'none', fontWeight: 500 }}>— set</span>}
      </button>
      {open && (
        <div style={{ marginTop: 6 }}>
          {hint && (
            <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 5, lineHeight: 1.5 }}>{hint}</div>
          )}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            rows={monoFont ? 5 : 8}
            style={{
              width: '100%', maxWidth: 760, ...inputStyle,
              fontFamily: monoFont ? mono : font, lineHeight: 1.55, resize: 'vertical',
            }}
          />
          {dirty && (
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button onClick={() => onSave(draft)} disabled={busy} style={btn(true)}>
                <Check size={13} /> Save
              </button>
              <button onClick={() => setDraft(value || '')} style={btn(false)}>
                <X size={13} /> Discard
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SchedulesPage() {
  const { profile } = useAuth();
  const [jobs, setJobs] = useState([]);
  const [changes, setChanges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null);
  const [expanded, setExpanded] = useState({});
  // Re-tick every 30s so "in 4 hours" doesn't go stale on a left-open tab.
  const [now, setNow] = useState(() => new Date());

  const isAdmin = profile?.can_manage_portal === true;

  const load = async () => {
    const [jobsRes, changesRes] = await Promise.all([
      supabase.rpc('list_scheduled_jobs'),
      supabase.rpc('list_scheduled_job_changes', { p_limit: 15 }),
    ]);
    if (jobsRes.error) setError(jobsRes.error.message);
    else { setError(''); setJobs(jobsRes.data || []); }
    setChanges(changesRes.data || []);
    setNow(new Date());
    setLoading(false);
  };

  useEffect(() => { if (isAdmin) load(); }, [isAdmin]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const flash = (text, tone = 'green') => {
    setNotice({ text, tone });
    setTimeout(() => setNotice(null), 4000);
  };

  /* Every mutation goes through here: run it, say what happened, reload so
     the page shows what the database now says rather than what we hoped. */
  const mutate = async (key, fn, okText) => {
    setBusy(key);
    const { error: err } = await fn();
    setBusy(null);
    if (err) flash(err.message, 'red');
    else { flash(okText); await load(); }
  };

  const saveSetting = (jobKey, settingKey, value) => mutate(
    `${jobKey}:${settingKey}`,
    () => supabase.rpc('set_scheduled_job_setting', {
      p_job_key: jobKey, p_setting_key: settingKey, p_value: value,
    }),
    'Setting saved.',
  );

  const saveSchedule = (jobKey, cron) => mutate(
    `${jobKey}:schedule`,
    () => supabase.rpc('set_scheduled_job_schedule', { p_job_key: jobKey, p_cron: cron }),
    'Schedule changed.',
  );

  const toggleActive = (jobKey, active) => {
    if (!active && !window.confirm('Pause this job? It stops firing until you resume it.')) return;
    mutate(
      `${jobKey}:active`,
      () => supabase.rpc('set_scheduled_job_active', { p_job_key: jobKey, p_active: active }),
      active ? 'Job resumed.' : 'Job paused.',
    );
  };

  const saveInstructions = (jobKey, text) => mutate(
    `${jobKey}:instructions`,
    () => supabase.rpc('set_scheduled_job_instructions', { p_job_key: jobKey, p_text: text }),
    'Instructions saved.',
  );

  const saveClaudeSettings = (jobKey, text) => {
    let parsed;
    try {
      parsed = JSON.parse(text || '{}');
    } catch {
      flash('That isn’t valid JSON — check the quotes and commas.', 'red');
      return;
    }
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      flash('Settings need to be a JSON object, e.g. {"services": ["paye"]}', 'red');
      return;
    }
    mutate(
      `${jobKey}:json`,
      () => supabase.rpc('set_scheduled_job_claude_settings', { p_job_key: jobKey, p_settings: parsed }),
      'Runner settings saved.',
    );
  };

  const rows = useMemo(() => jobs.map((j) => {
    const expr = j.cron_expression;
    const next = expr ? nextRun(expr, now) : null;
    return {
      ...j,
      next,
      scheduleText: expr ? describeCron(expr) : (j.external_schedule || '—'),
      lastRun: j.last_run_at ? new Date(j.last_run_at) : null,
      state: jobState(j),
      settingList: Array.isArray(j.settings) ? j.settings : [],
    };
  }).sort((a, b) => (a.sort_order - b.sort_order) || a.title.localeCompare(b.title)),
  [jobs, now]);

  const grouped = useMemo(() => {
    const byCat = {};
    for (const r of rows) (byCat[r.category] ||= []).push(r);
    return CATEGORY_ORDER
      .filter((c) => byCat[c]?.length)
      .map((c) => [c, byCat[c]])
      .concat(Object.keys(byCat)
        .filter((c) => !CATEGORY_ORDER.includes(c))
        .map((c) => [c, byCat[c]]));
  }, [rows]);

  const counts = useMemo(() => ({
    total: rows.length,
    live: rows.filter((r) => r.state.label === 'Live').length,
    disarmed: rows.filter((r) => r.state.label === 'Disarmed').length,
    paused: rows.filter((r) => r.state.label === 'Paused').length,
    failed: rows.filter((r) => r.last_run_status === 'failed').length,
  }), [rows]);

  const nextUp = useMemo(() => rows
    .filter((r) => r.next && r.state.label !== 'Paused')
    .sort((a, b) => a.next - b.next)[0], [rows]);

  if (!isAdmin) {
    return (
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '40px 24px', fontFamily: font }}>
        <h1 style={{ fontFamily: serif, fontSize: 28, fontWeight: 500, color: '#0f172a', marginBottom: 8 }}>
          Scheduled Jobs
        </h1>
        <p style={{ fontSize: 14, color: '#64748b' }}>
          You need the Portal admin permission to view the schedule.
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '40px 24px', fontFamily: font }}>
      {notice && (
        <div style={{
          position: 'fixed', bottom: 22, right: 22, zIndex: 50, maxWidth: 420,
          padding: '11px 16px', borderRadius: 9, fontSize: 13, fontWeight: 500,
          background: notice.tone === 'red' ? '#991b1b' : '#0f172a', color: '#fff',
          boxShadow: '0 8px 24px rgba(15,23,42,.22)',
        }}>
          {notice.text}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontFamily: serif, fontSize: 28, fontWeight: 500, color: '#0f172a', marginBottom: 8 }}>
            Scheduled Jobs
          </h1>
          <p style={{ fontSize: 14, color: '#64748b', maxWidth: 780, lineHeight: 1.6 }}>
            Everything Athena runs on a timer — what it does, where it gets its data,
            when it next fires, and the settings it obeys. Open a row to change a
            switch, a threshold or the schedule itself; changes take effect on the next
            run. The database clock is <strong>UTC</strong>, so a job set for 08:00 lands
            at 09:00 London through the summer.
          </p>
        </div>
        <button onClick={load} style={{ ...btn(false), padding: '8px 14px', fontSize: 13, flexShrink: 0 }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '20px 0 8px' }}>
        <Pill tone="grey">{counts.total} scheduled</Pill>
        <Pill tone="green">{counts.live} live</Pill>
        {counts.disarmed > 0 && <Pill tone="amber">{counts.disarmed} disarmed</Pill>}
        {counts.paused > 0 && <Pill tone="grey">{counts.paused} paused</Pill>}
        {counts.failed > 0 && <Pill tone="red">{counts.failed} last run failed</Pill>}
      </div>
      {nextUp && (
        <p style={{ fontSize: 13, color: '#64748b', marginBottom: 24 }}>
          Next up: <strong style={{ color: '#0f172a' }}>{nextUp.title}</strong>
          {' '}{relativeTo(nextUp.next, now)} — {formatLondon(nextUp.next)}
        </p>
      )}

      {error && (
        <div style={{
          background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8,
          padding: '12px 16px', fontSize: 13, color: '#991b1b', marginBottom: 20,
        }}>
          Couldn&rsquo;t load the schedule: {error}
        </div>
      )}

      {loading && <p style={{ fontSize: 14, color: '#64748b' }}>Loading&hellip;</p>}

      {!loading && grouped.map(([category, catRows]) => (
        <section key={category} style={{ marginBottom: 32 }}>
          <h2 style={{ fontFamily: serif, fontSize: 19, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
            {category}
          </h2>
          <p style={{ fontSize: 12.5, color: '#94a3b8', marginBottom: 12 }}>
            {CATEGORY_BLURB[category] || ''}
          </p>

          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
            {catRows.map((job, i) => {
              const open = !!expanded[job.job_key];
              const Chevron = open ? ChevronDown : ChevronRight;
              const rowBusy = typeof busy === 'string' && busy.startsWith(`${job.job_key}:`);
              return (
                <div key={job.job_key} style={{ borderTop: i === 0 ? 'none' : '1px solid #f1f5f9' }}>
                  <div
                    onClick={() => setExpanded((p) => ({ ...p, [job.job_key]: !p[job.job_key] }))}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '20px minmax(200px, 1.4fr) minmax(180px, 1.3fr) 150px 150px',
                      gap: 14, alignItems: 'center', padding: '14px 16px',
                      cursor: 'pointer', background: open ? '#f8fafc' : '#fff',
                    }}
                  >
                    <Chevron size={16} color="#94a3b8" />

                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{job.title}</div>
                      <div style={{
                        fontSize: 11.5, color: '#94a3b8', fontFamily: mono,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {job.job_key}
                      </div>
                    </div>

                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: '#334155' }}>{job.scheduleText}</div>
                      {job.cron_expression && (
                        <div style={{ fontSize: 11.5, color: '#94a3b8', fontFamily: mono }}>
                          {job.cron_expression}
                        </div>
                      )}
                    </div>

                    <div>
                      {job.next ? (
                        <>
                          <div style={{ fontSize: 13, color: '#0f172a', fontWeight: 500 }}>
                            {relativeTo(job.next, now)}
                          </div>
                          <div style={{ fontSize: 11.5, color: '#94a3b8' }}>
                            {formatLondon(job.next)} · {formatUtcTime(job.next)}
                          </div>
                        </>
                      ) : (
                        <span style={{ fontSize: 13, color: '#94a3b8' }}>—</span>
                      )}
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                      <Pill tone={job.state.tone}>{job.state.label}</Pill>
                      {job.lastRun && (
                        <span style={{
                          fontSize: 11.5,
                          color: job.last_run_status === 'failed' ? '#b91c1c' : '#94a3b8',
                        }}>
                          {job.last_run_status === 'failed' && <AlertTriangle size={10} style={{ marginRight: 3 }} />}
                          ran {relativeTo(job.lastRun, now)}
                        </span>
                      )}
                    </div>
                  </div>

                  {open && (
                    <div style={{ padding: '4px 16px 20px 50px', background: '#f8fafc' }}>
                      <p style={{ fontSize: 13.5, color: '#0f172a', lineHeight: 1.6, marginBottom: 16, maxWidth: 760 }}>
                        {job.purpose || 'No description written yet.'}
                      </p>

                      <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                        gap: '0 32px', maxWidth: 900,
                      }}>
                        <Field icon={Database} label="Where the data comes from">{job.data_source}</Field>
                        <Field icon={Cpu} label="How it runs">{job.mechanism}</Field>
                        <Field icon={UserCheck} label="Runs as">{job.run_as}</Field>
                        <Field icon={Clock} label="Schedule">
                          <ScheduleEditor
                            job={job}
                            onSaveSchedule={saveSchedule}
                            onToggleActive={toggleActive}
                            busy={rowBusy}
                          />
                        </Field>
                      </div>

                      {/* Settings — each one writes the config column the job reads. */}
                      <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 14, marginTop: 4, maxWidth: 760 }}>
                        <div style={{
                          fontSize: 11, fontWeight: 700, color: '#94a3b8',
                          textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10,
                        }}>
                          Settings
                        </div>
                        {job.settingList.length === 0 ? (
                          <p style={{ fontSize: 12.5, color: '#94a3b8', lineHeight: 1.5 }}>
                            Nothing to configure — this job has no switch of its own, so it
                            does its work every time it fires.
                            {job.gate_label ? ` Gate: ${job.gate_label.replace(/\.$/, '')}.` : ''}
                          </p>
                        ) : (
                          job.settingList.map((s) => (
                            <SettingControl
                              key={s.setting_key}
                              jobKey={job.job_key}
                              setting={s}
                              onSave={saveSetting}
                              busy={busy === `${job.job_key}:${s.setting_key}`}
                            />
                          ))
                        )}

                        <TextBlock
                          label="Instructions for the runner"
                          hint="Read back by the automation itself via scheduled_job_brief() — so this is the copy that governs the run, not a note about it."
                          value={job.instructions}
                          placeholder="What should the runner do, and what should it refuse to do?"
                          onSave={(t) => saveInstructions(job.job_key, t)}
                          busy={busy === `${job.job_key}:instructions`}
                        />

                        {(job.source === 'external'
                          || (job.claude_settings && Object.keys(job.claude_settings).length > 0)) && (
                          <TextBlock
                            label="Runner settings (JSON)"
                            hint="Knobs with no config table of their own. Merged into the settings the runner reads; a bound setting above always wins."
                            value={JSON.stringify(job.claude_settings || {}, null, 2)}
                            placeholder='{"services": ["paye", "corporation-tax"]}'
                            onSave={(t) => saveClaudeSettings(job.job_key, t)}
                            busy={busy === `${job.job_key}:json`}
                            monoFont
                          />
                        )}
                      </div>

                      {(job.command || job.last_run_message) && (
                        <div style={{
                          borderTop: '1px solid #e2e8f0', paddingTop: 10, marginTop: 14,
                          fontSize: 11.5, color: '#94a3b8', fontFamily: mono,
                        }}>
                          {job.command && <div>{job.command}</div>}
                          {job.last_run_message && (
                            <div style={{ color: job.last_run_status === 'failed' ? '#b91c1c' : '#94a3b8' }}>
                              last run: {job.last_run_status} — {job.last_run_message}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {!loading && changes.length > 0 && (
        <section style={{ marginBottom: 28 }}>
          <h2 style={{
            fontFamily: serif, fontSize: 19, fontWeight: 500, color: '#0f172a',
            marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <History size={17} color="#94a3b8" /> Recent changes
          </h2>
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
            {changes.map((c, i) => (
              <div key={`${c.changed_at}-${i}`} style={{
                padding: '10px 16px', borderTop: i === 0 ? 'none' : '1px solid #f1f5f9',
                fontSize: 12.5, color: '#334155', display: 'flex', gap: 10, flexWrap: 'wrap',
              }}>
                <span style={{ color: '#94a3b8', minWidth: 130 }}>{formatLondon(new Date(c.changed_at))}</span>
                <span style={{ fontWeight: 600 }}>{c.title}</span>
                <span>
                  {c.change_type === 'setting' ? c.setting_key
                    : c.change_type === 'active' ? 'paused/resumed'
                    : c.change_type === 'settings_json' ? 'runner settings'
                    : c.change_type}
                </span>
                <span style={{ fontFamily: mono, color: '#64748b' }}>
                  {(c.old_value ?? '—')} → {(c.new_value ?? '—')}
                </span>
                <span style={{ color: '#94a3b8' }}>{c.changed_by_name || 'automation'}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {!loading && !error && (
        <p style={{ fontSize: 12.5, color: '#94a3b8', lineHeight: 1.6, maxWidth: 780 }}>
          Settings here are not copies: each one writes the config column the job already
          reads, and only columns with a registered binding can be written at all.
          Schedules change <code style={{ fontFamily: mono }}>cron.job</code> directly. An
          automation reads its own switches and instructions back with{' '}
          <code style={{ fontFamily: mono }}>scheduled_job_brief(job_key)</code> and reports
          the outcome with <code style={{ fontFamily: mono }}>scheduled_job_report_run(…)</code>,
          which is what fills the last-run column for work scheduled outside the database.
        </p>
      )}
    </div>
  );
}
