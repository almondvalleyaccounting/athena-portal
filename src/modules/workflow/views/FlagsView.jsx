import React, { useEffect, useState, useMemo } from 'react';
import { AlertTriangle, Check, X, Clock } from 'lucide-react';
import { listFlags, resolveFlag, logHoursAndResolveFlag, listStaffProfiles } from '../lib/workflowQueries';
import { useAuth } from '../../../shell/AppShell';

const font = "'Outfit', sans-serif";

const FLAG_META = {
  no_rule_match: {
    label: 'No rule match',
    tone: 'amber',
    help: 'Task name has no matching scheduling rule. Add a rule on the Scheduling rules tab, then re-import.',
  },
  entity_not_found: {
    label: 'Entity not found',
    tone: 'red',
    help: 'Client exists in BrightManager but not in Athena. Run a BM Clients import first, then re-run this tasks import.',
  },
  completed_no_time: {
    label: 'Completed — no time logged',
    tone: 'amber',
    help: 'Task was completed in BM but no timesheet entries were linked. Either log the hours retroactively or confirm and dismiss.',
  },
  completed_under_expected: {
    label: 'Completed — under expected',
    tone: 'amber',
    help: 'Logged time is more than 1 hour less than planned. Double-check whether some time is missing.',
  },
  deadline_moved: {
    label: 'Deadline moved (manual override)',
    tone: 'slate',
    help: 'BM deadline changed after you manually moved this planned block. Decide whether to keep the override or apply the new deadline.',
  },
  cancelled_in_bm: {
    label: 'Cancelled in BM',
    tone: 'slate',
    help: 'Task was cancelled rather than completed.',
  },
};

