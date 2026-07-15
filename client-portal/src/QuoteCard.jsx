import React, { useState } from 'react';
import { theme as t } from './theme';
import { resolveService } from './services';

/*
  Client-facing read view of the quote attached to the onboarding.
  Data comes from portal_my_onboarding()'s `quote` block — only quotes the
  client has actually been sent (sent / accepted / committed) are exposed.
*/

const QUOTE_STATUS = {
  sent: { label: 'Sent to you', bg: '#fef3c7', fg: '#92400e' },
  accepted: { label: 'Accepted ✓', bg: '#dcfce7', fg: '#166534' },
  committed: { label: 'Confirmed & live ✓', bg: '#dcfce7', fg: '#166534' },
};

const gbp = (n) => {
  const v = Number(n);
  const dp = Number.isInteger(v) ? 0 : 2;
  return `£${v.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
};

export default function QuoteCard({ quote, delay = 0 }) {
  const [open, setOpen] = useState(false);
  if (!quote) return null;
  const status = QUOTE_STATUS[quote.status] || QUOTE_STATUS.sent;
  const items = quote.line_items || [];

  return (
    <div className="fade-up" style={{ animationDelay: `${delay}ms`, border: `1px solid ${t.border}`, borderRadius: 16, background: '#fff', overflow: 'hidden' }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ padding: '16px 18px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}
      >
        <span style={{ fontSize: 22 }}>📋</span>
        <div style={{ flex: '1 1 160px' }}>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: t.navy }}>
            Your quote {quote.ref ? <span style={{ color: t.faint, fontWeight: 500 }}>· {quote.ref}</span> : null}
          </div>
          <div style={{ fontSize: 12.5, color: t.muted, marginTop: 2 }}>
            {quote.monthly_gross > 0 && <strong style={{ color: t.text }}>{gbp(quote.monthly_gross)}/month</strong>}
            {quote.monthly_gross > 0 && ' incl. VAT'}
            {quote.one_off_total > 0 && `${quote.monthly_gross > 0 ? ' · ' : ''}${gbp(quote.one_off_total)} one-off setup`}
          </div>
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 999, background: status.bg, color: status.fg, whiteSpace: 'nowrap' }}>
          {status.label}
        </span>
        <span style={{ color: t.faint, fontSize: 13, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.25s ease' }}>▾</span>
      </div>

      {open && (
        <div style={{ borderTop: `1px solid ${t.border}`, padding: '4px 18px 16px' }}>
          {items.map((li, i) => {
            const s = resolveService(li.service_id);
            return (
              <div key={i} style={{ display: 'flex', gap: 10, padding: '11px 0', borderBottom: i < items.length - 1 ? `1px solid #f1f5f9` : 'none', alignItems: 'flex-start' }}>
                <span style={{ fontSize: 17, lineHeight: '20px' }}>{s.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: t.text }}>{li.description || s.title}</div>
                  {li.detail && <div style={{ fontSize: 12, color: t.muted, marginTop: 2, lineHeight: 1.5 }}>{li.detail}</div>}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: t.navy, whiteSpace: 'nowrap' }}>
                  {li.monthly_amount > 0 ? `${gbp(li.monthly_amount)}/mo`
                    : li.annual_amount > 0 ? `${gbp(li.annual_amount)}/yr`
                    : 'included'}
                </div>
              </div>
            );
          })}
          <div style={{ marginTop: 12, background: '#f8fafc', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 5 }}>
            {quote.monthly_net > 0 && (
              <Row label="Monthly total" value={`${gbp(quote.monthly_net)} + VAT = ${gbp(quote.monthly_gross)}`} strong />
            )}
            {quote.annual_total > 0 && <Row label="Annual value of services" value={gbp(quote.annual_total)} />}
            {quote.one_off_total > 0 && <Row label="One-off setup" value={gbp(quote.one_off_total)} />}
            {quote.valid_until && quote.status === 'sent' && (
              <Row label="Quote valid until" value={new Date(quote.valid_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} />
            )}
          </div>
          <div style={{ fontSize: 12, color: t.faint, marginTop: 10, lineHeight: 1.5 }}>
            Question about your quote? Use “Message us” on any step, or reply to one of our emails.
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, strong }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: strong ? 13.5 : 12.5 }}>
      <span style={{ color: t.muted }}>{label}</span>
      <span style={{ color: t.text, fontWeight: strong ? 700 : 600, textAlign: 'right' }}>{value}</span>
    </div>
  );
}
