import React, { useEffect, useMemo, useState } from 'react';
import { Mail, PhoneCall } from 'lucide-react';
import { tones } from '../../../lib/tokens';
import ChSubNav from '../components/ChSubNav';
import { CH_STAGES, COMMS_STEPS, stageMeta, commsOf, listChCodeStageRows, listChCodeActivitySince } from '../api';

const font = "'Outfit', sans-serif";
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 };
const WEEKS = 4;

// Monday (00:00 local) of the week containing d.
function mondayOf(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

// Short comms-column headers for the matrix.
const COMMS_HEAD = {
  not_started: 'No emails', one_email: '1', two_emails: '2', three_emails: '3', called: 'Called', escalated: 'Esc.',
};

export default function DashboardView() {
  const [rows, setRows] = useState(null);
  const [acts, setActs] = useState(null);
  const [error, setError] = useState(null);

  // 4 rolling Mon–Sun weeks, including the current week.
  const weeks = useMemo(() => {
    const curMon = mondayOf(new Date());
    const start = new Date(curMon); start.setDate(start.getDate() - 7 * (WEEKS - 1));
    return Array.from({ length: WEEKS }, (_, i) => {
      const from = new Date(start); from.setDate(from.getDate() + 7 * i);
      const to = new Date(from); to.setDate(to.getDate() + 7);
      return { from, to };
    });
  }, []);

  useEffect(() => {
    const sinceIso = weeks[0].from.toISOString();
    Promise.all([listChCodeStageRows(), listChCodeActivitySince(sinceIso)])
      .then(([r, a]) => { setRows(r); setActs(a); })
      .catch((e) => setError(e.message));
  }, [weeks]);

  // Stage × sub-stage matrix.
  const matrix = useMemo(() => {
    const m = {};
    for (const r of rows || []) {
      const st = r.stage || 's1_offer';
      m[st] ||= { total: 0, comms: {} };
      m[st].total += 1;
      const c = commsOf(r);
      m[st].comms[c] = (m[st].comms[c] || 0) + 1;
    }
    return m;
  }, [rows]);

  const commsTotals = useMemo(() => {
    const t = {};
    for (const g of CH_STAGES) {
      if (!g.chasing) continue;
      const c = matrix[g.value]?.comms || {};
      for (const s of COMMS_STEPS) t[s.value] = (t[s.value] || 0) + (c[s.value] || 0);
    }
    return t;
  }, [matrix]);

  const totals = useMemo(() => {
    const all = rows || [];
    const open = all.filter((r) => !['s6_submitted', 's7_rejected'].includes(r.stage)).length;
    return {
      people: all.length,
      open,
      submitted: all.filter((r) => r.stage === 's6_submitted').length,
      rejected: all.filter((r) => r.stage === 's7_rejected').length,
    };
  }, [rows]);

  // Weekly emails + calls.
  const weekly = useMemo(() => {
    const buckets = weeks.map((w) => ({ ...w, emails: 0, calls: 0 }));
    for (const a of acts || []) {
      const t = new Date(a.created_at).getTime();
      const i = buckets.findIndex((b) => t >= b.from.getTime() && t < b.to.getTime());
      if (i < 0) continue;
      if (a.kind === 'email_out') buckets[i].emails += 1;
      else if (a.kind === 'status_change' && /^call logged/i.test(a.body || '')) buckets[i].calls += 1;
    }
    return buckets;
  }, [acts, weeks]);

  const maxWeekly = Math.max(1, ...weekly.map((w) => Math.max(w.emails, w.calls)));
  const fmtWk = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  const th = { padding: '8px 10px', fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3, textAlign: 'center', borderBottom: '1px solid #e5e7eb' };
  const td = { padding: '8px 10px', fontSize: 13, color: '#0f172a', textAlign: 'center', borderBottom: '1px solid #f1f5f9' };

  return (
    <div style={{ padding: '24px 28px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>CH codes — dashboard</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>Where everyone is, and how much chasing is happening.</p>
        </div>
        <ChSubNav active="Dashboard" />
      </div>

      {error && <div style={{ color: tones.danger.fg, fontSize: 13, marginBottom: 12 }}>Failed: {error}</div>}
      {!rows && !error && <div style={{ color: '#64748b', fontSize: 13 }}>Loading…</div>}

      {rows && (
        <>
          {/* Headline totals */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 18 }}>
            {[
              ['In progress', totals.open, 'info'],
              ['Submitted', totals.submitted, 'success'],
              ['Rejected / exit', totals.rejected, 'danger'],
              ['Total people', totals.people, 'neutral'],
            ].map(([label, val, tone]) => (
              <div key={label} style={{ ...card, padding: '14px 16px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: (tones[tone] || tones.neutral).solid, marginTop: 4 }}>{val}</div>
              </div>
            ))}
          </div>

          {/* Stage × sub-stage matrix */}
          <div style={{ ...card, padding: 0, marginBottom: 18, overflowX: 'auto' }}>
            <div style={{ padding: '14px 16px', fontSize: 13, fontWeight: 700, color: '#0f172a', borderBottom: '1px solid #f1f5f9' }}>People by stage &amp; sub-stage</div>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 640 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: 'left' }}>Stage</th>
                  {COMMS_STEPS.map((c) => <th key={c.value} style={th}>{COMMS_HEAD[c.value]}</th>)}
                  <th style={{ ...th, background: '#f8fafc' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {CH_STAGES.map((g) => {
                  const row = matrix[g.value] || { total: 0, comms: {} };
                  const t = tones[g.tone] || tones.neutral;
                  return (
                    <tr key={g.value}>
                      <td style={{ ...td, textAlign: 'left' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ width: 8, height: 8, borderRadius: 999, background: t.solid }} />
                          <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700 }}>{g.short}</span>
                          <span style={{ fontWeight: 600 }}>{g.label}</span>
                        </span>
                      </td>
                      {COMMS_STEPS.map((c) => (
                        <td key={c.value} style={td}>
                          {g.chasing ? (row.comms[c.value] ? <span style={{ fontWeight: 600 }}>{row.comms[c.value]}</span> : <span style={{ color: '#cbd5e1' }}>0</span>) : <span style={{ color: '#e2e8f0' }}>—</span>}
                        </td>
                      ))}
                      <td style={{ ...td, background: '#f8fafc', fontWeight: 800 }}>{row.total}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td style={{ ...td, textAlign: 'left', fontWeight: 700, color: '#475569' }}>Chasing totals</td>
                  {COMMS_STEPS.map((c) => <td key={c.value} style={{ ...td, fontWeight: 700 }}>{commsTotals[c.value] || 0}</td>)}
                  <td style={{ ...td, background: '#f8fafc' }} />
                </tr>
              </tbody>
            </table>
            <div style={{ padding: '8px 16px 14px', fontSize: 11.5, color: '#94a3b8' }}>
              Sub-stage (emails 1/2/3 → called → escalated) applies to the chasing stages; the others show a total only.
            </div>
          </div>

          {/* Rolling 4-week emails & calls */}
          <div style={{ ...card }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>Emails &amp; calls — last 4 weeks</div>
              <div style={{ display: 'flex', gap: 14, fontSize: 12, color: '#64748b' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: tones.info.solid }} /> Emails</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: tones.accent.solid }} /> Calls</span>
              </div>
            </div>
            <div style={{ fontSize: 11.5, color: '#94a3b8', marginBottom: 16 }}>Weeks run Monday–Sunday (chasing happens Mon–Fri). Counts are activity recorded in Athena.</div>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${WEEKS}, 1fr)`, gap: 14, alignItems: 'end' }}>
              {weekly.map((w, i) => {
                const isCurrent = i === weekly.length - 1;
                return (
                  <div key={i} style={{ textAlign: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 8, height: 130 }}>
                      <div title={`${w.emails} emails`} style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center' }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: tones.info.fg }}>{w.emails}</span>
                        <div style={{ width: 26, height: `${Math.round((w.emails / maxWeekly) * 104)}px`, background: tones.info.solid, borderRadius: '4px 4px 0 0', minHeight: w.emails ? 3 : 0 }} />
                      </div>
                      <div title={`${w.calls} calls`} style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center' }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: tones.accent.fg }}>{w.calls}</span>
                        <div style={{ width: 26, height: `${Math.round((w.calls / maxWeekly) * 104)}px`, background: tones.accent.solid, borderRadius: '4px 4px 0 0', minHeight: w.calls ? 3 : 0 }} />
                      </div>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 12, fontWeight: isCurrent ? 700 : 500, color: isCurrent ? '#0f172a' : '#64748b' }}>
                      w/c {fmtWk(w.from)}{isCurrent ? ' (now)' : ''}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 20, marginTop: 16, paddingTop: 14, borderTop: '1px solid #f1f5f9', fontSize: 13, color: '#475569' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Mail size={14} /> {weekly.reduce((s, w) => s + w.emails, 0)} emails in 4 weeks</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><PhoneCall size={14} /> {weekly.reduce((s, w) => s + w.calls, 0)} calls in 4 weeks</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
