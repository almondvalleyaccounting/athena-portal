import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import ClientTypeAhead from '../work-planner/components/ClientTypeAhead';
import {
  parseCsv, guessColumns, parseAmount, matchEntityByName,
  fmtMoney, fmtDateLong, fmtDateTimeShort,
  promoEmailPreviewHtml, reminderEmailPreviewHtml, PROMO_SUBJECT, reminderSubject,
} from './lib';

const font = "'Outfit', sans-serif";
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 };
const ACCENT = '#0e7fe0';
const COMM_TYPE = 'tax_reminders';

/*
  Client Reminders — communications to clients where relevant, starting
  with July personal-tax payments on account (due 31 July).

  Flow: upload a TaxCalc CSV → rows auto-match to entities by name →
  send opt-in invitations (emails include personal tax figures, so
  clients must say yes first) → send the actual reminders to opted-in,
  unpaid clients. Everything goes out as a REAL Gmail message from the
  connected info@ mailbox via the reminders-send edge function; replies
  and button clicks flow back through chase-reply-scan / comm-optin.
*/

// ── tiny style helpers ────────────────────────────────────────────────
const btnPrimary = (enabled) => ({
  padding: '8px 16px', fontSize: 12.5, fontWeight: 600, fontFamily: font,
  background: enabled ? ACCENT : '#e5e7eb', color: enabled ? '#fff' : '#94a3b8',
  border: 'none', borderRadius: 8, cursor: enabled ? 'pointer' : 'default',
});
const btnGhost = {
  padding: '7px 14px', fontSize: 12.5, fontWeight: 600, fontFamily: font,
  background: '#fff', color: '#334155', border: '1px solid #e5e7eb',
  borderRadius: 8, cursor: 'pointer',
};
const th = {
  padding: '8px 10px', fontSize: 11, fontWeight: 600, color: '#64748b',
  textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.4,
  borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap',
};
const td = { padding: '7px 10px', fontSize: 12.5, color: '#1e293b', borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle' };

const PREF_META = {
  opted_in: { label: 'Opted in', bg: '#f0fdf4', color: '#166534', border: '#bbf7d0' },
  opted_out: { label: 'Opted out', bg: '#fef2f2', color: '#b91c1c', border: '#fecaca' },
  pending: { label: 'Pending', bg: '#f1f5f9', color: '#475569', border: '#e2e8f0' },
  not_asked: { label: 'Not asked', bg: '#fff', color: '#94a3b8', border: '#e5e7eb' },
};
function PrefChip({ status }) {
  const m = PREF_META[status] || PREF_META.not_asked;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', fontSize: 11, fontWeight: 600,
      background: m.bg, color: m.color, border: `1px solid ${m.border}`,
      borderRadius: 999, whiteSpace: 'nowrap',
    }}>
      {m.label}
    </span>
  );
}

const PAID_META = {
  unpaid: { label: 'Unpaid', bg: '#fffbeb', color: '#92400e', border: '#fde68a' },
  paid: { label: 'Paid', bg: '#f0fdf4', color: '#166534', border: '#bbf7d0' },
  excluded: { label: 'Excluded', bg: '#f1f5f9', color: '#64748b', border: '#e2e8f0' },
};

function Banner({ tone = 'error', children, onDismiss }) {
  const tones = {
    error: { bg: '#fef2f2', border: '#fecaca', color: '#b91c1c' },
    ok: { bg: '#f0fdf4', border: '#bbf7d0', color: '#166534' },
    info: { bg: '#eff6ff', border: '#bfdbfe', color: '#1d4ed8' },
  };
  const t = tones[tone] || tones.error;
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8, padding: '9px 12px',
      background: t.bg, border: `1px solid ${t.border}`, borderRadius: 8,
      fontSize: 12.5, color: t.color, fontFamily: font, marginBottom: 10,
    }}>
      <div style={{ flex: 1 }}>{children}</div>
      {onDismiss && (
        <button onClick={onDismiss} style={{ background: 'none', border: 'none', color: t.color, cursor: 'pointer', fontSize: 13, fontFamily: font, padding: 0 }}>×</button>
      )}
    </div>
  );
}

