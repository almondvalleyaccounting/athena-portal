// AcceptQuotePage — client-facing quote acceptance surface.
// Rendered OUTSIDE AppShell: no sidebar, no topbar, no internal portal nav.
// Public (unauthenticated). All auth is via the signed token in the URL.
//
// Flow:
//   1. Read ?token= from URL
//   2. Call verify-accept-token → either quote summary or error
//   3. User clicks Accept → call accept-quote → show thank-you
//
// States: loading | verify_error | ready | already_accepted | accepting | accepted | accept_error
import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';

function formatGBP(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '\u00A30.00';
  return '\u00A3' + v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDateGB(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: '#fafafa', padding: '40px 16px', fontFamily: "'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif", color: '#1e293b' }}>
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, justifyContent: 'center' }}>
          <img src="/ava-logo.jpg" alt="Almond Valley Accounting" style={{ width: 44, height: 44, borderRadius: 8 }} />
          <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '0.08em', color: '#1a1a2e' }}>ALMOND VALLEY ACCOUNTING</span>
        </div>
        {children}
        <div style={{ marginTop: 32, textAlign: 'center', fontSize: 11, color: '#94a3b8' }}>
          If you have any questions, reply to the email we sent you or contact us at
          {' '}
          <a href="mailto:accounts@almondvalleyaccounting.co.uk" style={{ color: '#64748b' }}>
            accounts@almondvalleyaccounting.co.uk
          </a>
          .
        </div>
      </div>
    </div>
  );
}

function Card({ children }) {
  return (
    <div style={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 32 }}>
      {children}
    </div>
  );
}

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

function SummaryTable({ quote }) {
  // annual_total is NET. It used to be labelled "inc VAT", which left clients
  // unable to reconcile it against the monthly Direct Debit and asking whether
  // we collect over 10 months or charge interest over 12. Show net, VAT and
  // gross as separate lines, with the gross derived from the DD so 12 x DD ties.
  const monthlyGross = money(quote.monthly_gross);
  const annualNet = money(quote.annual_total);
  const annualGross = money(monthlyGross * 12);
  const rows = [
    ['Reference', quote.quote_ref],
    ['Client', quote.relationship_group || '—'],
    ['Annual total (net)', formatGBP(annualNet)],
    ['VAT at 20%', formatGBP(money(annualGross - annualNet))],
    ['Annual total (inc VAT)', formatGBP(annualGross)],
    ['Monthly Direct Debit (inc VAT)', formatGBP(monthlyGross)],
  ];
  if (quote.valid_until) rows.push(['Valid until', formatDateGB(quote.valid_until)]);
  const bold = (k) => k.startsWith('Monthly') || k === 'Annual total (inc VAT)';
  return (
    <>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 16 }}>
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={k} style={{ borderTop: i === 0 ? 'none' : '1px solid #f1f5f9' }}>
              <td style={{ padding: '10px 0', color: '#64748b' }}>{k}</td>
              <td style={{ padding: '10px 0', color: '#0f172a', textAlign: 'right', fontWeight: bold(k) ? 600 : 400 }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {monthlyGross > 0 && (
        <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.5, marginTop: 10 }}>
          Collected in <strong>12 equal monthly instalments</strong> by Direct Debit:
          12 × {formatGBP(monthlyGross)} = {formatGBP(annualGross)}, the annual total including VAT.
          No interest, credit charge or instalment fee is added for paying monthly.
        </div>
      )}
    </>
  );
}

