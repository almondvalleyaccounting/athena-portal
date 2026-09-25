import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { BTN } from '../../lib/buttonStyles';
import { longDate } from './repriceReasons';

const font = "'Outfit', sans-serif";

// Sign-off for a fee proposal (sql/300, fee-proposal edge function).
//
// Acceptance must be in writing by email — verbal is not enough — so the
// dialog will not submit until staff tick that it was, and give the date it
// arrived and the inbox it arrived in. The server and the table's CHECK
// require the same three facts.

const todayUk = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());

async function call(body) {
  const { data, error } = await supabase.functions.invoke('fee-proposal', { body });
  if (error || !data?.success) throw new Error(data?.error || error?.message || 'Request failed');
  return data;
}

export function RecordAcceptanceDialog({ proposal, clientName, onClose, onDone }) {
  const [inboxes, setInboxes] = useState([]);
  const [confirmed, setConfirmed] = useState(false);
  const [receivedOn, setReceivedOn] = useState(todayUk());
  const [inbox, setInbox] = useState('');
  const [other, setOther] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    supabase.from('gmail_connections').select('account_email').eq('status', 'active').order('account_email')
      .then(({ data }) => setInboxes((data || []).map((r) => r.account_email)));
  }, []);

  const issuedOn = proposal.issued_at ? proposal.issued_at.slice(0, 10) : undefined;
  const chosenInbox = inbox === '__other' ? other.trim() : inbox;
  const ok = confirmed && receivedOn && chosenInbox;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await call({ action: 'record_acceptance', proposal_id: proposal.id, email_confirmed: true, received_on: receivedOn, inbox: chosenInbox, note: note.trim() || null });
      onDone?.();
      onClose();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Record acceptance" onClose={onClose}>
      <p style={{ fontSize: 13, color: '#475569', margin: '0 0 14px', lineHeight: 1.5 }}>
        {clientName} · proposal issued {proposal.issued_at ? longDate(proposal.issued_at) : ''}, new fees from {longDate(proposal.effective_at)}.
      </p>

      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', border: `1px solid ${confirmed ? '#86efac' : '#e5e7eb'}`, background: confirmed ? '#f0fdf4' : '#fff', borderRadius: 8, cursor: 'pointer', marginBottom: 14 }}>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ marginTop: 3 }} />
        <span style={{ fontSize: 13, color: '#0f172a', lineHeight: 1.45 }}>
          I confirm the client accepted <strong>in writing, by email</strong>. Verbal acceptance is not enough.
        </span>
      </label>

      <Label>Date the email was received</Label>
      <input type="date" value={receivedOn} min={issuedOn} max={todayUk()} onChange={(e) => setReceivedOn(e.target.value)} style={input} />

      <Label style={{ marginTop: 12 }}>Inbox it arrived in</Label>
      <select value={inbox} onChange={(e) => setInbox(e.target.value)} style={input}>
        <option value="">— pick an inbox —</option>
        {inboxes.map((a) => <option key={a} value={a}>{a}</option>)}
        <option value="__other">Another inbox…</option>
      </select>
      {inbox === '__other' && (
        <input value={other} onChange={(e) => setOther(e.target.value)} placeholder="name@almondvalleyaccounting.co.uk" style={{ ...input, marginTop: 6 }} />
      )}

      <Label style={{ marginTop: 12 }}>Note (optional)</Label>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. who replied" style={input} />

      {error && <p style={{ fontSize: 12.5, color: '#b91c1c', margin: '12px 0 0' }}>{error}</p>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button onClick={onClose} disabled={busy} style={BTN.secondary.md}>Cancel</button>
        <button onClick={submit} disabled={!ok || busy} style={{ ...BTN.primary.md, opacity: ok ? 1 : 0.5, cursor: ok ? 'pointer' : 'not-allowed' }}>
          {busy ? 'Recording…' : 'Record acceptance'}
        </button>
      </div>
    </Shell>
  );
}

// Declined by the client, or withdrawn by us. Removing the staged fees is
// the usual next step for a decline, so it defaults on there.
export function CloseProposalDialog({ proposal, mode, clientName, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [clear, setClear] = useState(mode === 'decline');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const title = mode === 'decline' ? 'Client declined' : 'Withdraw';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await call({ action: mode, proposal_id: proposal.id, note: note.trim() || null, clear_pending: clear });
      onDone?.();
      onClose();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title={`${title} — ${clientName}`} onClose={onClose}>
      <Label>Note (optional)</Label>
      <input value={note} onChange={(e) => setNote(e.target.value)} style={input} />
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginTop: 12, cursor: 'pointer' }}>
        <input type="checkbox" checked={clear} onChange={(e) => setClear(e.target.checked)} />
        Remove the staged new fees (the current fees stay)
      </label>
      {error && <p style={{ fontSize: 12.5, color: '#b91c1c', margin: '12px 0 0' }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button onClick={onClose} disabled={busy} style={BTN.secondary.md}>Cancel</button>
        <button onClick={submit} disabled={busy} style={BTN.danger.md}>{busy ? 'Saving…' : title}</button>
      </div>
    </Shell>
  );
}

function Shell({ title, onClose, children }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 120, fontFamily: font, padding: 16 }} onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 12, width: 480, maxWidth: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid #e5e7eb' }}>
          <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 500, color: '#0f172a', margin: 0 }}>{title}</h2>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }} aria-label="Close"><X size={18} /></button>
        </div>
        <div style={{ padding: 18 }}>{children}</div>
      </div>
    </div>
  );
}

const Label = ({ children, style }) => <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 5, ...style }}>{children}</div>;
const input = { padding: '7px 10px', fontSize: 14, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#0f172a', outline: 'none', width: '100%', boxSizing: 'border-box' };
