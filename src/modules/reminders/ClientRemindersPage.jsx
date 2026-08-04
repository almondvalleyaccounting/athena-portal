import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import ClientTypeAhead from '../work-planner/components/ClientTypeAhead';
import {
  fmtMoney, fmtDateLong, fmtDateTimeShort,
  greetingName, taxPaymentRef, buildEmailPreview, PAY_URL, PTA_URL, utr10,
} from './lib';
import EmailTemplatesModal from './EmailTemplatesModal';
import ReminderQueueModal from './ReminderQueueModal';

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
  padding: '8px 8px', fontSize: 11, fontWeight: 600, color: '#64748b',
  textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.4,
  borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap',
};
const td = { padding: '7px 8px', fontSize: 12.5, color: '#1e293b', borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle' };

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

// The TaxCalc CSV upload flow now lives in TaxBatchUpload.jsx, rendered as a
// page section in Data Import (/admin/import/taxcalc) — the button in the
// batch bar below links across to it.

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 200,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
};

// ── Confirm-send modal ────────────────────────────────────────────────
function ConfirmSendModal({ mode, targets, dueDate, template, profile, alreadySent = [], onClose, onDone }) {
  // targets: [{ paymentId, entityId, name, email, amount, ref }]
  // alreadySent: entity ids that have already had this kind of email for the
  // current batch — the once-per-run block will refuse them unless overridden.
  const [sending, setSending] = useState(false);
  const [testState, setTestState] = useState(null); // null | 'sending' | 'ok' | error string
  const [err, setErr] = useState(null);
  const [resend, setResend] = useState(false);
  const isPromo = mode === 'promo';
  const first = targets[0];
  const sentSet = useMemo(() => new Set(alreadySent), [alreadySent]);
  const repeats = targets.filter((t) => sentSet.has(t.entityId));

  // Preview renders the real template (what the edge function sends), with
  // the first recipient's actual values substituted in.
  const preview = buildEmailPreview(template, {
    first_name: greetingName(first ? first.name : 'Client'),
    amount: fmtMoney(first ? first.amount : 0),
    due_date: fmtDateLong(dueDate),
    payment_ref: (first && first.ref) || '1234567890K',
    opt_in_url: '#opt-in',
    opt_out_url: '#opt-out',
    pay_url: PAY_URL,
    pta_url: PTA_URL,
  });

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

  const queueAll = async () => {
    setSending(true);
    setErr(null);
    try {
      const data = await invoke({
        mode: 'queue',
        targets: targets.map((t) => ({ entity_id: t.entityId, payment_id: t.paymentId })),
        allow_resend: resend || undefined,
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
            {isPromo ? 'Queue opt-in invitation' : 'Queue payment reminders'}
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, color: '#64748b', cursor: 'pointer', fontFamily: font }}>×</button>
        </div>

        {err && <Banner tone="error" onDismiss={() => setErr(null)}>{err}</Banner>}
        {testState === 'ok' && <Banner tone="ok">Test email sent to {profile?.email}. Note: the opt-in links in a test email still act on the real client's preference — don't click them unless you mean it.</Banner>}

        <div style={{ fontSize: 12.5, color: '#334155', marginBottom: 8 }}>
          Subject: <strong>{preview.subject}</strong>
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
          dangerouslySetInnerHTML={{ __html: preview.html }}
        />

        {/* Manual override for the once-per-run block — for "I never got it",
            a bounced address now corrected, or a client asking again. */}
        <label style={{
          display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 14, cursor: 'pointer',
          padding: '9px 12px', borderRadius: 8,
          background: resend ? '#fffbeb' : '#f8fafc',
          border: `1px solid ${resend ? '#fde68a' : '#e5e7eb'}`,
        }}>
          <input type="checkbox" checked={resend} onChange={(e) => setResend(e.target.checked)} style={{ marginTop: 2 }} />
          <span style={{ fontSize: 12.5, color: resend ? '#92400e' : '#475569' }}>
            <strong>Send again</strong> — queue another copy even if they've already had this
            run's email.
            {repeats.length > 0 && (
              <span style={{ display: 'block', marginTop: 3 }}>
                {repeats.length === 1
                  ? `${repeats[0].name} has already been emailed for this batch — without this, they'll be skipped.`
                  : `${repeats.length} of these have already been emailed for this batch — without this, they'll be skipped.`}
              </span>
            )}
          </span>
        </label>

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
          <button onClick={queueAll} disabled={sending || !targets.length} style={btnPrimary(!sending && targets.length > 0)}>
            {sending
              ? 'Adding…'
              : resend ? `Queue ${targets.length} again` : `Add ${targets.length} to queue`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────
export default function ClientRemindersPage() {
  const navigate = useNavigate();
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
  // entity ids already emailed (first send) for the selected batch, per kind
  const [emailedThisBatch, setEmailedThisBatch] = useState({ promo: new Set(), reminder: new Set() });
  const [gmailConn, setGmailConn] = useState(null); // row | null (none) | 'hidden' (RLS blocked)

  const [selected, setSelected] = useState(() => new Set());
  const [confirm, setConfirm] = useState(null); // { mode, targets }
  const [rowResults, setRowResults] = useState({}); // entity_id -> { ok, text }
  const [templatesByKind, setTemplatesByKind] = useState({}); // 'promo'|'reminder' -> template row
  const [showTemplates, setShowTemplates] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const [autoQueue, setAutoQueue] = useState(null); // { enabled, last_run_at } | null
  const [bmEmailByEntity, setBmEmailByEntity] = useState({}); // entity_id -> BM contact email fallback
  const [ignoreByUtr, setIgnoreByUtr] = useState(() => new Map()); // utr -> reason ('not_client' | 'client_excluded')
  const [filters, setFilters] = useState({ q: '', pref: 'all', paid: 'all', match: 'all' });

  const entityById = useMemo(() => Object.fromEntries(entities.map((e) => [e.id, e])), [entities]);
  const batch = batches.find((b) => b.id === batchId) || null;

  // ── loads ──
  const loadShared = useCallback(async () => {
    try {
      const [{ data: b, error: e1 }, { data: ents, error: e2 }] = await Promise.all([
        supabase.from('tax_payment_batches').select('id, label, due_date, source_filename, created_at').order('created_at', { ascending: false }),
        supabase.from('entities').select('id, name, utr, bm_client_id, qbo_customer_name, billing_email, prospect_email, type, entity_status').order('name'),
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

      // Email copy — the send preview renders these exact templates.
      const { data: tmpls } = await supabase
        .from('comm_templates').select('kind, subject, body_html, body_text').eq('comm_type', COMM_TYPE);
      setTemplatesByKind(Object.fromEntries((tmpls || []).map((t) => [t.kind, t])));

      // BM contact email — the send-to fallback when a client has no
      // billing/prospect email on the entity (most personal-tax clients).
      const { data: bmRows } = await supabase
        .from('v_email_reconciliation').select('entity_id, bm_contact_email');
      const bmMap = {};
      for (const b of bmRows || []) {
        if (b.entity_id && !bmMap[b.entity_id] && (b.bm_contact_email || '').trim()) {
          bmMap[b.entity_id] = b.bm_contact_email.trim();
        }
      }
      setBmEmailByEntity(bmMap);

      // How many emails are waiting in the review queue.
      const { count: qCount } = await supabase
        .from('reminder_emails')
        .select('id', { count: 'exact', head: true })
        .eq('comm_type', COMM_TYPE).eq('status', 'queued');
      setQueuedCount(qCount || 0);

      // Auto-queue (Jan/Jul cron) on/off state.
      const { data: aq } = await supabase.from('v_reminder_autoqueue').select('enabled, last_run_at').maybeSingle();
      setAutoQueue(aq || null);

      // Reminder-exclusion list (UTR -> reason: not a client / client-excluded).
      const { data: ign } = await supabase.from('tax_reminder_ignore').select('utr, reason');
      setIgnoreByUtr(new Map((ign || []).map((r) => [r.utr, r.reason || 'not_client'])));

      // Gmail pill — reminders go out from the practice-default mailbox.
      // v_gmail_connections is the staff-safe view (no token columns).
      try {
        const { data: conn, error: gErr } = await supabase
          .from('v_gmail_connections')
          .select('status, account_email')
          .eq('status', 'active')
          .eq('is_practice_default', true)
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
    if (!id) { setRows([]); setEmailedThisBatch({ promo: new Set(), reminder: new Set() }); return; }
    const [{ data, error: e }, { data: sentRows }] = await Promise.all([
      supabase.from('tax_payments_due').select('*').eq('batch_id', id).order('client_name_raw'),
      // Who has already had each kind of email for this batch — a first send,
      // not a resend. These are the clients the once-per-run block will refuse
      // unless "Send again" is ticked.
      supabase.from('reminder_emails')
        .select('entity_id, kind, status, is_resend')
        .eq('comm_type', COMM_TYPE).eq('batch_id', id).eq('is_resend', false)
        .in('status', ['queued', 'sent']),
    ]);
    if (e) { setError(`Could not load batch rows: ${e.message}`); return; }
    setRows(data || []);
    const promo = new Set();
    const reminder = new Set();
    for (const r of sentRows || []) {
      if (r.kind === 'promo') promo.add(r.entity_id);
      else if (r.kind === 'reminder' || r.kind === 'no_utr') reminder.add(r.entity_id);
    }
    setEmailedThisBatch({ promo, reminder });
  }, []);

  useEffect(() => { loadShared(); }, [loadShared]);
  useEffect(() => { setSelected(new Set()); setRowResults({}); loadRows(batchId); }, [batchId, loadRows]);

  // ── row helpers ──
  const emailOf = (row) => {
    if (!row.entity_id) return null;
    const ent = entityById[row.entity_id];
    if (!ent) return null;
    return (ent.billing_email || '').trim() || (ent.prospect_email || '').trim()
      || (bmEmailByEntity[row.entity_id] || '').trim() || null;
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

  // Payment status is paid/unpaid only. Paid suppresses reminders because
  // they've paid — nothing to do with the manual reminder override.
  const cyclePaid = async (row) => {
    const next = row.status === 'paid' ? 'unpaid' : 'paid';
    const { error: e } = await supabase.from('tax_payments_due').update({ status: next }).eq('id', row.id);
    if (e) { setError(`Could not update the status: ${e.message}`); return; }
    setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, status: next } : r)));
  };

  // Manually exclude a client from reminders, with a reason. Persists in
  // tax_reminder_ignore (survives re-imports) and is changeable later.
  // reason: 'not_client' (return we file but not a practice client) or
  // 'client_excluded' (a client we've chosen not to remind, with a note).
  const setIgnore = async (row, reason) => {
    const u = rowUtr(row);
    if (!u) { setError('That row has no 10-digit UTR to exclude.'); return; }
    let note = null;
    if (reason === 'client_excluded') {
      note = window.prompt('Reason for excluding this client from reminders (optional):', '') || null;
    }
    const { error } = await supabase.from('tax_reminder_ignore')
      .upsert({ utr: u, reason, note, created_by: profile?.id || null }, { onConflict: 'utr' });
    if (error) { setError(`Could not save the exclusion: ${error.message}`); return; }
    setIgnoreByUtr((m) => new Map(m).set(u, reason));
    setNotice(reason === 'not_client'
      ? `UTR ${u} marked "not a client" — excluded from reminders.`
      : `UTR ${u} excluded from reminders (client).`);
  };

  // Undo an exclusion — put the client back in the reminder run.
  const removeIgnore = async (row) => {
    const u = rowUtr(row);
    if (!u) return;
    const { error } = await supabase.from('tax_reminder_ignore').delete().eq('utr', u);
    if (error) { setError(`Could not restore: ${error.message}`); return; }
    setIgnoreByUtr((m) => { const n = new Map(m); n.delete(u); return n; });
    setNotice(`UTR ${u} back in the reminder run.`);
  };

  // ── selection + action-bar eligibility ──
  const toggleRow = (id) => {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };
  // Never send to a former client (nlac/archived), even if a stale TaxCalc row
  // has them opted-in and unpaid. reminders-send enforces this too; we filter
  // here so they don't show as selectable targets in the first place.
  const isFormerClient = (r) => ['nlac', 'archived'].includes(entityById[r.entity_id]?.entity_status);
  // Effective UTR for ignore/reference purposes: the TaxCalc row's UTR,
  // else the client's UTR on the entity (added to BM after the upload).
  const rowUtr = (r) => utr10(r.reference_raw) || utr10(entityById[r.entity_id]?.utr || '');
  const isIgnored = (r) => { const u = rowUtr(r); return !!u && ignoreByUtr.has(u); };
  const ignoreReason = (r) => ignoreByUtr.get(rowUtr(r)) || '';

  // Column filters — display only; selection persists across filter changes.
  const visibleRows = useMemo(() => {
    const list = rows || [];
    const q = filters.q.trim().toLowerCase();
    return list.filter((r) => {
      if (filters.pref !== 'all' && prefStatusOf(r) !== filters.pref) return false;
      if (filters.paid !== 'all' && (r.status || 'unpaid') !== filters.paid) return false;
      if (filters.match === 'matched' && !r.entity_id) return false;
      if (filters.match === 'unmatched' && (r.entity_id || isIgnored(r))) return false;
      if (filters.match === 'ignored' && !isIgnored(r)) return false;
      if (q) {
        const ent = r.entity_id ? entityById[r.entity_id] : null;
        const hay = [r.client_name_raw, ent && ent.name, emailOf(r), r.reference_raw]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filters, entityById, prefsByEntity, ignoreByUtr, bmEmailByEntity]);

  const allSelected = visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.id));
  const toggleAll = () => {
    setSelected((s) => {
      const n = new Set(s);
      visibleRows.forEach((r) => (allSelected ? n.delete(r.id) : n.add(r.id)));
      return n;
    });
  };

  const selRows = (rows || []).filter((r) => selected.has(r.id));
  const toTarget = (r) => {
    const ent = entityById[r.entity_id];
    return { paymentId: r.id, entityId: r.entity_id, name: ent ? ent.name : r.client_name_raw, email: emailOf(r), amount: r.amount, ref: taxPaymentRef(r.reference_raw) };
  };
  const inviteTargets = selRows
    .filter((r) => r.entity_id && !isFormerClient(r) && !isIgnored(r) && emailOf(r) && !['opted_in', 'opted_out'].includes(prefStatusOf(r)))
    .map(toTarget);
  const reminderTargets = selRows
    .filter((r) => r.entity_id && !isFormerClient(r) && !isIgnored(r) && emailOf(r) && prefStatusOf(r) === 'opted_in' && r.status === 'unpaid' && r.amount != null)
    .map(toTarget);

  const onSendDone = (result) => {
    // result: { queued?, sent?, skipped: [{entity_id, reason}], errors: [{entity_id, error}] }
    const queuedMode = result?.queued != null;
    const okWord = queuedMode ? 'queued' : 'sent';
    const map = {};
    const targetIds = (confirm ? confirm.targets : []).map((t) => t.entityId);
    for (const eid of targetIds) map[eid] = { ok: true, text: okWord };
    for (const s of result?.skipped || []) map[s.entity_id] = { ok: false, text: s.reason };
    for (const e of result?.errors || []) map[e.entity_id] = { ok: false, text: e.error };
    setRowResults(map);
    setConfirm(null);
    setSelected(new Set());
    const n = queuedMode ? result.queued : (result?.sent ?? 0);
    const bits = [`${n} ${okWord}`];
    if (result?.skipped?.length) bits.push(`${result.skipped.length} skipped`);
    if (result?.errors?.length) bits.push(`${result.errors.length} failed`);
    setNotice(bits.join(', ') + (queuedMode ? ' — open Review queue to check and release.' : '.'));
    loadShared();
    loadRows(batchId);
  };

  const toggleAutoQueue = async () => {
    const next = !(autoQueue?.enabled);
    // Persisted via a SECURITY DEFINER RPC (a direct table update is blocked
    // by RLS-on-write and silently no-ops, so the flag reverted on refresh).
    const { error: e } = await supabase.rpc('set_reminder_autoqueue_enabled', { p_enabled: next });
    if (e) { setError(`Could not change auto-queue: ${e.message}`); return; }
    setAutoQueue((a) => ({ ...(a || {}), enabled: next }));
    setNotice(next
      ? 'Auto-queue ON — every 15 minutes in January & July the queue is filled for you to review and release.'
      : 'Auto-queue OFF.');
  };

  // ── render ──
  if (loading) {
    return <div style={{ padding: 24, fontFamily: font, fontSize: 13, color: '#64748b' }}>Loading client reminders…</div>;
  }

  return (
    <div style={{ padding: '20px 24px', fontFamily: font, maxWidth: 1200 }}>
      {/* 1 — header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', margin: 0 }}>Client Tax Reminders</h1>
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
        <button
          onClick={toggleAutoQueue}
          title="Every 15 minutes during January & July, auto-fill the queue (opt-in invites for undecided clients, reminders for opted-in). Queue only — you still review and release."
          style={{
            padding: '2px 10px', fontSize: 11, fontWeight: 600, borderRadius: 999, cursor: 'pointer', fontFamily: font,
            background: autoQueue?.enabled ? '#f0fdf4' : '#f1f5f9',
            color: autoQueue?.enabled ? '#166534' : '#64748b',
            border: `1px solid ${autoQueue?.enabled ? '#bbf7d0' : '#e2e8f0'}`,
          }}
        >
          ⟳ Auto-queue (Jan & Jul): {autoQueue?.enabled ? 'ON' : 'OFF'}
        </button>
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
        <button onClick={() => setShowQueue(true)} style={btnGhost}>
          Review queue{queuedCount ? ` (${queuedCount})` : ''}
        </button>
        <button onClick={() => setShowTemplates(true)} style={btnGhost}>
          Email templates
        </button>
        <button onClick={() => navigate('/admin/import/taxcalc')} style={btnGhost}>
          Import TaxCalc data →
        </button>
      </div>

      {/* 3 — table */}
      {!batches.length ? (
        <div style={{ ...card, padding: '40px 20px', textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#334155', marginBottom: 6 }}>No payment batches yet</div>
          <div style={{ fontSize: 12.5, color: '#64748b' }}>
            Import a TaxCalc report (CSV) of payments on account to get started — use{' '}
            <button
              onClick={() => navigate('/admin/import/taxcalc')}
              style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                fontFamily: font, fontSize: 12.5, fontWeight: 600, color: ACCENT,
                textDecoration: 'underline',
              }}
            >
              Import TaxCalc data →
            </button>
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
          {/* filters */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap' }}>
            <input
              value={filters.q}
              onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
              placeholder="Search name, email or UTR…"
              style={{ padding: '5px 10px', fontSize: 12.5, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 8, minWidth: 220 }}
            />
            {[
              ['match', [['all', 'All matches'], ['matched', 'Matched'], ['unmatched', 'Unmatched'], ['ignored', 'Ignored']]],
              ['pref', [['all', 'Any preference'], ['opted_in', 'Opted in'], ['opted_out', 'Opted out'], ['pending', 'Pending'], ['not_asked', 'Not asked']]],
              ['paid', [['all', 'Any status'], ['unpaid', 'Unpaid'], ['paid', 'Paid']]],
            ].map(([key, opts]) => (
              <select
                key={key}
                value={filters[key]}
                onChange={(e) => setFilters((f) => ({ ...f, [key]: e.target.value }))}
                style={{ padding: '5px 8px', fontSize: 12, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', color: '#334155', cursor: 'pointer' }}
              >
                {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            ))}
            <span style={{ fontSize: 12, color: '#94a3b8' }}>{visibleRows.length} of {rows.length}</span>
            {(filters.q || filters.pref !== 'all' || filters.paid !== 'all' || filters.match !== 'all') && (
              <button onClick={() => setFilters({ q: '', pref: 'all', paid: 'all', match: 'all' })} style={btnGhost}>Clear</button>
            )}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 30 }}>
                    <input type="checkbox" checked={!!allSelected} onChange={toggleAll} />
                  </th>
                  <th style={th}>TaxCalc</th>
                  <th style={th}>Matched (BM)</th>
                  <th style={th}>Reminder</th>
                  <th style={th}>Email</th>
                  <th style={{ ...th, textAlign: 'right' }}>Amount</th>
                  <th style={th}>Preference</th>
                  <th style={th}>Set</th>
                  <th style={th}>Payment</th>
                  <th style={th}>Last contact</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.length === 0 && (
                  <tr><td style={{ ...td, color: '#94a3b8' }} colSpan={10}>No rows match these filters.</td></tr>
                )}
                {visibleRows.map((row) => {
                  const ent = row.entity_id ? entityById[row.entity_id] : null;
                  const email = emailOf(row);
                  const prefStatus = prefStatusOf(row);
                  const lastEm = row.entity_id ? lastEmailByEntity[row.entity_id] : null;
                  const paidMeta = PAID_META[row.status] || PAID_META.unpaid;
                  const res = row.entity_id ? rowResults[row.entity_id] : null;
                  const rowIgnored = isIgnored(row);
                  return (
                    <tr key={row.id} style={{ background: selected.has(row.id) ? '#f8fbff' : 'transparent' }}>
                      <td style={td}>
                        <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggleRow(row.id)} />
                      </td>
                      {/* TaxCalc Client — the raw imported name + UTR */}
                      <td style={td}>
                        <span style={{ fontWeight: 600 }}>{row.client_name_raw}</span>
                        {row.reference_raw && <div style={{ fontSize: 11, color: '#94a3b8' }}>{row.reference_raw}</div>}
                      </td>
                      {/* Athena (BM) Client — the matched client picker */}
                      <td style={td}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <ClientTypeAhead
                            entityList={entities}
                            value={row.entity_id || ''}
                            onChange={(id) => setEntityMatch(row, id)}
                            onAddNew={async () => null}
                            size="small"
                            metaOf={(e) => [
                              e.utr && `UTR ${e.utr}`,
                              e.bm_client_id && `ref ${e.bm_client_id}`,
                              (e.qbo_customer_name && e.qbo_customer_name !== e.name) ? e.qbo_customer_name : null,
                            ].filter(Boolean).join(' · ')}
                          />
                          {!row.entity_id && !rowIgnored && (
                            <span style={{ fontSize: 10.5, color: '#b91c1c', fontWeight: 600 }}>unmatched</span>
                          )}
                        </div>
                      </td>
                      {/* Reminder — exclusion reason (persists, changeable) */}
                      <td style={td}>
                        {!rowUtr(row) ? (
                          <span style={{ fontSize: 11.5, color: '#cbd5e1' }}>—</span>
                        ) : (
                          <select
                            value={ignoreReason(row)}
                            onChange={(e) => (e.target.value ? setIgnore(row, e.target.value) : removeIgnore(row))}
                            title="Exclude this UTR from reminders (persists across imports) — or leave 'Reminding' to keep them in the run"
                            style={{
                              padding: '3px 6px', fontSize: 11, fontFamily: font, borderRadius: 6, cursor: 'pointer',
                              background: rowIgnored ? '#fef2f2' : '#f0fdf4',
                              color: rowIgnored ? '#b91c1c' : '#166534',
                              border: `1px solid ${rowIgnored ? '#fecaca' : '#bbf7d0'}`,
                            }}
                          >
                            <option value="">Reminding</option>
                            <option value="not_client">Not a client</option>
                            <option value="client_excluded">Client — excluded</option>
                          </select>
                        )}
                      </td>
                      <td style={td}>
                        {email ? (
                          <span title={email} style={{
                            display: 'inline-block', maxWidth: 180, overflow: 'hidden',
                            textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle',
                            fontSize: 12, color: '#334155',
                          }}>{email}</span>
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
                      {/* Preference — status chip only */}
                      <td style={td}>
                        <PrefChip status={prefStatus} />
                      </td>
                      {/* Set — manual preference override */}
                      <td style={td}>
                        {ent ? (
                          <select
                            value=""
                            onChange={(e) => setPreference(row.entity_id, e.target.value)}
                            title="Set the preference manually — e.g. record a yes/no from an email reply"
                            style={{
                              padding: '3px 6px', fontSize: 11, fontFamily: font, color: '#64748b',
                              border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff',
                            }}
                          >
                            <option value="">set…</option>
                            <option value="in_reply">Opted in (replied)</option>
                            <option value="out_reply">Opted out (replied)</option>
                            <option value="in_staff">Opted in (staff)</option>
                            <option value="out_staff">Opted out (staff)</option>
                            <option value="pending">Back to pending</option>
                          </select>
                        ) : (
                          <span style={{ fontSize: 11.5, color: '#cbd5e1' }}>—</span>
                        )}
                      </td>
                      <td style={td}>
                        <button
                          onClick={() => cyclePaid(row)}
                          title="Click to toggle paid / unpaid. Paid suppresses reminders because they've paid — use the Reminder column to exclude for other reasons."
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
                        {res && (
                          <div style={{ marginBottom: 4 }}>
                            <span style={{
                              fontSize: 10.5, fontWeight: 600, padding: '1px 7px', borderRadius: 999,
                              background: res.ok ? '#f0fdf4' : '#fef2f2',
                              color: res.ok ? '#166534' : '#b91c1c',
                              border: `1px solid ${res.ok ? '#bbf7d0' : '#fecaca'}`,
                            }} title={res.text}>
                              {res.ok ? '✓ sent' : `✗ ${res.text}`}
                            </span>
                          </div>
                        )}
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
              title="Queues an opt-in invitation for selected clients (not yet opted in/out) — review and release from the queue"
            >
              Queue opt-in invitation{inviteTargets.length ? ` (${inviteTargets.length})` : ''}
            </button>
            <button
              onClick={() => reminderTargets.length && setConfirm({ mode: 'reminder', targets: reminderTargets })}
              disabled={!reminderTargets.length}
              style={btnPrimary(reminderTargets.length > 0)}
              title="Queues the payment reminder for selected clients who are opted in and unpaid — review and release from the queue"
            >
              Queue reminders{reminderTargets.length ? ` (${reminderTargets.length})` : ''}
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

      {confirm && (
        <ConfirmSendModal
          mode={confirm.mode}
          targets={confirm.targets}
          dueDate={batch ? batch.due_date : null}
          template={templatesByKind[confirm.mode]}
          profile={profile}
          alreadySent={[...(emailedThisBatch[confirm.mode] || [])]}
          onClose={() => setConfirm(null)}
          onDone={onSendDone}
        />
      )}

      {showTemplates && (
        <EmailTemplatesModal
          commType={COMM_TYPE}
          onClose={() => { setShowTemplates(false); loadShared(); }}
        />
      )}

      {showQueue && (
        <ReminderQueueModal
          commType={COMM_TYPE}
          entityById={entityById}
          profile={profile}
          onClose={() => setShowQueue(false)}
          onChanged={() => { loadShared(); loadRows(batchId); }}
        />
      )}
    </div>
  );
}