// Group summary: one row per company + a group total. Full per-service
// detail is in the attached PDF.
function GroupSummaryTable({ group }) {
  const companies = group.companies || [];
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 13, color: '#64748b', marginBottom: 8 }}>
        {group.name} · {group.company_count} {group.company_count === 1 ? 'company' : 'companies'}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
        <thead>
          <tr style={{ background: '#f8fafc' }}>
            <th style={{ textAlign: 'left', padding: '8px 12px', color: '#94a3b8', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>Company</th>
            <th style={{ textAlign: 'right', padding: '8px 12px', color: '#94a3b8', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>Monthly DD (inc VAT)</th>
            <th style={{ textAlign: 'right', padding: '8px 12px', color: '#94a3b8', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>Annual (net)</th>
          </tr>
        </thead>
        <tbody>
          {companies.map((c, i) => (
            <tr key={i} style={{ borderTop: '1px solid #f1f5f9' }}>
              <td style={{ padding: '10px 12px', color: '#0f172a' }}>{c.relationship_group || c.quote_ref}</td>
              <td style={{ padding: '10px 12px', color: '#0f172a', textAlign: 'right' }}>{formatGBP(c.monthly_gross)}</td>
              <td style={{ padding: '10px 12px', color: '#0f172a', textAlign: 'right' }}>{formatGBP(c.annual_total)}</td>
            </tr>
          ))}
          <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f8fafc' }}>
            <td style={{ padding: '10px 12px', color: '#0f172a', fontWeight: 700 }}>Group total</td>
            <td style={{ padding: '10px 12px', color: '#0f172a', textAlign: 'right', fontWeight: 700 }}>{formatGBP(group.monthly_gross)}</td>
            <td style={{ padding: '10px 12px', color: '#0f172a', textAlign: 'right', fontWeight: 700 }}>{formatGBP(group.annual_total)}</td>
          </tr>
        </tbody>
      </table>
      <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.5, marginTop: 10 }}>
        Collected in <strong>12 equal monthly instalments</strong> by Direct Debit:
        12 × {formatGBP(money(group.monthly_gross))} = {formatGBP(money(money(group.monthly_gross) * 12))} a year
        including VAT ({formatGBP(money(group.annual_total))} net plus VAT at 20%).
        No interest, credit charge or instalment fee is added for paying monthly.
      </div>
      {group.valid_until && (
        <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 8 }}>Valid until {formatDateGB(group.valid_until)}</div>
      )}
    </div>
  );
}

