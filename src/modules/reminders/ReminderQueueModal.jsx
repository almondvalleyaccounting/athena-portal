import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';

/*
  Reminder queue — the human review step, and the sent history.

  Queued: reminder_emails rows rendered + stored by reminders-send
  mode:'queue' but NOT sent. A manager reviews each, drops any, picks the
  sending mailbox, then releases — reminders-send mode:'release' sends the
  STORED body, so what was reviewed is exactly what goes out.

  Sent: the same table filtered to status='sent' — a per-client record of
  what has actually been emailed and when.

  Props: commType, entityById, profile, onClose, onChanged
*/

const font = "'Outfit', sans-serif";
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 };
const overlay = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 210,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
};
const btnGhost = {
  padding: '7px 14px', fontSize: 12.5, fontWeight: 600, fontFamily: font,
  background: '#fff', color: '#334155', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer',
};
const btnPrimary = (on) => ({
  padding: '8px 16px', fontSize: 12.5, fontWeight: 600, fontFamily: font,
  background: on ? '#0e7fe0' : '#e5e7eb', color: on ? '#fff' : '#94a3b8',
  border: 'none', borderRadius: 8, cursor: on ? 'pointer' : 'default',
});
const btnDanger = (on) => ({
  padding: '7px 14px', fontSize: 12.5, fontWeight: 600, fontFamily: font,
  background: '#fff', color: on ? '#b91c1c' : '#cbd5e1', border: `1px solid ${on ? '#fecaca' : '#e5e7eb'}`,
  borderRadius: 8, cursor: on ? 'pointer' : 'default',
});
const selStyle = {
  padding: '6px 10px', fontSize: 12.5, fontFamily: font, color: '#0f172a',
  background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer',
};
const th = {
  padding: '7px 10px', fontSize: 11, fontWeight: 600, color: '#64748b', textAlign: 'left',
  textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap',
};
const td = { padding: '6px 10px', fontSize: 12.5, color: '#1e293b', borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle' };

const KIND_META = {
  promo: { label: 'Opt-in invite', bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
  reminder: { label: 'Payment reminder', bg: '#f0fdf4', color: '#166534', border: '#bbf7d0' },
  no_utr: { label: 'Not registered (no UTR)', bg: '#fffbeb', color: '#92400e', border: '#fde68a' },
};

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export default function ReminderQueueModal({ commType = 'tax_reminders', entityById = {}, profile, onClose, onChanged }) {
  const [view, setView] = useState('queued'); // 'queued' | 'sent'
  const [rows, setRows] = useState([]);
  const [mailboxes, setMailboxes] = useState([]);
  const [mailbox, setMailbox] = useState(''); // account_email to send from
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [focusId, setFocusId] = useState(null);
  const canManage = profile?.can_manage_portal === true || profile?.is_portal_admin === true;

  // Sending mailboxes (staff-safe view — no tokens).
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('v_gmail_connections')
        .select('account_email, is_practice_default, status')
        .eq('status', 'active')
        .order('is_practice_default', { ascending: false });
      const list = data || [];
      setMailboxes(list);
      const def = list.find((m) => m.is_practice_default) || list[0];
      if (def) setMailbox((cur) => cur || def.account_email);
    })();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    let q = supabase
      .from('reminder_emails')
      .select('id, kind, entity_id, to_email, subject, body_html, queued_at, sent_at, status, clicked_at, clicked_link, clicked_choice, reply_seen_at, is_resend')
      .eq('comm_type', commType).eq('status', view);
    q = view === 'sent'
      ? q.order('sent_at', { ascending: false }).limit(1000)
      : q.order('queued_at', { ascending: true });
    const { data, error: e } = await q;
    if (e) { setError(`Could not load: ${e.message}`); setLoading(false); return; }
    setRows(data || []);
    setSelected(view === 'queued' ? new Set((data || []).map((r) => r.id)) : new Set());
    setFocusId((data && data[0] ? data[0].id : null));
    setLoading(false);
  }, [commType, view]);

  useEffect(() => { load(); }, [load]);

  const nameOf = (r) => (r.entity_id && entityById[r.entity_id]?.name) || '(unmatched)';
  const focus = useMemo(() => rows.find((r) => r.id === focusId) || null, [rows, focusId]);
  const isQueued = view === 'queued';

  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSel = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSel ? new Set() : new Set(rows.map((r) => r.id)));

  const drop = async () => {
    if (!canManage || !selected.size) return;
    if (!window.confirm(`Drop ${selected.size} queued email${selected.size === 1 ? '' : 's'}? They won't be sent.`)) return;
    setBusy(true); setError(null);
    const ids = [...selected];
    const { error: e } = await supabase.from('reminder_emails').update({ status: 'dropped' }).in('id', ids);
    setBusy(false);
    if (e) { setError(`Could not drop: ${e.message}`); return; }
    setNotice(`${ids.length} dropped.`);
    setSelected(new Set());
    load(); onChanged && onChanged();
  };

  const release = async () => {
    if (!canManage || !selected.size || !mailbox) return;
    if (!window.confirm(`Release ${selected.size} email${selected.size === 1 ? '' : 's'} from ${mailbox} now? They will be sent to clients.`)) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const { data, error: e } = await supabase.functions.invoke('reminders-send', {
        body: { mode: 'release', comm_type: commType, ids: [...selected], mailbox },
      });
      if (e) throw new Error(e.message || 'Release failed');
      if (data && data.success === false) throw new Error(data.error || 'Release failed');
      const bits = [`${data?.sent ?? 0} sent`];
      if (data?.skipped?.length) bits.push(`${data.skipped.length} skipped`);
      if (data?.errors?.length) bits.push(`${data.errors.length} failed`);
      setNotice(bits.join(', ') + `. Sent from ${mailbox}.`);
      setSelected(new Set());
      load(); onChanged && onChanged();
    } catch (ex) {
      setError(ex.message);
    } finally {
      setBusy(false);
    }
  };

  const tab = (key, label) => (
    <button
      onClick={() => setView(key)}
      style={{
        padding: '5px 14px', fontSize: 12.5, fontWeight: 600, fontFamily: font, borderRadius: 999, cursor: 'pointer',
        background: view === key ? '#eff6ff' : '#fff', color: view === key ? '#1d4ed8' : '#64748b',
        border: `1px solid ${view === key ? '#bfdbfe' : '#e5e7eb'}`,
      }}
    >{label}</button>
  );

  return (
    <div style={overlay}>
      <div style={{ ...card, width: 1080, maxWidth: '96vw', maxHeight: '92vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: 20, fontFamily: font }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Client Tax Reminders queue</div>
          {tab('queued', 'Queued')}
          {tab('sent', 'Sent')}
          <span style={{ fontSize: 12, color: '#64748b' }}>
            {rows.length} {view}{isQueued ? ` · ${selected.size} selected` : ''}
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, color: '#64748b', cursor: 'pointer', fontFamily: font }}>×</button>
        </div>

        {error && <div style={{ ...card, padding: '9px 12px', marginBottom: 10, background: '#fef2f2', borderColor: '#fecaca', color: '#b91c1c', fontSize: 12.5 }}>{error}</div>}
        {notice && <div style={{ ...card, padding: '9px 12px', marginBottom: 10, background: '#f0fdf4', borderColor: '#bbf7d0', color: '#166534', fontSize: 12.5 }}>{notice}</div>}
        {isQueued && !canManage && <div style={{ ...card, padding: '9px 12px', marginBottom: 10, background: '#f8fafc', color: '#475569', fontSize: 12 }}>Reviewing only — releasing is limited to portal managers.</div>}

        <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
          {/* list */}
          <div style={{ flex: '1 1 540px', minWidth: 340, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {isQueued && <th style={{ ...th, width: 28 }}><input type="checkbox" checked={allSel} onChange={toggleAll} /></th>}
                  <th style={th}>Client</th>
                  <th style={th}>Email</th>
                  <th style={th}>Kind</th>
                  <th style={th}>{isQueued ? 'Queued' : 'Sent'}</th>
                  {!isQueued && <th style={th}>Engagement</th>}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td style={td} colSpan={5}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td style={{ ...td, color: '#94a3b8' }} colSpan={5}>
                    {isQueued ? 'Nothing queued. Select clients on the reminders page and choose “Add to queue”.' : 'Nothing sent yet.'}
                  </td></tr>
                ) : rows.map((r) => (
                  <tr key={r.id} onClick={() => setFocusId(r.id)} style={{ cursor: 'pointer', background: r.id === focusId ? '#f8fbff' : 'transparent' }}>
                    {isQueued && (
                      <td style={td} onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                      </td>
                    )}
                    <td style={{ ...td, fontWeight: 600 }}>{nameOf(r)}</td>
                    <td style={{ ...td, color: '#334155' }}>{r.to_email}</td>
                    <td style={td}>{(() => {
                      const m = KIND_META[r.kind] || { label: r.kind, bg: '#f1f5f9', color: '#64748b', border: '#e2e8f0' };
                      return (
                        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span style={{
                            display: 'inline-block', fontSize: 10.5, fontWeight: 600, padding: '2px 8px',
                            borderRadius: 999, background: m.bg, color: m.color, border: `1px solid ${m.border}`, whiteSpace: 'nowrap',
                          }}>{m.label}</span>
                          {r.is_resend && (
                            <span
                              title="A deliberate extra copy — this client had already been emailed for this batch (or this was a test send to a staff mailbox)"
                              style={{
                                display: 'inline-block', fontSize: 10.5, fontWeight: 600, padding: '2px 8px',
                                borderRadius: 999, background: '#fffbeb', color: '#92400e',
                                border: '1px solid #fde68a', whiteSpace: 'nowrap',
                              }}
                            >again</span>
                          )}
                        </span>
                      );
                    })()}</td>
                    <td style={{ ...td, color: '#64748b' }}>{fmtWhen(isQueued ? r.queued_at : r.sent_at)}</td>
                    {!isQueued && (
                      <td style={td} title="A click or reply is the reliable 'engaged' signal — we don't track opens (unreliable across mail clients)">
                        {(() => {
                          const chip = (label, bg, color, border) => (
                            <span style={{
                              display: 'inline-block', fontSize: 10.5, fontWeight: 600, padding: '2px 8px',
                              borderRadius: 999, background: bg, color, border: `1px solid ${border}`, whiteSpace: 'nowrap',
                            }}>{label}</span>
                          );
                          if (r.reply_seen_at) return chip('Replied', '#f0fdf4', '#166534', '#bbf7d0');
                          if (r.clicked_at) {
                            const what = r.clicked_link === 'pay' ? 'Clicked · how to pay'
                              : r.clicked_link === 'pta' ? 'Clicked · view balance'
                              : r.clicked_choice ? `Clicked · opt-${r.clicked_choice}`
                              : 'Clicked';
                            return chip(what, '#eff6ff', '#1d4ed8', '#bfdbfe');
                          }
                          return <span style={{ fontSize: 11.5, color: '#cbd5e1' }}>—</span>;
                        })()}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* preview */}
          <div style={{ flex: '1 1 420px', minWidth: 300, overflowY: 'auto' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
              {isQueued ? 'Exactly what will send' : 'What was sent'}
            </div>
            {focus ? (
              <>
                <div style={{ fontSize: 12.5, color: '#334155', margin: '2px 0 8px' }}>
                  To <strong>{focus.to_email}</strong> · Subject: <strong>{focus.subject}</strong>
                </div>
                <div
                  style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '4px 10px', background: '#fff' }}
                  dangerouslySetInnerHTML={{ __html: focus.body_html || '<p style="color:#94a3b8">(body not stored for this row)</p>' }}
                />
              </>
            ) : <div style={{ fontSize: 12.5, color: '#94a3b8' }}>Select a row to preview.</div>}
          </div>
        </div>

        {isQueued && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
            <button onClick={drop} disabled={!canManage || !selected.size || busy} style={btnDanger(canManage && selected.size > 0 && !busy)}>
              Drop selected
            </button>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: '#64748b' }}>Send from</span>
            <select value={mailbox} onChange={(e) => setMailbox(e.target.value)} style={selStyle} disabled={!mailboxes.length}>
              {mailboxes.length === 0 && <option value="">no active mailbox</option>}
              {mailboxes.map((m) => (
                <option key={m.account_email} value={m.account_email}>
                  {m.account_email}{m.is_practice_default ? ' (default)' : ''}
                </option>
              ))}
            </select>
            <button onClick={onClose} style={btnGhost}>Close</button>
            <button onClick={release} disabled={!canManage || !selected.size || !mailbox || busy} style={btnPrimary(canManage && selected.size > 0 && !!mailbox && !busy)}>
              {busy ? 'Working…' : `Release ${selected.size || ''} now`}
            </button>
          </div>
        )}
        {!isQueued && (
          <div style={{ display: 'flex', marginTop: 14 }}>
            <div style={{ flex: 1 }} />
            <button onClick={onClose} style={btnGhost}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}
