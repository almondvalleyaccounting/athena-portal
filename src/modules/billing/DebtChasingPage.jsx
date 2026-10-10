import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import { BTN } from '../../lib/buttonStyles';
import { listMailboxes } from '../communications/api';
import BillingTabs from './BillingTabs';

const font = "'Outfit', sans-serif";

// Debt chasing (sql/371 + the debt-chase edge function). Replaces the
// stand-alone DCM app. Every client with an overdue invoice in the firm's
// QuickBooks, the stage DCM's rules suggest and why, and a send screen that
// shows the exact email before it goes. Nothing is sent without a person
// pressing Send on that screen.

const GRADES = ['A+', 'A', 'B', 'C', 'D', 'E', 'F'];
const STAGE_LABEL = { 1: 'Stage 1', 2: 'Stage 2', 3: 'Stage 3', 4: 'Stage 4', 5: 'Escalation' };
const TONE_LABEL = { A: 'Gentle', B: 'Factual', ESC: 'Manager' };
const STATUS_LABEL = { sent: 'No reply yet', contact: 'Got in touch', responded: 'Replied' };

const gbp = (n) => `£${(Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateGB = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

async function call(action, body = {}) {
  const { data, error } = await supabase.functions.invoke('debt-chase', { body: { action, ...body } });
  if (error) {
    let msg = error.message;
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch { /* keep */ }
    throw new Error(msg);
  }
  if (data && data.success === false && data.code !== 'needs_confirmation') throw new Error(data.error || 'Failed');
  return data;
}

const FILTERS = [
  { id: 'due', label: 'Due now', test: (r) => r.ready },
  { id: 'waiting', label: 'Not due yet', test: (r) => r.entity_id && !r.due && !r.paused },
  { id: 'paused', label: 'Paused', test: (r) => !!r.paused },
  { id: 'blocked', label: 'Can’t send', test: (r) => !r.ready && r.due !== false && !r.paused },
  { id: 'all', label: 'All overdue', test: () => true },
];

const pill = (bg, fg) => ({ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: bg, color: fg, whiteSpace: 'nowrap' });
const th = { textAlign: 'left', padding: '8px 10px', fontSize: 12, fontWeight: 700, color: '#64748b', borderBottom: '1px solid #e2e8f0', whiteSpace: 'nowrap' };
const td = { padding: '9px 10px', borderBottom: '1px solid #f1f5f9', fontSize: 13.5, verticalAlign: 'top' };

export default function DebtChasingPage() {
  const { profile } = useAuth();
  const allowed = !!(profile?.can_view_client_fees || profile?.can_approve_billing || profile?.is_portal_admin);
  const [view, setView] = useState('queue');
  const [rows, setRows] = useState(null);
  const [asAt, setAsAt] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('due');
  const [mailboxes, setMailboxes] = useState([]);
  const [sending, setSending] = useState(null);   // queue row
  const [pausing, setPausing] = useState(null);   // queue row
  const [history, setHistory] = useState(null);

  const load = async () => {
    setError('');
    setRows(null);
    try {
      const d = await call('queue');
      setRows(d.rows || []);
      setAsAt(d.as_at || '');
    } catch (e) { setError(e.message); setRows([]); }
  };
  const loadHistory = async () => {
    const { data, error: err } = await supabase.from('debt_chases')
      .select('id, entity_id, stage, tone, status, status_note, sent_at, amount, invoice_count, to_email, from_mailbox, subject, entity:entities(name)')
      .order('sent_at', { ascending: false }).limit(300);
    if (err) setError(err.message);
    setHistory(data || []);
  };

  useEffect(() => {
    if (!allowed) return;
    load();
    listMailboxes(profile).then((m) => setMailboxes((m || []).filter((x) => x.status === 'active'))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed]);
  useEffect(() => { if (view === 'history' && allowed) loadHistory(); }, [view, allowed]);

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, (rows || []).filter(f.test).length])), [rows]);
  const shown = useMemo(() => (rows || []).filter(FILTERS.find((f) => f.id === filter).test), [rows, filter]);
  const totalOverdue = useMemo(() => (rows || []).reduce((s, r) => s + (r.amount || 0), 0), [rows]);

  const setGrade = async (row, grade) => {
    try {
      await call('set_grade', { entity_id: row.entity_id, grade: grade || null });
      await load();
    } catch (e) { setError(e.message); }
  };
  const markReplied = async (chaseId, status) => {
    const note = window.prompt(status === 'sent' ? 'Undo: back to “no reply yet”. Note (optional):' : 'What did they say? (optional)') ;
    if (note === null) return;
    try {
      await call('mark', { chase_id: chaseId, status, note });
      if (view === 'history') await loadHistory(); else await load();
    } catch (e) { setError(e.message); }
  };
  const unpause = async (row) => {
    try { await call('unpause', { entity_id: row.entity_id }); await load(); } catch (e) { setError(e.message); }
  };

  if (!allowed) {
    return (
      <div style={{ padding: '20px 28px', fontFamily: font }}>
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a' }}>Debt chasing</h1>
        <p style={{ fontSize: 14, color: '#64748b' }}>Debt chasing needs fee or billing-approval access.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px 28px', fontFamily: font }}>
      <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
        Debt chasing
      </h1>
      <p style={{ fontSize: 14, color: '#64748b', maxWidth: 860, marginBottom: 14 }}>
        Overdue invoices from QuickBooks, live. Gentle tone for grades A+ to C, factual for D to F or no grade. A client moves
        up a stage after 7 days with no reply and nothing paid, and goes back to stage 1 when they get in touch or an invoice clears.
      </p>

      <BillingTabs active="debt" />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        {[['queue', 'Queue'], ['history', 'Sent']].map(([id, label]) => (
          <button key={id} onClick={() => setView(id)}
            style={{ ...(view === id ? BTN.primary.sm : BTN.secondary.sm), cursor: 'pointer' }}>{label}</button>
        ))}
        {view === 'queue' && rows && (
          <span style={{ fontSize: 13, color: '#64748b', marginLeft: 8 }}>
            {rows.length} customers owe {gbp(totalOverdue)} overdue{asAt ? ` at ${dateGB(asAt)}` : ''}
          </span>
        )}
        <button onClick={() => (view === 'queue' ? load() : loadHistory())} style={{ ...BTN.secondary.sm, cursor: 'pointer', marginLeft: 'auto' }}>Refresh</button>
      </div>

      {error && <div style={{ background: '#fef2f2', color: '#b91c1c', padding: '8px 12px', borderRadius: 8, fontSize: 13.5, marginBottom: 12 }}>{error}</div>}

      {view === 'queue' && (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            {FILTERS.map((f) => (
              <button key={f.id} onClick={() => setFilter(f.id)}
                style={{ ...(filter === f.id ? BTN.primary.sm : BTN.secondary.sm), cursor: 'pointer' }}>
                {f.label} {rows ? `(${counts[f.id]})` : ''}
              </button>
            ))}
          </div>
          {!rows ? (
            <p style={{ fontSize: 14, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Reading QuickBooks…</p>
          ) : shown.length === 0 ? (
            <p style={{ fontSize: 14, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Nothing here.</p>
          ) : (
            <div style={{ overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: 10 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead style={{ background: '#f8fafc' }}>
                  <tr>
                    <th style={th}>Client</th><th style={th}>Grade</th><th style={{ ...th, textAlign: 'right' }}>Overdue</th>
                    <th style={th}>Oldest</th><th style={th}>Last chase</th><th style={th}>Next</th><th style={th} />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.entity_id || r.qbo_customer_id}>
                      <td style={td}>
                        {r.entity_id
                          ? <Link to={`/clients/${r.entity_id}`} style={{ color: '#0f172a', fontWeight: 600, textDecoration: 'none' }}>{r.client_name}</Link>
                          : <span style={{ fontWeight: 600 }}>{r.client_name}</span>}
                        <div style={{ fontSize: 12, color: '#64748b' }}>{r.to || '—'}</div>
                      </td>
                      <td style={td}>
                        {r.entity_id ? (
                          <select value={r.grade || ''} onChange={(e) => setGrade(r, e.target.value)}
                            title={r.grade_overridden ? 'Set in Athena (BrightManager’s grade is ignored)' : 'From BrightManager'}
                            style={{ fontSize: 13, padding: '2px 4px', border: '1px solid #cbd5e1', borderRadius: 6, fontFamily: font, fontWeight: r.grade_overridden ? 700 : 400 }}>
                            <option value="">None</option>
                            {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
                          </select>
                        ) : '—'}
                        {r.tone && <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{TONE_LABEL[r.tone]}</div>}
                      </td>
                      <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <div style={{ fontWeight: 600 }}>{gbp(r.amount)}</div>
                        <div style={{ fontSize: 12, color: '#64748b' }}>{r.invoices.length} invoice{r.invoices.length === 1 ? '' : 's'}</div>
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        <div>{r.max_days_overdue} days</div>
                        <div style={{ fontSize: 12, color: '#64748b' }}>due {dateGB(r.oldest_due)}</div>
                      </td>
                      <td style={td}>
                        {r.last_chase ? (
                          <>
                            <div>{STAGE_LABEL[r.last_chase.stage]} · {dateGB(r.last_chase.sent_at)}</div>
                            <div style={{ fontSize: 12, color: r.last_chase.status === 'sent' ? '#64748b' : '#15803d' }}>
                              {STATUS_LABEL[r.last_chase.status]}
                              {r.last_chase.status === 'sent' && (
                                <button onClick={() => markReplied(r.last_chase.id, 'contact')} style={{ marginLeft: 6, border: 'none', background: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 12, padding: 0 }}>They got in touch</button>
                              )}
                            </div>
                          </>
                        ) : <span style={{ color: '#94a3b8' }}>Never chased</span>}
                      </td>
                      <td style={{ ...td, maxWidth: 280 }}>
                        {r.blocked ? <span style={pill('#fef3c7', '#92400e')}>{r.blocked}</span> : (
                          <>
                            <span style={r.due ? pill('#dbeafe', '#1e40af') : pill('#f1f5f9', '#475569')}>{STAGE_LABEL[r.suggested_stage]}</span>
                            <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>{r.reason}</div>
                          </>
                        )}
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                        {r.entity_id && r.to && !r.paused && (
                          <button onClick={() => setSending(r)} style={{ ...(r.due ? BTN.primary.sm : BTN.secondary.sm), cursor: 'pointer' }}>Preview & send</button>
                        )}
                        {r.entity_id && (r.paused
                          ? <button onClick={() => unpause(r)} style={{ ...BTN.secondary.sm, cursor: 'pointer', marginLeft: 6 }}>Resume</button>
                          : <button onClick={() => setPausing(r)} style={{ ...BTN.secondary.sm, cursor: 'pointer', marginLeft: 6 }}>Pause</button>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {view === 'history' && (
        !history ? <p style={{ fontSize: 14, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading…</p> : (
          <div style={{ overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: 10 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr><th style={th}>Sent</th><th style={th}>Client</th><th style={th}>Stage</th><th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={th}>To / from</th><th style={th}>Reply</th></tr>
              </thead>
              <tbody>
                {history.length === 0 && <tr><td style={td} colSpan={6}>No chasers sent from Athena yet.</td></tr>}
                {history.map((h) => (
                  <tr key={h.id}>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{dateGB(h.sent_at)}</td>
                    <td style={td}><Link to={`/clients/${h.entity_id}`} style={{ color: '#0f172a', textDecoration: 'none', fontWeight: 600 }}>{h.entity?.name}</Link><div style={{ fontSize: 12, color: '#64748b' }}>{h.subject}</div></td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{STAGE_LABEL[h.stage]} · {TONE_LABEL[h.tone]}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{gbp(h.amount)}<div style={{ fontSize: 12, color: '#64748b' }}>{h.invoice_count} inv.</div></td>
                    <td style={{ ...td, fontSize: 12.5 }}>{h.to_email}<div style={{ color: '#64748b' }}>from {h.from_mailbox}</div></td>
                    <td style={td}>
                      <div style={{ fontSize: 13 }}>{STATUS_LABEL[h.status]}</div>
                      {h.status_note && <div style={{ fontSize: 12, color: '#64748b' }}>{h.status_note}</div>}
                      {h.status === 'sent'
                        ? <button onClick={() => markReplied(h.id, 'contact')} style={{ border: 'none', background: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 12, padding: 0 }}>They got in touch</button>
                        : <button onClick={() => markReplied(h.id, 'sent')} style={{ border: 'none', background: 'none', color: '#64748b', cursor: 'pointer', fontSize: 12, padding: 0 }}>Undo</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {sending && (
        <SendModal row={sending} mailboxes={mailboxes} profile={profile}
          onClose={() => setSending(null)} onSent={() => { setSending(null); load(); }} />
      )}
      {pausing && (
        <PauseModal row={pausing} onClose={() => setPausing(null)} onSaved={() => { setPausing(null); load(); }} />
      )}
    </div>
  );
}

// ── Send ──────────────────────────────────────────────────────────────────
// Closes only on Close / Cancel: no backdrop click, no Escape, so an edited
// email is never lost by a stray click.
function SendModal({ row, mailboxes, profile, onClose, onSent }) {
  const own = mailboxes.find((m) => m.kind === 'personal' && m.owner_staff_id === profile?.id);
  const defaultBox = (stage) => (stage >= 5 && own ? own.account_email
    : (mailboxes.find((m) => /^info@/i.test(m.account_email)) || mailboxes.find((m) => m.is_practice_default) || mailboxes[0])?.account_email || '');
  const [stage, setStage] = useState(row.suggested_stage);
  const [mailbox, setMailbox] = useState(defaultBox(row.suggested_stage));
  const [draft, setDraft] = useState(null);
  const [to, setTo] = useState(row.to);
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [warnings, setWarnings] = useState(null);
  const [edited, setEdited] = useState(false);
  const editorRef = useRef(null);

  const preview = async (s, mb) => {
    if (!mb) { setErr('No connected mailbox to send from. Connect one in Communications.'); return; }
    setBusy(true); setErr('');
    try {
      const d = await call('preview', { entity_id: row.entity_id, stage: s, mailbox: mb });
      setDraft(d); setSubject(d.subject); setEdited(false);
      if (editorRef.current) editorRef.current.innerHTML = d.body_html;
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { preview(stage, mailbox); }, []);
  useEffect(() => { if (draft && editorRef.current && !edited) editorRef.current.innerHTML = draft.body_html; }, [draft, edited]);

  const changeStage = (s) => {
    if (edited && !window.confirm('Switching stage replaces your edits with that stage’s template. Carry on?')) return;
    const mb = s >= 5 && own ? own.account_email : mailbox;
    setStage(s); setMailbox(mb); preview(s, mb);
  };
  const changeMailbox = (mb) => {
    if (edited && !window.confirm('Changing mailbox reloads the email with that mailbox’s signature, replacing your edits. Carry on?')) return;
    setMailbox(mb); preview(stage, mb);
  };

  const send = async (acknowledged = false) => {
    setBusy(true); setErr('');
    try {
      const d = await call('send', {
        entity_id: row.entity_id, stage, mailbox, to: to.trim(), subject: subject.trim(),
        body_html: editorRef.current?.innerHTML || '', acknowledged,
      });
      if (d?.code === 'needs_confirmation') { setWarnings(d.warnings || [d.error]); return; }
      onSent();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const label = { fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 3 };
  const input = { width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 14, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 7 };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, fontFamily: font }}>
      <div style={{ width: 860, maxWidth: '94vw', maxHeight: 'calc(100vh - 40px)', overflowY: 'auto', background: '#fff', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>Chase {row.client_name}</div>
            <div style={{ fontSize: 12.5, color: '#64748b' }}>{gbp(row.amount)} overdue on {row.invoices.length} invoice(s) · suggested {STAGE_LABEL[row.suggested_stage]}: {row.reason}</div>
          </div>
          <button onClick={onClose} title="Close" style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: '#64748b' }}><X size={18} /></button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr', gap: 10 }}>
          <div>
            <span style={label}>Stage</span>
            <select value={stage} onChange={(e) => changeStage(Number(e.target.value))} disabled={busy} style={input}>
              {[1, 2, 3, 4, 5].map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}{s === row.suggested_stage ? ' (suggested)' : ''}</option>)}
            </select>
          </div>
          <div>
            <span style={label}>From</span>
            <select value={mailbox} onChange={(e) => changeMailbox(e.target.value)} disabled={busy} style={input}>
              {mailboxes.map((m) => <option key={m.account_email} value={m.account_email}>{m.account_email}</option>)}
            </select>
          </div>
          <div>
            <span style={label}>To</span>
            <input value={to} onChange={(e) => setTo(e.target.value)} style={input} />
          </div>
        </div>
        <div>
          <span style={label}>Subject</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} style={input} />
        </div>
        <div>
          <span style={label}>
            Email {draft && `· ${TONE_LABEL[draft.tone]} tone`}{draft && !draft.signature_found && ' · no signature set for this mailbox (Communications → Signatures)'}
          </span>
          <div ref={editorRef} contentEditable={!busy} suppressContentEditableWarning onInput={() => setEdited(true)}
            style={{ minHeight: 260, maxHeight: 440, overflowY: 'auto', padding: '12px 14px', border: '1px solid #cbd5e1', borderRadius: 7, fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 14, color: '#111', outline: 'none', opacity: busy && !draft ? 0.5 : 1 }} />
        </div>

        {warnings && (
          <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: 10, fontSize: 13.5, color: '#92400e' }}>
            {warnings.map((w, i) => <div key={i}>{w}</div>)}
            <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
              <button onClick={() => { setWarnings(null); send(true); }} style={{ ...BTN.primary.sm, cursor: 'pointer' }}>Send anyway</button>
              <button onClick={() => setWarnings(null)} style={{ ...BTN.secondary.sm, cursor: 'pointer' }}>Back</button>
            </div>
          </div>
        )}
        {err && <div style={{ background: '#fef2f2', color: '#b91c1c', padding: '8px 12px', borderRadius: 8, fontSize: 13.5 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ ...BTN.secondary.md, cursor: 'pointer' }}>Close</button>
          <button onClick={() => send(false)} disabled={busy || !draft || !to.trim() || !subject.trim()} style={{ ...BTN.primary.md, cursor: 'pointer' }}>
            {busy ? 'Working…' : `Send from ${mailbox.split('@')[0]}@`}
          </button>
        </div>
      </div>
    </div>
  );
}

function PauseModal({ row, onClose, onSaved }) {
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const [until, setUntil] = useState(in30);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    setBusy(true); setErr('');
    try { await call('pause', { entity_id: row.entity_id, until, reason }); onSaved(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const input = { width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 14, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 7 };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, fontFamily: font }}>
      <div style={{ width: 440, maxWidth: '94vw', background: '#fff', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>Pause chasing {row.client_name}</div>
        <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b' }}>Until
          <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} style={{ ...input, marginTop: 3 }} />
        </label>
        <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b' }}>Why
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Paying £200 a month from November" style={{ ...input, marginTop: 3 }} />
        </label>
        {err && <div style={{ color: '#b91c1c', fontSize: 13 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ ...BTN.secondary.md, cursor: 'pointer' }}>Close</button>
          <button onClick={save} disabled={busy || !reason.trim() || !until} style={{ ...BTN.primary.md, cursor: 'pointer' }}>Pause</button>
        </div>
      </div>
    </div>
  );
}