export default function AcceptQuotePage() {
  const [params] = useSearchParams();
  const token = params.get('token');

  const [phase, setPhase] = useState('loading'); // loading|verify_error|ready|already_accepted|accepting|accepted|accept_error
  const [quote, setQuote] = useState(null);
  const [group, setGroup] = useState(null); // set when the link is a group quote
  const [recipientEmail, setRecipientEmail] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [acceptedAt, setAcceptedAt] = useState(null);

  useEffect(() => {
    if (!token) {
      setPhase('verify_error');
      setErrorMsg('This link is missing its token. Please use the link in your email.');
      return;
    }
    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke('verify-accept-token', {
          body: { token },
        });
        if (error) {
          let detail = 'This link is invalid or has expired.';
          try {
            const resp = await error.context?.response?.clone().json();
            if (resp?.error === 'invalid_or_expired') detail = 'This link is invalid or has expired. Please contact us to request a new quote.';
            else if (resp?.error === 'quote_not_found') detail = 'We could not find the quote for this link. Please contact us.';
          } catch { /* ignore */ }
          setErrorMsg(detail);
          setPhase('verify_error');
          return;
        }
        if (!data?.ok) {
          setErrorMsg('This link is invalid or has expired.');
          setPhase('verify_error');
          return;
        }
        setRecipientEmail(data.recipient_email);
        if (data.is_group) {
          setGroup(data.group);
          if (data.already_accepted) {
            setAcceptedAt(data.group.accepted_at);
            setPhase('already_accepted');
          } else {
            setPhase('ready');
          }
        } else {
          setQuote(data.quote);
          if (data.already_accepted) {
            setAcceptedAt(data.quote.accepted_at);
            setPhase('already_accepted');
          } else {
            setPhase('ready');
          }
        }
      } catch (e) {
        setErrorMsg(e?.message || 'Something went wrong.');
        setPhase('verify_error');
      }
    })();
  }, [token]);

  const handleAccept = async () => {
    setPhase('accepting');
    setErrorMsg('');
    try {
      const { data, error } = await supabase.functions.invoke('accept-quote', {
        body: { token },
      });
      if (error) {
        let detail = 'We could not record your acceptance. Please try again or contact us.';
        try {
          const resp = await error.context?.response?.clone().json();
          if (resp?.error) detail = resp.error;
        } catch { /* ignore */ }
        setErrorMsg(detail);
        setPhase('accept_error');
        return;
      }
      if (!data?.ok) {
        setErrorMsg(data?.error || 'Could not record your acceptance.');
        setPhase('accept_error');
        return;
      }
      setAcceptedAt(data.accepted_at);
      setPhase('accepted');
    } catch (e) {
      setErrorMsg(e?.message || 'Something went wrong.');
      setPhase('accept_error');
    }
  };

  // RENDER -----------------------------------------------------------

  const renderSummary = () => (group ? <GroupSummaryTable group={group} /> : <SummaryTable quote={quote} />);
  const companyCount = group?.company_count || 0;

  if (phase === 'loading') {
    return <Shell><Card><div style={{ textAlign: 'center', color: '#64748b', fontSize: 14 }}>Loading your quote…</div></Card></Shell>;
  }

  if (phase === 'verify_error') {
    return (
      <Shell>
        <Card>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 24, fontWeight: 500, color: '#0f172a', margin: 0 }}>Link unavailable</h1>
          <p style={{ fontSize: 14, color: '#64748b', marginTop: 12, lineHeight: 1.6 }}>{errorMsg}</p>
        </Card>
      </Shell>
    );
  }

  if (phase === 'already_accepted') {
    return (
      <Shell>
        <Card>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 24, fontWeight: 500, color: '#0f172a', margin: 0 }}>{group ? 'Group quote already accepted' : 'Quote already accepted'}</h1>
          <p style={{ fontSize: 14, color: '#64748b', marginTop: 12, lineHeight: 1.6 }}>
            {group ? 'This group quote' : 'This quote'} was accepted on {formatDateGB(acceptedAt) || 'a previous date'}. Our team has been notified and will be in touch with next steps.
          </p>
          {renderSummary()}
        </Card>
      </Shell>
    );
  }

  if (phase === 'accepted') {
    return (
      <Shell>
        <Card>
          <div style={{ textAlign: 'center', padding: '8px 0 20px' }}>
            <div style={{ width: 48, height: 48, margin: '0 auto 16px', borderRadius: '50%', background: '#38bdf815', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>✓</div>
            <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', margin: 0 }}>Thank you</h1>
            <p style={{ fontSize: 14, color: '#64748b', marginTop: 12, lineHeight: 1.6 }}>
              Your acceptance has been recorded on {formatDateGB(acceptedAt)}. We will be in touch shortly to finalise the engagement.
            </p>
          </div>
          {renderSummary()}
        </Card>
      </Shell>
    );
  }

  // ready OR accepting OR accept_error — single render with state-driven button
  return (
    <Shell>
      <Card>
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', margin: 0 }}>{group ? 'Your group quote' : 'Your quote'}</h1>
        <p style={{ fontSize: 14, color: '#64748b', marginTop: 8, marginBottom: 0, lineHeight: 1.6 }}>
          {group
            ? <>This is the summary of the group quote sent to {recipientEmail ? <strong style={{ color: '#0f172a' }}>{recipientEmail}</strong> : 'you'}, covering {companyCount} {companyCount === 1 ? 'company' : 'companies'}. The full PDF is attached to the email. Accepting confirms the quote for every company in the group.</>
            : <>This is the summary of the quote sent to {recipientEmail ? <strong style={{ color: '#0f172a' }}>{recipientEmail}</strong> : 'you'}. The full PDF is attached to the email. Click accept to confirm and we will begin the engagement.</>}
        </p>
        {renderSummary()}
        <div style={{ marginTop: 24 }}>
          <button
            onClick={handleAccept}
            disabled={phase === 'accepting'}
            style={{
              width: '100%',
              background: phase === 'accepting' ? '#94a3b8' : '#0f172a',
              color: '#ffffff',
              border: 'none',
              padding: '14px 18px',
              fontSize: 14,
              fontWeight: 600,
              borderRadius: 10,
              cursor: phase === 'accepting' ? 'default' : 'pointer',
              fontFamily: 'inherit',
              transition: 'all 0.2s ease',
            }}
          >
            {phase === 'accepting'
              ? 'Recording your acceptance…'
              : group
                ? `Accept for all ${companyCount} ${companyCount === 1 ? 'company' : 'companies'}`
                : 'Accept this quote'}
          </button>
          {phase === 'accept_error' && (
            <div style={{ marginTop: 12, padding: 10, background: '#fef2f2', color: '#b91c1c', fontSize: 12, borderRadius: 8 }}>
              {errorMsg}
            </div>
          )}
          <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 10, textAlign: 'center' }}>
            By accepting you agree to the services and fees set out in the attached quote PDF.
          </p>
        </div>
      </Card>
    </Shell>
  );
}
