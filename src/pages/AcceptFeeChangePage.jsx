// AcceptFeeChangePage — where a client accepts a fee proposal.
// Public and outside AppShell, like /accept-quote: the signed token in the
// URL is the only credential (fee-change-accept edge function).
//
// Shows what they were sent — Part 1 (changes to their fees, which go
// ahead anyway) and Part 2 (new services, which need their agreement) —
// and records acceptance with their name.
import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';

const gbp = (n) => `£${(Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const leaf = (s) => String(s || '').split(':').pop();

const ERRORS = {
  invalid_or_expired: 'This link has expired or is not valid. Please reply to our email and we will send you a new one.',
  not_found: 'We could not find this proposal. Please reply to our email and we will help.',
  no_longer_open: 'This proposal has been replaced or withdrawn, so it can no longer be accepted. Please check your email for the latest one.',
};

async function call(body) {
  const { data, error } = await supabase.functions.invoke('fee-change-accept', { body });
  if (data) return data;
  // A 4xx still carries our JSON body.
  try { return await error?.context?.json(); } catch { return { ok: false, error: 'network' }; }
}

export default function AcceptFeeChangePage() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [phase, setPhase] = useState('loading'); // loading | error | ready | accepting | accepted | already
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [acceptedAt, setAcceptedAt] = useState(null);

  useEffect(() => {
    (async () => {
      const r = await call({ action: 'view', token });
      if (!r?.ok) { setError(ERRORS[r?.error] || 'Something went wrong loading this page.'); setPhase('error'); return; }
      setData(r.proposal);
      if (r.status === 'accepted' || r.status === 'pushed') { setAcceptedAt(r.accepted_at); setPhase('already'); return; }
      if (r.status !== 'issued') { setError(ERRORS.no_longer_open); setPhase('error'); return; }
      setPhase('ready');
    })();
  }, [token]);

  const accept = async () => {
    setPhase('accepting');
    const r = await call({ action: 'accept', token, name, agree });
    if (!r?.ok) { setError(ERRORS[r?.error] || 'We could not record your acceptance. Please try again, or reply to our email.'); setPhase('ready'); return; }
    setAcceptedAt(r.accepted_at);
    setPhase(r.already_accepted ? 'already' : 'accepted');
  };

  if (phase === 'loading') return <Shell><Card><p style={muted}>Loading…</p></Card></Shell>;
  if (phase === 'error') return <Shell><Card><h1 style={h1}>Link unavailable</h1><p style={muted}>{error}</p></Card></Shell>;

  const p = data;
  const newServices = (p.lines || []).filter((l) => l.needs_acceptance);
  const feeChanges = (p.lines || []).filter((l) => !newServices.includes(l) && Number(l.current) !== Number(l.next));
  const s = p.summary || {};

  if (phase === 'accepted' || phase === 'already') {
    return (
      <Shell>
        <Card>
          <div style={{ textAlign: 'center' }}>
            <div style={{ width: 48, height: 48, margin: '0 auto 14px', borderRadius: '50%', background: '#dcfce7', color: '#166534', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26 }}>✓</div>
            <h1 style={h1}>{phase === 'accepted' ? 'Thank you' : 'Already accepted'}</h1>
            <p style={muted}>
              {phase === 'accepted' ? 'Your acceptance has been recorded' : 'This proposal was accepted'}{acceptedAt ? ` on ${longDate(acceptedAt)}` : ''}.
              {' '}The new fees start from {longDate(p.effective_at)}.
            </p>
          </div>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <Card>
        <h1 style={h1}>Proposed changes to your services</h1>
        <p style={muted}>{p.client_name} · new fees from {longDate(p.effective_at)}</p>

        {newServices.length > 0 && (
          <Section title="New services we are proposing" note="These need your agreement.">
            {newServices.map((l, i) => <Line key={i} l={l} />)}
          </Section>
        )}
        {feeChanges.length > 0 && (
          <Section title="Changes to your fees" note={`These go ahead from ${longDate(p.effective_at)} either way.`}>
            {feeChanges.map((l, i) => <Line key={i} l={l} />)}
          </Section>
        )}

        <div style={{ marginTop: 18, padding: '12px 14px', background: '#f4f8fb', borderRadius: 10, fontSize: 14 }}>
          <Row label="Current monthly fee" v={gbp(s.current)} />
          <Row label="New monthly fee if you accept (excl. VAT)" v={gbp(s.next)} bold />
          <Row label="Including VAT" v={gbp(s.gross)} />
        </div>

        <div style={{ marginTop: 22 }}>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 6 }}>Your full name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name"
            style={{ width: '100%', boxSizing: 'border-box', padding: '11px 12px', fontSize: 15, border: '1px solid #cbd5e1', borderRadius: 8, fontFamily: 'inherit' }} />
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 12, fontSize: 14, color: '#334155', cursor: 'pointer' }}>
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ marginTop: 3 }} />
            I accept the new services and fees set out above and in the attached letter.
          </label>
          {error && <p style={{ marginTop: 10, padding: 10, background: '#fef2f2', color: '#b91c1c', fontSize: 13, borderRadius: 8 }}>{error}</p>}
          <button onClick={accept} disabled={!agree || name.trim().length < 2 || phase === 'accepting'}
            style={{ marginTop: 16, width: '100%', padding: '14px 18px', fontSize: 15, fontWeight: 600, borderRadius: 10, border: 'none', fontFamily: 'inherit',
              background: !agree || name.trim().length < 2 ? '#94a3b8' : '#193a50', color: '#fff', cursor: !agree || name.trim().length < 2 ? 'default' : 'pointer' }}>
            {phase === 'accepting' ? 'Recording your acceptance…' : 'Accept'}
          </button>
        </div>
      </Card>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: '#f3f5f8', padding: '40px 16px', fontFamily: "'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif", color: '#1e293b' }}>
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, justifyContent: 'center' }}>
          <img src="/ava-logo.jpg" alt="Almond Valley Accounting" style={{ width: 44, height: 44, borderRadius: 8 }} />
          <span style={{ fontSize: 14.5, fontWeight: 600, letterSpacing: '0.08em', color: '#1a1a2e' }}>ALMOND VALLEY ACCOUNTING</span>
        </div>
        {children}
        <p style={{ marginTop: 28, textAlign: 'center', fontSize: 12, color: '#94a3b8' }}>
          Questions? Reply to our email or call 0141 471 4255.
        </p>
      </div>
    </div>
  );
}
const Card = ({ children }) => <div style={{ background: '#fff', border: '1px solid #e5e9ef', borderRadius: 14, padding: '26px 24px' }}>{children}</div>;
function Section({ title, note, children }) {
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#193a50' }}>{title}</div>
      <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 6 }}>{note}</div>
      {children}
    </div>
  );
}
function Line({ l }) {
  const d = Number(l.next) - Number(l.current);
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid #eef2f6', fontSize: 14 }}>
      <div>
        <div style={{ color: '#0f172a' }}>{leaf(l.service)}</div>
        {l.build && <div style={{ fontSize: 12, color: '#64748b' }}>{l.build}</div>}
        {!l.build && l.reason && <div style={{ fontSize: 12, color: '#64748b' }}>{l.reason}</div>}
      </div>
      <div style={{ textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        <div style={{ fontWeight: 600 }}>{gbp(l.next)}<span style={{ fontWeight: 400, color: '#94a3b8' }}> /mo</span></div>
        <div style={{ fontSize: 12, color: d > 0 ? '#9a5b17' : '#2f855a' }}>{d > 0 ? '+' : '−'}{gbp(Math.abs(d))}</div>
      </div>
    </div>
  );
}
const Row = ({ label, v, bold }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontWeight: bold ? 700 : 400 }}><span>{label}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</span></div>
);
const h1 = { fontFamily: "'Playfair Display', serif", fontSize: 25, fontWeight: 500, color: '#0f172a', margin: 0 };
const muted = { fontSize: 14.5, color: '#64748b', marginTop: 8, lineHeight: 1.6 };
