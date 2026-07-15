import React, { useState } from 'react';
import { theme as t } from './theme';
import { SERVICE_CONTENT, resolveService } from './services';

/*
  Two halves:
  1. "Your services with us" — what's on their quote / QBO billing.
  2. "Anything else you need?" — the rest of the catalogue with indicative
     from-prices (portal_service_catalogue), each requestable in two taps
     (portal_request_service → staff notified, request logged).
*/

// Add-ons we're happy to advertise; setup_* are one-off onboarding services.
const OFFERABLE = [
  'accounts_ct', 'bookkeeping_vat', 'vat_returns', 'payroll', 'auto_enrolment',
  'directors_tax_return', 'confirmation_statement', 'software_accounting',
  'management_accounts', 'review_meetings', 'registered_office', 'modulr',
];

function priceLabel(entry) {
  if (!entry) return 'priced for you';
  if (entry.from_monthly != null) {
    return entry.unit ? `from £${entry.from_monthly} ${entry.unit}` : `from £${entry.from_monthly}/mo`;
  }
  if (entry.from_annual != null) return `from £${entry.from_annual}/yr`;
  return 'priced for you';
}

export default function ServicesSection({ services, catalogue, requests, onRequest, delay = 0 }) {
  const have = new Set(
    (services || []).map((sid) => {
      const resolved = resolveService(sid);
      // Map billing display-names back onto catalogue keys via title match
      const key = Object.keys(SERVICE_CONTENT).find((k) => SERVICE_CONTENT[k] === resolved);
      return key || sid;
    }),
  );
  // software / software_accounting are the same thing to a client
  if (have.has('software')) have.add('software_accounting');

  const requested = new Set((requests || []).map((r) => r.service_id));
  const offer = OFFERABLE.filter((id) => !have.has(id));
  const catalogueMap = Object.fromEntries((catalogue || []).map((c) => [c.service_id, c]));

  return (
    <>
      {(services || []).length > 0 && (
        <div style={{ marginTop: 26 }}>
          <div className="fade-up" style={{ fontSize: 14, fontWeight: 700, color: t.text, marginBottom: 4, animationDelay: `${delay}ms` }}>
            Your services with us
          </div>
          <div className="fade-up" style={{ fontSize: 12.5, color: t.muted, marginBottom: 12, animationDelay: `${delay + 20}ms` }}>
            Tap any service to see what it covers — and what we need from you.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {services.map((sid, i) => <HaveCard key={sid} id={sid} delay={delay + 40 + i * 60} />)}
          </div>
        </div>
      )}

      {offer.length > 0 && (
        <div style={{ marginTop: 26 }}>
          <div className="fade-up" style={{ fontSize: 14, fontWeight: 700, color: t.text, marginBottom: 4, animationDelay: `${delay + 60}ms` }}>
            Anything else you need?
          </div>
          <div className="fade-up" style={{ fontSize: 12.5, color: t.muted, marginBottom: 12, animationDelay: `${delay + 80}ms` }}>
            Tap a service and we'll come back with a tailored quote — no obligation.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
            {offer.map((id, i) => (
              <OfferCard
                key={id} id={id} entry={catalogueMap[id]}
                alreadyRequested={requested.has(id)} onRequest={onRequest}
                delay={delay + 100 + i * 40}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function HaveCard({ id, delay }) {
  const [open, setOpen] = useState(false);
  const s = resolveService(id);
  return (
    <div
      className="fade-up"
      onClick={() => setOpen((o) => !o)}
      style={{
        animationDelay: `${delay}ms`, cursor: 'pointer',
        border: `1px solid ${t.border}`, borderRadius: 14, padding: '14px 16px', background: '#fff',
        boxShadow: open ? '0 6px 20px rgba(30,69,96,0.10)' : 'none', transition: 'box-shadow 0.25s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 22 }}>{s.icon}</span>
        <span style={{ fontSize: 14.5, fontWeight: 600, color: t.navy, flex: 1 }}>{s.title}</span>
        <span style={{ color: t.faint, fontSize: 13, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.25s ease' }}>▾</span>
      </div>
      <div style={{
        maxHeight: open ? 300 : 0, overflow: 'hidden', opacity: open ? 1 : 0,
        transition: 'max-height 0.35s cubic-bezier(0.2, 0.7, 0.3, 1), opacity 0.3s ease',
      }}>
        <p style={{ fontSize: 13.5, color: t.text, lineHeight: 1.65, margin: '12px 0 8px' }}>{s.entails}</p>
        <p style={{ fontSize: 13, color: t.tealText, lineHeight: 1.6, margin: 0, background: t.tealSoft, borderRadius: 10, padding: '8px 12px' }}>
          <strong>From you:</strong> {s.needs}
        </p>
      </div>
    </div>
  );
}

function OfferCard({ id, entry, alreadyRequested, onRequest, delay }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const s = SERVICE_CONTENT[id];
  if (!s) return null;
  const sent = done || alreadyRequested;

  async function request() {
    setBusy(true);
    const ok = await onRequest(id, s.title, note.trim() || null);
    setBusy(false);
    if (ok) setDone(true);
  }

  return (
    <div className="fade-up" style={{
      animationDelay: `${delay}ms`,
      border: `1px solid ${sent ? '#bbf7d0' : t.border}`, borderRadius: 14,
      background: sent ? '#f7fdf9' : '#fff', padding: '12px 14px',
      gridColumn: open ? '1 / -1' : 'auto',
    }}>
      <div onClick={() => !sent && setOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: sent ? 'default' : 'pointer' }}>
        <span style={{ fontSize: 19 }}>{s.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>{s.title}</div>
          <div style={{ fontSize: 11.5, color: sent ? t.successText : t.tealText, fontWeight: 600, marginTop: 2 }}>
            {sent ? '✓ Requested — we’ll be in touch' : priceLabel(entry)}
          </div>
        </div>
        {!sent && <span style={{ color: t.faint, fontSize: 13, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.25s ease' }}>▾</span>}
      </div>

      {open && !sent && (
        <div style={{ marginTop: 10 }}>
          <p style={{ fontSize: 13, color: t.text, lineHeight: 1.6, margin: '0 0 10px' }}>{s.entails}</p>
          <textarea
            value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Anything useful — e.g. how many employees, when you'd like to start… (optional)"
            style={{ width: '100%', minHeight: 52, padding: '9px 12px', fontSize: 13.5, border: `1px solid ${t.border}`, borderRadius: 10, resize: 'vertical', boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={request} disabled={busy}
              style={{ fontSize: 13, fontWeight: 600, color: '#fff', background: t.navy, border: 'none', borderRadius: 10, padding: '9px 16px', cursor: 'pointer', minHeight: 38, opacity: busy ? 0.6 : 1 }}
            >
              {busy ? 'Sending…' : 'Request a quote'}
            </button>
            <span style={{ fontSize: 11.5, color: t.faint }}>Indicative pricing — we'll confirm before anything is charged.</span>
          </div>
        </div>
      )}
    </div>
  );
}
