import React, { useEffect, useMemo, useState } from 'react';
import {
  Clock, ChevronRight, ChevronDown, RefreshCw, Database,
  Cpu, UserCheck, AlertTriangle,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AppShell';
import {
  describeCron, nextRun, formatLondon, formatUtcTime, relativeTo,
} from './cronSchedule';

/*
  Scheduled Jobs — /admin/schedules (can_manage_portal only).

  One page answering: what runs on a timer, when is it next due, where does
  its data come from, and is it actually armed? Rows come from
  list_scheduled_jobs() (sql/223), which joins the LIVE pg_cron table to the
  plain-English descriptions in scheduled_job_docs and to each job's last run.

  Next-due is worked out in the browser from the cron expression, in UTC —
  pg_cron runs on the database clock, which is UTC all year. London time is
  shown alongside because that is an hour ahead through the summer.

  Step 2 (not built): let Claude read its instructions from scheduled_job_docs
  rather than the description being documentation only. The table is already
  writable by portal admins for that reason.
*/

const font = "'Outfit', sans-serif";
const serif = "'Playfair Display', serif";

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
  if (job.source === 'external') {
    return { label: 'Needs sign-in', tone: 'blue' };
  }
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

export default function SchedulesPage() {
  const { profile } = useAuth();
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState({});
  // Re-tick every 30s so "in 4 hours" doesn't go stale on a left-open tab.
  const [now, setNow] = useState(() => new Date());

  const isAdmin = profile?.can_manage_portal === true;

  const load = async () => {
    setLoading(true);
    const { data, error: err } = await supabase.rpc('list_scheduled_jobs');
    if (err) setError(err.message);
    else { setError(''); setJobs(data || []); }
    setNow(new Date());
    setLoading(false);
  };

  useEffect(() => { if (isAdmin) load(); }, [isAdmin]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const rows = useMemo(() => jobs.map((j) => {
    const expr = j.cron_expression;
    const next = expr ? nextRun(expr, now) : null;
    return {
      ...j,
      next,
      scheduleText: expr ? describeCron(expr) : (j.external_schedule || '—'),
      lastRun: j.last_run_at ? new Date(j.last_run_at) : null,
      state: jobState(j),
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
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontFamily: serif, fontSize: 28, fontWeight: 500, color: '#0f172a', marginBottom: 8 }}>
            Scheduled Jobs
          </h1>
          <p style={{ fontSize: 14, color: '#64748b', maxWidth: 760, lineHeight: 1.6 }}>
            Everything Athena runs on a timer — what it does, where it gets its data,
            and when it next fires. Times are worked out from the schedule itself;
            the database clock is <strong>UTC</strong>, so a job set for 08:00 lands at
            09:00 London through the summer.
          </p>
        </div>
        <button
          onClick={load}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
            fontSize: 13, fontWeight: 600, fontFamily: font, color: '#0f172a',
            background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
            cursor: 'pointer', flexShrink: 0,
          }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Summary strip */}
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
          <h2 style={{
            fontFamily: serif, fontSize: 19, fontWeight: 500,
            color: '#0f172a', marginBottom: 2,
          }}>
            {category}
          </h2>
          <p style={{ fontSize: 12.5, color: '#94a3b8', marginBottom: 12 }}>
            {CATEGORY_BLURB[category] || ''}
          </p>

          <div style={{
            background: '#fff', border: '1px solid #e5e7eb',
            borderRadius: 12, overflow: 'hidden',
          }}>
            {catRows.map((job, i) => {
              const open = !!expanded[job.job_key];
              const Chevron = open ? ChevronDown : ChevronRight;
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
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>
                        {job.title}
                      </div>
                      <div style={{
                        fontSize: 11.5, color: '#94a3b8', fontFamily: 'ui-monospace, monospace',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {job.job_key}
                      </div>
                    </div>

                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: '#334155' }}>{job.scheduleText}</div>
                      {job.cron_expression && (
                        <div style={{ fontSize: 11.5, color: '#94a3b8', fontFamily: 'ui-monospace, monospace' }}>
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
                    <div style={{ padding: '4px 16px 18px 50px', background: '#f8fafc' }}>
                      <p style={{
                        fontSize: 13.5, color: '#0f172a', lineHeight: 1.6,
                        marginBottom: 16, maxWidth: 760,
                      }}>
                        {job.purpose || 'No description written yet.'}
                      </p>

                      <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                        gap: '0 32px', maxWidth: 900,
                      }}>
                        <Field icon={Database} label="Where the data comes from">
                          {job.data_source}
                        </Field>
                        <Field icon={Cpu} label="How it runs">
                          {job.mechanism}
                        </Field>
                        <Field icon={UserCheck} label="Runs as">
                          {job.run_as}
                        </Field>
                        <Field icon={Clock} label="Config switch">
                          {job.gate_label
                            ? (
                              <>
                                {/* A bare table.column reads as code; a sentence doesn't. */}
                                {/\s/.test(job.gate_label.trim())
                                  ? job.gate_label
                                  : (
                                    <code style={{
                                      fontFamily: 'ui-monospace, monospace', fontSize: 12,
                                      background: '#eef2f7', padding: '1px 5px', borderRadius: 4,
                                    }}>
                                      {job.gate_label}
                                    </code>
                                  )}
                                {job.gate_enabled === false && (
                                  <span style={{ color: '#92400e', marginLeft: 8, fontWeight: 600 }}>
                                    currently off — the job fires but does nothing
                                  </span>
                                )}
                              </>
                            )
                            : 'None — it always does its work when it fires.'}
                        </Field>
                      </div>

                      {(job.command || job.last_run_message) && (
                        <div style={{
                          borderTop: '1px solid #e2e8f0', paddingTop: 10, marginTop: 4,
                          fontSize: 11.5, color: '#94a3b8', fontFamily: 'ui-monospace, monospace',
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

      {!loading && !error && (
        <p style={{ fontSize: 12.5, color: '#94a3b8', lineHeight: 1.6, maxWidth: 760 }}>
          Descriptions live in <code style={{ fontFamily: 'ui-monospace, monospace' }}>scheduled_job_docs</code>;
          schedules, last-run outcomes and the on/off switches are read live from the
          database each time this page loads. A job scheduled outside Athena — one that
          needs a person to sign in first — is marked <em>Needs sign-in</em> and shows the
          date of the last successful run rather than a cron outcome.
        </p>
      )}
    </div>
  );
}