export default function FlagsView() {
  const { profile } = useAuth();
  const [flags, setFlags] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [resolvingId, setResolvingId] = useState(null);
  const [loggingId, setLoggingId] = useState(null);
  const [notes, setNotes] = useState('');

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const [f, s] = await Promise.all([
        listFlags({ resolved: false }),
        listStaffProfiles(),
      ]);
      setFlags(f);
      setStaff(s.filter((x) => x.is_active));
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const filtered = useMemo(() => {
    if (filter === 'all') return flags;
    return flags.filter((f) => f.flag_type === filter);
  }, [flags, filter]);

  const counts = useMemo(() => {
    const c = {};
    for (const f of flags) c[f.flag_type] = (c[f.flag_type] || 0) + 1;
    return c;
  }, [flags]);

  const resolve = async (flag) => {
    setResolvingId(null);
    setError(null);
    try {
      await resolveFlag(flag.id, notes.trim() || null);
      setFlags((prev) => prev.filter((f) => f.id !== flag.id));
      setNotes('');
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  const logHours = async (flag, { staffId, workDate, hours, logNotes }) => {
    setError(null);
    try {
      const minutes = Math.round(parseFloat(hours) * 60);
      if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('Enter a positive number of hours');
      if (!staffId) throw new Error('Pick a staff member');
      if (!workDate) throw new Error('Pick a work date');
      await logHoursAndResolveFlag({
        bmTaskId: flag.bm_task_id,
        staffId,
        workDate,
        minutes,
        service: flag.details?.service,
        entityId: flag.details?.entity_id,
        notes: logNotes,
        flagId: flag.id,
      });
      setFlags((prev) => prev.filter((f) => f.id !== flag.id));
      setLoggingId(null);
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  return (
    <div style={{ padding: '20px 28px', fontFamily: font }}>
      <p style={{ fontSize: 13, color: '#475569', maxWidth: 760, marginBottom: 14 }}>
        Issues surfaced by the last few BM Tasks imports that need human judgement. Resolve one by acting on it (add a rule, map an alias, log missing time, etc.) then dismissing here.
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label={`All (${flags.length})`} tone="slate" />
        {Object.entries(FLAG_META).map(([key, meta]) => {
          const n = counts[key] || 0;
          if (n === 0) return null;
          return (
            <FilterChip
              key={key}
              active={filter === key}
              onClick={() => setFilter(key)}
              label={`${meta.label} (${n})`}
              tone={meta.tone}
            />
          );
        })}
      </div>

      {error && (
        <div style={banner('red')}>
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8' }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 10, padding: 20, textAlign: 'center' }}>
          <Check size={20} style={{ color: '#15803d', marginBottom: 6 }} />
          <p style={{ fontSize: 13, color: '#065f46', fontWeight: 500 }}>
            {filter === 'all' ? 'No open flags. Clean deck.' : `No open "${FLAG_META[filter]?.label}" flags.`}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map((flag) => {
            const meta = FLAG_META[flag.flag_type] || { label: flag.flag_type, tone: 'slate', help: '' };
            const isResolving = resolvingId === flag.id;
            return (
              <div key={flag.id} style={card(meta.tone)}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 6 }}>
                  <span style={pill(meta.tone)}>{meta.label}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>
                      {flag.details?.bm_task_name || flag.details?.client_name || 'Task ' + flag.bm_task_id}
                    </div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                      Raised {fmtDate(flag.raised_at)} · BM task <code style={{ fontSize: 11 }}>{flag.bm_task_id}</code>
                    </div>
                  </div>
                </div>

                <DetailBlock details={flag.details} flagType={flag.flag_type} />

                <p style={{ fontSize: 12, color: '#475569', marginTop: 8, fontStyle: 'italic' }}>{meta.help}</p>

                {loggingId === flag.id ? (
                  <LogHoursPanel
                    flag={flag}
                    staff={staff}
                    defaultStaffId={resolveDefaultStaffId(flag, staff, profile)}
                    onSubmit={(payload) => logHours(flag, payload)}
                    onCancel={() => setLoggingId(null)}
                  />
                ) : isResolving ? (
                  <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center' }}>
                    <input
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Resolution notes (optional) — e.g. 'added rule', 'confirmed 0h'"
                      style={{ flex: 1, padding: '6px 8px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 12, fontFamily: font }}
                      autoFocus
                    />
                    <button onClick={() => resolve(flag)} style={btnPrimary}>
                      <Check size={12} /> Dismiss
                    </button>
                    <button onClick={() => { setResolvingId(null); setNotes(''); }} style={btnGhost}>
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                    {canLogHours(flag.flag_type) && (
                      <button onClick={() => setLoggingId(flag.id)} style={btnPrimary}>
                        <Clock size={12} /> Log hours
                      </button>
                    )}
                    <button
                      onClick={() => { setResolvingId(flag.id); setNotes(''); }}
                      style={btnSecondary}
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function canLogHours(flagType) {
  return flagType === 'completed_no_time' || flagType === 'completed_under_expected';
}

function resolveDefaultStaffId(flag, staff, profile) {
  // Prefer the currently signed-in user. Fall back to the first active
  // staffer that matches the flag's assignee text.
  if (profile?.id && staff.some((s) => s.id === profile.id)) return profile.id;
  const hint = (flag.details?.assignee || '').toLowerCase();
  const match = staff.find((s) => hint && s.name && hint.includes(s.name.toLowerCase().split(' ')[0]));
  return match?.id || staff[0]?.id || '';
}

function LogHoursPanel({ flag, staff, defaultStaffId, onSubmit, onCancel }) {
  const expected = flag.details?.expected_hours || 1;
  const actual = flag.details?.actual_hours || 0;
  const defaultHours = flag.flag_type === 'completed_under_expected'
    ? Math.max(0.25, Number(expected) - Number(actual))
    : Number(expected);
  const defaultDate = flag.details?.scheduled_for_date
    || new Date().toISOString().slice(0, 10);
  const [staffId, setStaffId] = useState(defaultStaffId || '');
  const [workDate, setWorkDate] = useState(defaultDate);
  const [hours, setHours] = useState(defaultHours.toFixed(2));
  const [logNotes, setLogNotes] = useState('');
  return (
    <div style={{ marginTop: 10, padding: 10, background: '#fff', border: '1px solid #cbd5e1', borderRadius: 8 }}>
      <p style={{ fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
        Log retroactive time
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
        <label style={fieldLabel}>
          <span>Staff</span>
          <select value={staffId} onChange={(e) => setStaffId(e.target.value)} style={fieldInp}>
            <option value="">— pick —</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label style={fieldLabel}>
          <span>Work date</span>
          <input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} style={fieldInp} />
        </label>
        <label style={fieldLabel}>
          <span>Hours</span>
          <input type="number" step="0.25" min="0.25" value={hours} onChange={(e) => setHours(e.target.value)} style={fieldInp} />
        </label>
      </div>
      <input
        value={logNotes}
        onChange={(e) => setLogNotes(e.target.value)}
        placeholder="Notes (optional) — what was actually done"
        style={{ width: '100%', padding: '6px 8px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 12, fontFamily: font, marginBottom: 8 }}
      />
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={() => onSubmit({ staffId, workDate, hours, logNotes })} style={btnPrimary}>
          <Clock size={12} /> Log {hours}h & dismiss flag
        </button>
        <button onClick={onCancel} style={btnGhost}>
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

const fieldLabel = { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 10, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' };
const fieldInp = { padding: '5px 7px', border: '1px solid #cbd5e1', borderRadius: 4, fontSize: 12, fontFamily: font, background: '#fff' };

function DetailBlock({ details, flagType }) {
  if (!details || Object.keys(details).length === 0) return null;
  const order = [
    'bm_task_name', 'client_name', 'client_reference',
    'expected_hours', 'actual_hours', 'shortfall_hours',
    'scheduled_for_date', 'old_deadline', 'new_deadline',
    'assignee', 'service', 'prior_state',
  ];
  const keys = Object.keys(details).sort((a, b) => {
    const ai = order.indexOf(a); const bi = order.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 4, fontSize: 12, marginTop: 6 }}>
      {keys.map((k) => {
        const v = details[k];
        if (v == null || v === '') return null;
        return (
          <div key={k} style={{ display: 'flex', gap: 6 }}>
            <span style={{ color: '#94a3b8', width: 120, flexShrink: 0 }}>{k.replace(/_/g, ' ')}</span>
            <span style={{ color: '#1e293b', fontFamily: typeof v === 'number' ? 'monospace' : 'inherit' }}>
              {String(v)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function FilterChip({ active, onClick, label, tone }) {
  const tones = {
    slate: active ? { bg: '#0f172a', color: '#fff' } : { bg: '#f1f5f9', color: '#475569' },
    amber: active ? { bg: '#d97706', color: '#fff' } : { bg: '#fef3c7', color: '#92400e' },
    red:   active ? { bg: '#991b1b', color: '#fff' } : { bg: '#fee2e2', color: '#991b1b' },
  };
  const t = tones[tone] || tones.slate;
  return (
    <button onClick={onClick} style={{
      fontSize: 11, fontWeight: 500, padding: '4px 10px', borderRadius: 999,
      border: 'none', cursor: 'pointer', fontFamily: font,
      background: t.bg, color: t.color,
    }}>{label}</button>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function card(tone) {
  const tones = {
    slate: { bg: '#fff',    border: '#e5e7eb' },
    amber: { bg: '#fffbeb', border: '#fcd34d' },
    red:   { bg: '#fff1f2', border: '#fca5a5' },
  };
  const t = tones[tone] || tones.slate;
  return { padding: 14, borderRadius: 10, background: t.bg, border: `1px solid ${t.border}` };
}
function pill(tone) {
  const tones = {
    slate: { bg: '#f1f5f9', color: '#475569' },
    amber: { bg: '#fef3c7', color: '#92400e' },
    red:   { bg: '#fee2e2', color: '#991b1b' },
  };
  const t = tones[tone] || tones.slate;
  return { fontSize: 10, padding: '3px 8px', borderRadius: 4, background: t.bg, color: t.color, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0 };
}
function banner(tone) {
  const tones = { red: { bg: '#fee2e2', border: '#fca5a5', color: '#991b1b' } };
  const t = tones[tone] || tones.red;
  return { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 8, background: t.bg, border: `1px solid ${t.border}`, color: t.color, fontSize: 13, marginBottom: 14 };
}
const btnPrimary = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, padding: '6px 12px', background: '#0f172a', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontFamily: font };
const btnSecondary = { fontSize: 12, fontWeight: 500, padding: '6px 12px', background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, color: '#1e293b', cursor: 'pointer', fontFamily: font };
const btnGhost = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 10px', background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontFamily: font };
