import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../shell/AppShell';
import { fetchOpenCycle, fetchCycleItems, fetchReasons, fetchNextActions, openCurrentCycle, sendNudges } from '../api';

const font = "'Outfit', sans-serif";

const CONF = { green: { l: 'On track', c: '#16a34a' }, amber: { l: 'At risk', c: '#b45309' }, red: { l: 'Will miss', c: '#b91c1c' } };
const MV = {
  new: { l: 'New', c: '#0e7fe0' }, advanced: { l: 'Advanced', c: '#16a34a' },
  unchanged: { l: 'No change', c: '#b45309' }, slipped: { l: 'Slipped', c: '#b91c1c' },
};

function monthLabel(iso) {
  if (!iso) return '';
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}
function isoToday() { return new Date().toISOString().slice(0, 10); }

export default function ManagerView() {
  const { profile } = useAuth();
  const [cycle, setCycle] = useState(null);
  const [items, setItems] = useState([]);
  const [reasons, setReasons] = useState([]);
  const [nextActions, setNextActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  const canOpen = profile?.can_manage_portal === true || profile?.is_portal_admin === true;

  async function load() {
    setLoading(true);
    try {
      const [c, r, na] = await Promise.all([fetchOpenCycle(), fetchReasons(), fetchNextActions()]);
      setCycle(c);
      setReasons(r);
      setNextActions(na);
      setItems(c ? await fetchCycleItems(c.id) : []);
      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function handleOpen() {
    setOpening(true);
    try {
      await openCurrentCycle();
      await load();
    } catch (e) {
      alert('Could not open cycle: ' + (e.message || e));
    } finally {
      setOpening(false);
    }
  }

  async function handleSend({ reminder }) {
    // Preview first so the manager sees who gets what before anything goes out.
    let plan;
    try {
      plan = await sendNudges({ dryRun: true, reminder });
    } catch (e) {
      alert('Could not build the send preview: ' + (e.message || e));
      return;
    }
    const n = plan?.recipients ?? (plan?.plan ? plan.plan.length : 0);
    const verb = reminder ? 'chase reminders to non-responders' : 'nudge emails';
    if (!n) { alert('No recipients to email right now.'); return; }
    if (!confirm(`Send ${verb} to ${n} team member${n === 1 ? '' : 's'} now? This emails the team.`)) return;
    setSending(true);
    try {
      const res = await sendNudges({ dryRun: false, reminder });
      alert(`Sent ${res?.sent ?? 0} email${(res?.sent ?? 0) === 1 ? '' : 's'}.`);
    } catch (e) {
      alert('Send failed: ' + (e.message || e));
    } finally {
      setSending(false);
    }
  }

  async function handleTestToMe() {
    if (!profile?.email) { alert('No email on your profile.'); return; }
    if (!confirm(`Send a test nudge to ${profile.email} only? Nobody else is emailed.`)) return;
    setSending(true);
    try {
      const res = await sendNudges({ dryRun: false, testRecipient: profile.email });
      alert(`Test sent to ${profile.email} (${res?.sent ?? 0} email).`);
    } catch (e) {
      alert('Test failed: ' + (e.message || e));
    } finally {
      setSending(false);
    }
  }

  const reasonLabel = useMemo(() => Object.fromEntries(reasons.map((r) => [r.code, r.label])), [reasons]);
  const nextActionLabel = useMemo(() => Object.fromEntries(nextActions.map((a) => [a.code, a.label])), [nextActions]);

  const stats = useMemo(() => {
    const total = items.length;
    const answered = items.filter((i) => i.responded_at).length;
    const red = items.filter((i) => i.confidence === 'red').length;
    const needHelp = items.filter((i) => i.needs_help).length;
    const slipped = items.filter((i) => i.movement === 'slipped').length;
    const chaseReasonCodes = new Set(reasons.filter((r) => r.triggers_client_chase).map((r) => r.code));
    const clientBlocked = items.filter((i) => i.reason_code && chaseReasonCodes.has(i.reason_code)).length;
    return { total, answered, red, needHelp, slipped, clientBlocked };
  }, [items, reasons]);

  const byAssignee = useMemo(() => {
    const m = new Map();
    for (const i of items) {
      const key = i.assignee_id || 'unassigned';
      if (!m.has(key)) m.set(key, { name: i.assignee?.name || null, total: 0, answered: 0, red: 0, help: 0 });
      const g = m.get(key);
      if (!g.name && i.assignee?.name) g.name = i.assignee.name;
      g.total += 1;
      if (i.responded_at) g.answered += 1;
      if (i.confidence === 'red') g.red += 1;
      if (i.needs_help) g.help += 1;
    }
    // names not on item; label by assignee_id short — enrich via items’ client? We only have ids.
    return Array.from(m.entries()).map(([id, g]) => ({ id, ...g })).sort((a, b) => b.total - a.total);
  }, [items]);

  const byReason = useMemo(() => {
    const m = new Map();
    for (const i of items.filter((x) => x.reason_code)) {
      m.set(i.reason_code, (m.get(i.reason_code) || 0) + 1);
    }
    return Array.from(m.entries()).map(([code, n]) => ({ code, label: reasonLabel[code] || code, n }))
      .sort((a, b) => b.n - a.n);
  }, [items, reasonLabel]);

  function exportCsv() {
    const header = ['Client', 'Service', 'Period end', 'Days past', 'BM status', 'Box', 'Movement', 'Done by', 'Reason', 'Next action', 'Next action detail', 'Confidence', 'Needs help', 'Note', 'Answered'];
    const lines = [header.join(',')];
    const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    for (const i of items) {
      lines.push([
        q(i.client_name), i.service, i.period_end, i.days_past, q(i.bm_status_snapshot), i.box, i.movement,
        i.done_by || '', q(reasonLabel[i.reason_code] || ''),
        q(nextActionLabel[i.next_action_code] || ''), q(i.next_action_note || ''),
        i.confidence || '', i.needs_help ? 'yes' : '',
        q(i.note || ''), i.responded_at ? 'yes' : 'no',
      ].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `job-review-${cycle ? cycle.period_month : isoToday()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <Msg>Loading…</Msg>;
  if (error) return <Msg colour="#dc2626">Error: {error}</Msg>;

  return (
    <div style={{ fontFamily: font, padding: '18px 22px 48px', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 19, fontWeight: 600, color: '#0f172a' }}>
          Job Review{cycle ? ` — ${monthLabel(cycle.period_month)}` : ''}
        </h2>
        <div style={{ flex: 1 }} />
        {items.length > 0 && (
          <button onClick={exportCsv} style={btnSecondary}>Export CSV</button>
        )}
        {canOpen && cycle && items.length > 0 && (
          <>
            <button onClick={handleTestToMe} disabled={sending} style={btnSecondary}>
              {sending ? 'Sending…' : 'Send test to me'}
            </button>
            <button onClick={() => handleSend({ reminder: false })} disabled={sending} style={btnSecondary}>
              Send nudges
            </button>
            <button onClick={() => handleSend({ reminder: true })} disabled={sending} style={btnSecondary}>
              Chase non-responders
            </button>
          </>
        )}
        {canOpen && (
          <button onClick={handleOpen} disabled={opening} style={btnPrimary}>
            {opening ? 'Opening…' : cycle ? 'Refresh cohort' : 'Open this month’s cycle'}
          </button>
        )}
      </div>

      {!cycle ? (
        <Msg>No open cycle. {canOpen ? 'Open one to snapshot this month’s stalled jobs.' : 'Ask an admin to open the monthly cycle.'}</Msg>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
            <Stat label="Jobs" value={stats.total} />
            <Stat label="Answered" value={`${stats.answered}/${stats.total}`} colour={stats.answered === stats.total ? '#16a34a' : '#0e7fe0'} />
            <Stat label="Will miss" value={stats.red} colour={stats.red ? '#b91c1c' : '#64748b'} />
            <Stat label="Slipped since last" value={stats.slipped} colour={stats.slipped ? '#b91c1c' : '#64748b'} />
            <Stat label="Need help" value={stats.needHelp} colour={stats.needHelp ? '#b45309' : '#64748b'} />
            <Stat label="Client-blocked" value={stats.clientBlocked} colour="#0e7fe0" />
          </div>

          <Section title="Response progress by person">
            <table style={table}>
              <thead><tr>{['Assignee', 'Answered', 'Will miss', 'Need help'].map((h) => <Th key={h}>{h}</Th>)}</tr></thead>
              <tbody>
                {byAssignee.map((g) => (
                  <tr key={g.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={td}>{g.id === 'unassigned' ? 'Unassigned' : (g.name || shortId(g.id))}</td>
                    <td style={td}>
                      <ProgressBar done={g.answered} total={g.total} />
                    </td>
                    <td style={{ ...td, color: g.red ? '#b91c1c' : '#94a3b8', fontWeight: g.red ? 600 : 400 }}>{g.red || '—'}</td>
                    <td style={{ ...td, color: g.help ? '#b45309' : '#94a3b8', fontWeight: g.help ? 600 : 400 }}>{g.help || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          {byReason.length > 0 && (
            <Section title="Blockers (answered so far)">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {byReason.map((r) => (
                  <div key={r.code} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                    <span style={{ minWidth: 260, color: '#475569' }}>{r.label}</span>
                    <div style={{ flex: 1, height: 8, background: '#f1f5f9', borderRadius: 999, overflow: 'hidden' }}>
                      <div style={{ width: `${(r.n / stats.total) * 100}%`, height: '100%', background: '#0e7fe0' }} />
                    </div>
                    <span style={{ width: 28, textAlign: 'right', color: '#0f172a', fontWeight: 600 }}>{r.n}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          <Section title="All jobs">
            <table style={table}>
              <thead><tr>{['Client', 'Svc', 'Days past', 'BM status', 'Movement', 'Done by', 'Reason', 'Next action', 'Conf.', ''].map((h) => <Th key={h}>{h}</Th>)}</tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} style={{ borderTop: '1px solid #f1f5f9', background: i.responded_at ? 'transparent' : '#fffdf5' }}>
                    <td style={td}>{i.client_name}{i.needs_help && <span title="Needs help"> 🙋</span>}</td>
                    <td style={{ ...td, color: '#64748b' }}>{i.service === 'Self Assessment' ? 'SA' : 'Acc'}</td>
                    <td style={{ ...td, color: i.days_past > 365 ? '#dc2626' : '#475569' }}>{i.days_past}</td>
                    <td style={{ ...td, color: '#475569' }}>{i.bm_status_snapshot}</td>
                    <td style={td}>{MV[i.movement] && <span style={{ color: MV[i.movement].c, fontWeight: 600 }}>{MV[i.movement].l}</span>}</td>
                    <td style={td}>{i.done_by || <span style={{ color: '#cbd5e1' }}>—</span>}</td>
                    <td style={{ ...td, color: '#475569' }}>{reasonLabel[i.reason_code] || <span style={{ color: '#cbd5e1' }}>—</span>}</td>
                    <td style={{ ...td, color: '#475569' }} title={i.next_action_note || ''}>
                      {nextActionLabel[i.next_action_code] || <span style={{ color: '#cbd5e1' }}>—</span>}
                      {i.next_action_note && <span style={{ color: '#94a3b8' }}> ·</span>}
                    </td>
                    <td style={td}>{i.confidence ? <span style={{ color: CONF[i.confidence].c, fontWeight: 600 }}>{CONF[i.confidence].l}</span> : <span style={{ color: '#cbd5e1' }}>—</span>}</td>
                    <td style={{ ...td, color: i.responded_at ? '#16a34a' : '#cbd5e1' }}>{i.responded_at ? '✓' : '·'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </>
      )}
    </div>
  );
}

function shortId(id) { return id ? id.slice(0, 8) : ''; }

function ProgressBar({ done, total }) {
  const pct = total ? (done / total) * 100 : 0;
  const complete = done === total;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 120, height: 8, background: '#f1f5f9', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: complete ? '#16a34a' : '#0e7fe0' }} />
      </div>
      <span style={{ fontSize: 12, color: complete ? '#16a34a' : '#64748b', fontWeight: 600 }}>{done}/{total}</span>
    </div>
  );
}

function Stat({ label, value, colour = '#0f172a' }) {
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 16px', minWidth: 110, background: '#fff' }}>
      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: colour }}>{value}</div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', margin: '0 0 8px' }}>{title}</h3>
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, background: '#fff' }}>{children}</div>
    </div>
  );
}

const table = { width: '100%', borderCollapse: 'collapse', fontSize: 12 };
const td = { padding: '7px 10px', verticalAlign: 'middle' };
function Th({ children }) {
  return <th style={{ padding: '6px 10px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: '1px solid #e5e7eb' }}>{children}</th>;
}
const btnPrimary = { fontSize: 12, fontWeight: 600, fontFamily: font, cursor: 'pointer', padding: '7px 14px', borderRadius: 8, border: '1px solid #0f172a', background: '#0f172a', color: '#fff' };
const btnSecondary = { fontSize: 12, fontWeight: 500, fontFamily: font, cursor: 'pointer', padding: '7px 14px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#475569' };

function Msg({ children, colour = '#64748b' }) {
  return <div style={{ padding: 28, fontFamily: font, color: colour, fontSize: 14, textAlign: 'center' }}>{children}</div>;
}