// ── Upload modal ──────────────────────────────────────────────────────
function UploadModal({ entities, profileId, onClose, onSaved }) {
  const year = new Date().getFullYear();
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState([]);
  const [dataRows, setDataRows] = useState([]);
  const [mapping, setMapping] = useState({ name: -1, amount: -1, reference: -1 });
  const [label, setLabel] = useState(`July ${year} payments on account`);
  const [dueDate, setDueDate] = useState(`${year}-07-31`);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);

  const onFile = (e) => {
    setErr(null);
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const rows = parseCsv(String(reader.result || ''));
        if (rows.length < 2) { setErr('That file has no data rows — expected a header row plus at least one client.'); return; }
        const hdr = rows[0].map((h) => String(h).trim());
        setFileName(f.name);
        setHeaders(hdr);
        setDataRows(rows.slice(1));
        setMapping(guessColumns(hdr));
      } catch (ex) {
        setErr(`Could not read that file: ${ex.message}`);
      }
    };
    reader.onerror = () => setErr('Could not read that file.');
    reader.readAsText(f);
  };

  // Live preview of how the mapped rows will import.
  const parsed = useMemo(() => {
    if (mapping.name < 0) return [];
    return dataRows
      .map((r) => ({
        client_name_raw: String(r[mapping.name] ?? '').trim(),
        amount: mapping.amount >= 0 ? parseAmount(r[mapping.amount]) : null,
        reference_raw: mapping.reference >= 0 ? String(r[mapping.reference] ?? '').trim() || null : null,
      }))
      .filter((r) => r.client_name_raw);
  }, [dataRows, mapping]);

  const matchedCount = useMemo(
    () => parsed.filter((r) => matchEntityByName(r.client_name_raw, entities)).length,
    [parsed, entities],
  );

  const canSave = fileName && mapping.name >= 0 && mapping.amount >= 0 && label.trim() && dueDate && parsed.length > 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setErr(null);
    try {
      const { data: batch, error: bErr } = await supabase
        .from('tax_payment_batches')
        .insert({ label: label.trim(), due_date: dueDate, source_filename: fileName, uploaded_by: profileId || null })
        .select('id')
        .single();
      if (bErr) throw bErr;
      const items = parsed.map((r) => ({
        batch_id: batch.id,
        entity_id: matchEntityByName(r.client_name_raw, entities),
        client_name_raw: r.client_name_raw,
        reference_raw: r.reference_raw,
        amount: r.amount,
        status: 'unpaid',
      }));
      for (let i = 0; i < items.length; i += 500) {
        const { error: iErr } = await supabase.from('tax_payments_due').insert(items.slice(i, i + 500));
        if (iErr) throw iErr;
      }
      onSaved(batch.id);
    } catch (ex) {
      setErr(`Save failed: ${ex.message || String(ex)}`);
      setSaving(false);
    }
  };

  const selStyle = {
    padding: '5px 8px', fontSize: 12, fontFamily: font, border: '1px solid #e5e7eb',
    borderRadius: 6, background: '#fff', color: '#1e293b',
  };
  const lbl = { fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 3, display: 'block' };

  return (
    <div style={overlayStyle}>
      <div style={{ ...card, width: 720, maxWidth: '94vw', maxHeight: '88vh', overflowY: 'auto', padding: 20, fontFamily: font }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Upload TaxCalc export</div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, color: '#64748b', cursor: 'pointer', fontFamily: font }}>×</button>
        </div>

        {err && <Banner tone="error" onDismiss={() => setErr(null)}>{err}</Banner>}

        <div style={{ marginBottom: 14 }}>
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: 'none' }} />
          <button onClick={() => fileRef.current && fileRef.current.click()} style={btnGhost}>
            {fileName ? `File: ${fileName} — choose another` : 'Choose CSV file…'}
          </button>
        </div>

        {headers.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
              {[['name', 'Client name'], ['amount', 'Amount'], ['reference', 'Reference']].map(([key, title]) => (
                <div key={key}>
                  <span style={lbl}>{title}{key !== 'reference' ? ' *' : ' (optional)'}</span>
                  <select
                    value={mapping[key]}
                    onChange={(e) => setMapping({ ...mapping, [key]: Number(e.target.value) })}
                    style={selStyle}
                  >
                    <option value={-1}>— not set —</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </select>
                </div>
              ))}
              <div>
                <span style={lbl}>Batch label *</span>
                <input value={label} onChange={(e) => setLabel(e.target.value)} style={{ ...selStyle, width: 220 }} />
              </div>
              <div>
                <span style={lbl}>Due date *</span>
                <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} style={selStyle} />
              </div>
            </div>

            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>
              {parsed.length} row{parsed.length === 1 ? '' : 's'} will import
              {mapping.name >= 0 && <> — <strong style={{ color: '#166534' }}>{matchedCount} matched</strong> to clients by name, {parsed.length - matchedCount} to match by hand afterwards</>}.
            </div>

            <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', marginBottom: 14 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Client name</th>
                    <th style={th}>Amount</th>
                    <th style={th}>Reference</th>
                    <th style={th}>Match</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.slice(0, 8).map((r, i) => {
                    const m = matchEntityByName(r.client_name_raw, entities);
                    const ent = m ? entities.find((e) => e.id === m) : null;
                    return (
                      <tr key={i}>
                        <td style={td}>{r.client_name_raw}</td>
                        <td style={td}>{r.amount != null ? `£${fmtMoney(r.amount)}` : <span style={{ color: '#b91c1c' }}>no amount</span>}</td>
                        <td style={td}>{r.reference_raw || '—'}</td>
                        <td style={td}>{ent ? <span style={{ color: '#166534' }}>{ent.name}</span> : <span style={{ color: '#94a3b8' }}>unmatched</span>}</td>
                      </tr>
                    );
                  })}
                  {parsed.length > 8 && (
                    <tr><td style={{ ...td, color: '#94a3b8' }} colSpan={4}>…and {parsed.length - 8} more</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={btnGhost}>Cancel</button>
          <button onClick={save} disabled={!canSave} style={btnPrimary(canSave)}>
            {saving ? 'Saving…' : 'Save batch'}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 200,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
};

// ── Confirm-send modal ────────────────────────────────────────────────
function ConfirmSendModal({ mode, targets, dueDate, profile, onClose, onDone }) {
  // targets: [{ paymentId, entityId, name, email, amount }]
  const [sending, setSending] = useState(false);
  const [testState, setTestState] = useState(null); // null | 'sending' | 'ok' | error string
  const [err, setErr] = useState(null);
  const isPromo = mode === 'promo';
  const first = targets[0];

  const previewHtml = isPromo
    ? promoEmailPreviewHtml(first ? first.name : 'Client')
    : reminderEmailPreviewHtml(first ? first.name : 'Client', first ? first.amount : 0, dueDate);

  const invoke = async (extra) => {
    const body = {
      kind: mode === 'promo' ? 'promo' : 'reminder',
      comm_type: COMM_TYPE,
      due_date: dueDate || undefined,
      ...extra,
    };
    const { data, error } = await supabase.functions.invoke('reminders-send', { body });
    if (error) throw new Error(error.message || 'Send failed');
    if (data && data.success === false) throw new Error(data.error || 'Send failed');
    return data;
  };

  const sendTest = async () => {
    if (!profile?.email || !first) return;
    setTestState('sending');
    setErr(null);
    try {
      await invoke({
        targets: [{ entity_id: first.entityId, payment_id: first.paymentId }],
        test_recipient: profile.email,
      });
      setTestState('ok');
    } catch (ex) {
      setTestState(null);
      setErr(`Test send failed: ${ex.message}`);
    }
  };

  const sendAll = async () => {
    setSending(true);
    setErr(null);
    try {
      const data = await invoke({
        targets: targets.map((t) => ({ entity_id: t.entityId, payment_id: t.paymentId })),
      });
      onDone(data);
    } catch (ex) {
      setErr(ex.message);
      setSending(false);
    }
  };

  return (
    <div style={overlayStyle}>
      <div style={{ ...card, width: 760, maxWidth: '94vw', maxHeight: '88vh', overflowY: 'auto', padding: 20, fontFamily: font }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>
            {isPromo ? 'Send opt-in invitation' : 'Send payment reminders'}
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, color: '#64748b', cursor: 'pointer', fontFamily: font }}>×</button>
        </div>

        {err && <Banner tone="error" onDismiss={() => setErr(null)}>{err}</Banner>}
        {testState === 'ok' && <Banner tone="ok">Test email sent to {profile?.email}. Note: the opt-in links in a test email still act on the real client's preference — don't click them unless you mean it.</Banner>}

        <div style={{ fontSize: 12.5, color: '#334155', marginBottom: 8 }}>
          Subject: <strong>{isPromo ? PROMO_SUBJECT : reminderSubject(dueDate)}</strong>
        </div>

        <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
          Recipients ({targets.length})
        </div>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, maxHeight: 160, overflowY: 'auto', marginBottom: 14 }}>
          {targets.map((t) => (
            <div key={t.paymentId || t.entityId} style={{ display: 'flex', gap: 10, padding: '5px 10px', fontSize: 12, color: '#1e293b', borderBottom: '1px solid #f1f5f9' }}>
              <span style={{ flex: 1, fontWeight: 600 }}>{t.name}</span>
              <span style={{ color: '#64748b' }}>{t.email}</span>
              {!isPromo && <span style={{ minWidth: 80, textAlign: 'right' }}>£{fmtMoney(t.amount)}</span>}
            </div>
          ))}
        </div>

        <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
          Preview {first ? `(as ${first.name} will see it)` : ''}
        </div>
        <div
          style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '4px 10px', marginBottom: 16, background: '#fff' }}
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={sendTest}
            disabled={testState === 'sending' || sending || !profile?.email}
            style={{ ...btnGhost, opacity: testState === 'sending' ? 0.6 : 1 }}
            title={profile?.email ? `Sends ONE email to ${profile.email}` : 'No email on your profile'}
          >
            {testState === 'sending' ? 'Sending test…' : `Send test to me${profile?.email ? ` (${profile.email})` : ''}`}
          </button>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={btnGhost}>Cancel</button>
          <button onClick={sendAll} disabled={sending || !targets.length} style={btnPrimary(!sending && targets.length > 0)}>
            {sending
              ? 'Sending…'
              : `Send ${targets.length} email${targets.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────
export default function ClientRemindersPage() {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const [batches, setBatches] = useState([]);
  const [batchId, setBatchId] = useState('');
  const [rows, setRows] = useState(null);
  const [entities, setEntities] = useState([]);
  const [prefsByEntity, setPrefsByEntity] = useState({});
  const [lastEmailByEntity, setLastEmailByEntity] = useState({});
  const [gmailConn, setGmailConn] = useState(null); // row | null (none) | 'hidden' (RLS blocked)

  const [selected, setSelected] = useState(() => new Set());
  const [showUpload, setShowUpload] = useState(false);
  const [confirm, setConfirm] = useState(null); // { mode, targets }
  const [rowResults, setRowResults] = useState({}); // entity_id -> { ok, text }

  const entityById = useMemo(() => Object.fromEntries(entities.map((e) => [e.id, e])), [entities]);
  const batch = batches.find((b) => b.id === batchId) || null;

  // ── loads ──
  const loadShared = useCallback(async () => {
    try {
      const [{ data: b, error: e1 }, { data: ents, error: e2 }] = await Promise.all([
        supabase.from('tax_payment_batches').select('id, label, due_date, source_filename, created_at').order('created_at', { ascending: false }),
        supabase.from('entities').select('id, name, billing_email, prospect_email, type').order('name'),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      setBatches(b || []);
      setEntities(ents || []);
      setBatchId((cur) => cur || (b && b[0] ? b[0].id : ''));

      const [{ data: prefs, error: e3 }, { data: emails, error: e4 }] = await Promise.all([
        supabase.from('client_comm_preferences').select('*').eq('comm_type', COMM_TYPE),
        supabase.from('reminder_emails')
          .select('id, entity_id, kind, sent_at, clicked_choice, clicked_at, reply_seen_at, to_email')
          .eq('comm_type', COMM_TYPE)
          .not('sent_at', 'is', null)
          .order('sent_at', { ascending: false })
          .limit(3000),
      ]);
      if (e3) throw e3;
      if (e4) throw e4;
      setPrefsByEntity(Object.fromEntries((prefs || []).map((p) => [p.entity_id, p])));
      const latest = {};
      for (const em of emails || []) {
        if (em.entity_id && !latest[em.entity_id]) latest[em.entity_id] = em; // sorted desc — first wins
      }
      setLastEmailByEntity(latest);

      // Gmail pill — RLS may block staff reads of gmail_connections; hide gracefully.
      try {
        const { data: conn, error: gErr } = await supabase
          .from('gmail_connections')
          .select('status, account_email')
          .eq('status', 'active')
          .maybeSingle();
        setGmailConn(gErr ? 'hidden' : (conn || null));
      } catch {
        setGmailConn('hidden');
      }
      setError(null);
    } catch (ex) {
      setError(`Could not load reminders data: ${ex.message || String(ex)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRows = useCallback(async (id) => {
    if (!id) { setRows([]); return; }
    const { data, error: e } = await supabase
      .from('tax_payments_due')
      .select('*')
      .eq('batch_id', id)
      .order('client_name_raw');
    if (e) { setError(`Could not load batch rows: ${e.message}`); return; }
    setRows(data || []);
  }, []);

  useEffect(() => { loadShared(); }, [loadShared]);
  useEffect(() => { setSelected(new Set()); setRowResults({}); loadRows(batchId); }, [batchId, loadRows]);

  // ── row helpers ──
  const emailOf = (row) => {
    const ent = row.entity_id ? entityById[row.entity_id] : null;
    if (!ent) return null;
    return (ent.billing_email || '').trim() || (ent.prospect_email || '').trim() || null;
  };
  const prefStatusOf = (row) => {
    if (!row.entity_id) return 'not_asked';
    const p = prefsByEntity[row.entity_id];
    return p ? p.status : 'not_asked';
  };

  // ── mutations ──
  const setEntityMatch = async (row, entityId) => {
    const val = entityId || null;
    const { error: e } = await supabase.from('tax_payments_due').update({ entity_id: val }).eq('id', row.id);
    if (e) { setError(`Could not save the match: ${e.message}`); return; }
    setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, entity_id: val } : r)));
  };

  const setPreference = async (entityId, key) => {
    if (!entityId || !key) return;
    const map = {
      in_staff: { status: 'opted_in', via: 'staff' },
      out_staff: { status: 'opted_out', via: 'staff' },
      in_reply: { status: 'opted_in', via: 'email_reply' },
      out_reply: { status: 'opted_out', via: 'email_reply' },
      pending: { status: 'pending', via: 'staff' },
    };
    const m = map[key];
    if (!m) return;
    const now = new Date().toISOString();
    const rec = {
      entity_id: entityId,
      comm_type: COMM_TYPE,
      status: m.status,
      decided_at: m.status === 'pending' ? null : now,
      decided_via: m.status === 'pending' ? null : m.via,
      decided_by: m.via === 'staff' || m.via === 'email_reply' ? (profile?.id || null) : null,
      updated_at: now,
    };
    const { data, error: e } = await supabase
      .from('client_comm_preferences')
      .upsert(rec, { onConflict: 'entity_id,comm_type' })
      .select('*')
      .single();
    if (e) { setError(`Could not save the preference: ${e.message}`); return; }
    setPrefsByEntity((p) => ({ ...p, [entityId]: data || rec }));
  };

  const cyclePaid = async (row) => {
    const next = row.status === 'unpaid' ? 'paid' : row.status === 'paid' ? 'excluded' : 'unpaid';
    const { error: e } = await supabase.from('tax_payments_due').update({ status: next }).eq('id', row.id);
    if (e) { setError(`Could not update the status: ${e.message}`); return; }
    setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, status: next } : r)));
  };

  // ── selection + action-bar eligibility ──
  const toggleRow = (id) => {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };
  const allSelected = rows && rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => {
    if (!rows) return;
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  };

  const selRows = (rows || []).filter((r) => selected.has(r.id));
  const toTarget = (r) => {
    const ent = entityById[r.entity_id];
    return { paymentId: r.id, entityId: r.entity_id, name: ent ? ent.name : r.client_name_raw, email: emailOf(r), amount: r.amount };
  };
  const inviteTargets = selRows
    .filter((r) => r.entity_id && emailOf(r) && !['opted_in', 'opted_out'].includes(prefStatusOf(r)))
    .map(toTarget);
  const reminderTargets = selRows
    .filter((r) => r.entity_id && emailOf(r) && prefStatusOf(r) === 'opted_in' && r.status === 'unpaid' && r.amount != null)
    .map(toTarget);

  const onSendDone = (result) => {
    // result: { sent, skipped: [{entity_id, reason}], errors: [{entity_id, error}] }
    const map = {};
    const targetIds = (confirm ? confirm.targets : []).map((t) => t.entityId);
    for (const eid of targetIds) map[eid] = { ok: true, text: 'sent' };
    for (const s of result?.skipped || []) map[s.entity_id] = { ok: false, text: s.reason };
    for (const e of result?.errors || []) map[e.entity_id] = { ok: false, text: e.error };
    setRowResults(map);
    setConfirm(null);
    setSelected(new Set());
    const bits = [`${result?.sent ?? 0} sent`];
    if (result?.skipped?.length) bits.push(`${result.skipped.length} skipped`);
    if (result?.errors?.length) bits.push(`${result.errors.length} failed`);
    setNotice(bits.join(', ') + '.');
    loadShared();
    loadRows(batchId);
  };

  // ── render ──
  if (loading) {
    return <div style={{ padding: 24, fontFamily: font, fontSize: 13, color: '#64748b' }}>Loading client reminders…</div>;
  }

  return (
    <div style={{ padding: '20px 24px', fontFamily: font, maxWidth: 1200 }}>
      {/* 1 — header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', margin: 0 }}>Client Reminders</h1>
        <span style={{
          padding: '2px 10px', fontSize: 11, fontWeight: 600, borderRadius: 999,
          background: '#eff6ff', color: ACCENT, border: '1px solid #bfdbfe',
        }}>
          Tax reminders
        </span>
        {gmailConn !== 'hidden' && (
          gmailConn ? (
            <span style={{
              padding: '2px 10px', fontSize: 11, fontWeight: 600, borderRadius: 999,
              background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0',
            }}>
              ✉ Gmail connected — {gmailConn.account_email}
            </span>
          ) : (
            <span style={{
              padding: '2px 10px', fontSize: 11, fontWeight: 600, borderRadius: 999,
              background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca',
            }}>
              Gmail not connected — sends will fail
            </span>
          )
        )}
      </div>
      <p style={{ fontSize: 12.5, color: '#64748b', margin: '0 0 16px', maxWidth: 760 }}>
        Personal-tax payment reminders (31 July payments on account, 31 January balancing payments).
        Emails go out from the connected mailbox as normal typed emails — nothing branded. Because they
        include personal tax figures, each client opts in or out of "tax reminders" first; button clicks
        and replies are picked up automatically.
      </p>

      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner tone="ok" onDismiss={() => setNotice(null)}>{notice}</Banner>}

      {/* 2 — batch picker + upload */}
      <div style={{ ...card, padding: '12px 16px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#64748b' }}>Batch</span>
        {batches.length ? (
          <select
            value={batchId}
            onChange={(e) => setBatchId(e.target.value)}
            style={{ padding: '6px 10px', fontSize: 12.5, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', color: '#0f172a', maxWidth: 380 }}
          >
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label} — due {fmtDateLong(b.due_date)}
              </option>
            ))}
          </select>
        ) : (
          <span style={{ fontSize: 12.5, color: '#94a3b8' }}>No batches yet.</span>
        )}
        {batch && (
          <span style={{ fontSize: 11.5, color: '#94a3b8' }}>
            {batch.source_filename ? `from ${batch.source_filename}` : ''}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowUpload(true)} style={btnPrimary(true)}>Upload TaxCalc export</button>
      </div>

      {/* 3 — table */}
      {!batches.length ? (
        <div style={{ ...card, padding: '40px 20px', textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#334155', marginBottom: 6 }}>No payment batches yet</div>
          <div style={{ fontSize: 12.5, color: '#64748b' }}>
            Upload a TaxCalc report (CSV) of payments on account to get started.
          </div>
        </div>
      ) : rows === null ? (
        <div style={{ ...card, padding: 20, fontSize: 12.5, color: '#64748b' }}>Loading batch…</div>
      ) : !rows.length ? (
        <div style={{ ...card, padding: '30px 20px', textAlign: 'center', fontSize: 12.5, color: '#64748b' }}>
          This batch has no rows.
        </div>
      ) : (
        <div style={{ ...card, overflow: 'visible' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 30 }}>
                    <input type="checkbox" checked={!!allSelected} onChange={toggleAll} />
                  </th>
                  <th style={th}>Client</th>
                  <th style={th}>Email</th>
                  <th style={{ ...th, textAlign: 'right' }}>Amount</th>
                  <th style={th}>Preference</th>
                  <th style={th}>Paid</th>
                  <th style={th}>Last contact</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const ent = row.entity_id ? entityById[row.entity_id] : null;
                  const email = emailOf(row);
                  const prefStatus = prefStatusOf(row);
                  const lastEm = row.entity_id ? lastEmailByEntity[row.entity_id] : null;
                  const paidMeta = PAID_META[row.status] || PAID_META.unpaid;
                  const res = row.entity_id ? rowResults[row.entity_id] : null;
                  return (
                    <tr key={row.id} style={{ background: selected.has(row.id) ? '#f8fbff' : 'transparent' }}>
                      <td style={td}>
                        <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggleRow(row.id)} />
                      </td>
                      <td style={td}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 600 }}>{row.client_name_raw}</span>
                          {row.reference_raw && <span style={{ fontSize: 11, color: '#94a3b8' }}>{row.reference_raw}</span>}
                          <ClientTypeAhead
                            entityList={entities}
                            value={row.entity_id || ''}
                            onChange={(id) => setEntityMatch(row, id)}
                            onAddNew={async () => null}
                            size="small"
                          />
                          {!row.entity_id && (
                            <span style={{ fontSize: 10.5, color: '#b91c1c', fontWeight: 600 }}>unmatched</span>
                          )}
                          {res && (
                            <span style={{
                              fontSize: 10.5, fontWeight: 600, padding: '1px 7px', borderRadius: 999,
                              background: res.ok ? '#f0fdf4' : '#fef2f2',
                              color: res.ok ? '#166534' : '#b91c1c',
                              border: `1px solid ${res.ok ? '#bbf7d0' : '#fecaca'}`,
                            }} title={res.text}>
                              {res.ok ? '✓ sent' : `✗ ${res.text}`}
                            </span>
                          )}
                        </div>
                      </td>
                      <td style={td}>
                        {email ? (
                          <span style={{ fontSize: 12, color: '#334155' }}>{email}</span>
                        ) : ent ? (
                          <span style={{
                            padding: '2px 8px', fontSize: 11, fontWeight: 600, borderRadius: 999,
                            background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca',
                          }}>
                            no email
                          </span>
                        ) : (
                          <span style={{ fontSize: 11.5, color: '#94a3b8' }}>—</span>
                        )}
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {row.amount != null ? `£${fmtMoney(row.amount)}` : '—'}
                      </td>
                      <td style={td}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <PrefChip status={prefStatus} />
                          {ent && (
                            <select
                              value=""
                              onChange={(e) => setPreference(row.entity_id, e.target.value)}
                              title="Set the preference manually — e.g. record a yes/no from an email reply"
                              style={{
                                padding: '2px 4px', fontSize: 11, fontFamily: font, color: '#64748b',
                                border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', maxWidth: 52,
                              }}
                            >
                              <option value="">set…</option>
                              <option value="in_reply">Opted in (replied)</option>
                              <option value="out_reply">Opted out (replied)</option>
                              <option value="in_staff">Opted in (staff)</option>
                              <option value="out_staff">Opted out (staff)</option>
                              <option value="pending">Back to pending</option>
                            </select>
                          )}
                        </div>
                      </td>
                      <td style={td}>
                        <button
                          onClick={() => cyclePaid(row)}
                          title="Click to cycle: unpaid → paid → excluded"
                          style={{
                            padding: '2px 10px', fontSize: 11, fontWeight: 600, fontFamily: font,
                            background: paidMeta.bg, color: paidMeta.color, border: `1px solid ${paidMeta.border}`,
                            borderRadius: 999, cursor: 'pointer',
                          }}
                        >
                          {paidMeta.label}
                        </button>
                      </td>
                      <td style={td}>
                        {lastEm ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 11.5, color: '#64748b' }}>
                              {lastEm.kind === 'promo' ? 'invite' : 'reminder'} {fmtDateTimeShort(lastEm.sent_at)}
                            </span>
                            {lastEm.clicked_choice === 'in' && <span style={{ fontSize: 11, color: '#166534', fontWeight: 600 }}>✓ clicked in</span>}
                            {lastEm.clicked_choice === 'out' && <span style={{ fontSize: 11, color: '#b91c1c', fontWeight: 600 }}>✗ clicked out</span>}
                            {lastEm.reply_seen_at && <span style={{ fontSize: 11, color: ACCENT, fontWeight: 600 }}>↩ replied</span>}
                          </div>
                        ) : (
                          <span style={{ fontSize: 11.5, color: '#cbd5e1' }}>never</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 4 — action bar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
            borderTop: '1px solid #e5e7eb', flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: 12, color: '#64748b' }}>
              {selected.size ? `${selected.size} selected` : 'Select rows to send emails'}
            </span>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => inviteTargets.length && setConfirm({ mode: 'promo', targets: inviteTargets })}
              disabled={!inviteTargets.length}
              style={btnPrimary(inviteTargets.length > 0)}
              title="Asks selected clients (not yet opted in/out) whether they want tax reminders"
            >
              Send opt-in invitation{inviteTargets.length ? ` (${inviteTargets.length})` : ''}
            </button>
            <button
              onClick={() => reminderTargets.length && setConfirm({ mode: 'reminder', targets: reminderTargets })}
              disabled={!reminderTargets.length}
              style={btnPrimary(reminderTargets.length > 0)}
              title="Sends the payment reminder to selected clients who are opted in and unpaid"
            >
              Send reminders{reminderTargets.length ? ` (${reminderTargets.length})` : ''}
            </button>
          </div>
        </div>
      )}

      {selected.size > 0 && !inviteTargets.length && !reminderTargets.length && (
        <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 8 }}>
          None of the selected rows are eligible — invitations need a matched client with an email who
          hasn't already decided; reminders need an opted-in, unpaid client with an amount.
        </div>
      )}

      {showUpload && (
        <UploadModal
          entities={entities}
          profileId={profile?.id}
          onClose={() => setShowUpload(false)}
          onSaved={(id) => {
            setShowUpload(false);
            setNotice('Batch uploaded.');
            loadShared().then(() => setBatchId(id));
          }}
        />
      )}

      {confirm && (
        <ConfirmSendModal
          mode={confirm.mode}
          targets={confirm.targets}
          dueDate={batch ? batch.due_date : null}
          profile={profile}
          onClose={() => setConfirm(null)}
          onDone={onSendDone}
        />
      )}
    </div>
  );
}
