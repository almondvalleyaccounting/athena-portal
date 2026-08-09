import React, { useEffect, useState } from 'react';
import { X, ExternalLink } from 'lucide-react';
import { fmtGbp, fmtGbpDetailed } from '../../lib/money';
import { fetchSchemeDetail } from './hmrcApi';
import {
  font, TIERS, Pill, shortDate, dateTime, ageLabel,
  th, td, thNum, tdNum, card,
} from './hmrcShared';

// Slide-over showing everything the scrape holds for one PAYE scheme. This is
// the answer to "why does HMRC say they owe that?" — without it the debt figure
// is unarguable-with, and you cannot open a conversation with a client on a
// number you cannot break down.

const MONTH_NAMES = ['', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];

export default function SchemeDetailPanel({ scheme, onClose }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  // The scrape widened from the current tax year to seven, so the monthly grid
  // is now a year at a time rather than one flat list.
  const [year, setYear] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    fetchSchemeDetail(scheme.paye_ref)
      .then((d) => { if (!cancelled) { setDetail(d); setError(''); } })
      .catch((e) => { if (!cancelled) setError(e.message || 'Could not load scheme detail'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scheme.paye_ref]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tier = TIERS[scheme.chase_tier] || TIERS[4];
  const monthly = (detail?.overdue || []).filter((o) => o.section === 'monthly');
  const additional = (detail?.overdue || []).filter((o) => o.section === 'additional');

  const years = [...new Set((detail?.months || []).map((m) => m.tax_year))].sort().reverse();
  const shownYear = year && years.includes(year) ? year : years[0];
  const monthRows = (detail?.months || [])
    .filter((m) => m.tax_year === shownYear)
    .sort((a, b) => a.tax_month - b.tax_month);
  const yearTotal = monthRows.reduce((t, m) => ({
    charges: t.charges + Number(m.charges || 0),
    credits: t.credits + Number(m.credits || 0),
    payments: t.payments + Number(m.payments || 0),
    amount_due: t.amount_due + Number(m.amount_due || 0),
  }), { charges: 0, credits: 0, payments: 0, amount_due: 0 });

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.35)', zIndex: 60 }}
      />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(760px, 94vw)',
        background: '#fff', zIndex: 61, boxShadow: '-8px 0 32px rgba(15,23,42,0.18)',
        display: 'flex', flexDirection: 'column', fontFamily: font,
      }}>
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, fontWeight: 500, color: '#0f172a', margin: 0 }}>
                  {scheme.entity_name || scheme.hmrc_name}
                </h2>
                <Pill colour={tier.colour} bg={tier.bg} title={tier.hint}>{tier.label}</Pill>
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                {/* HMRC's name for the scheme often differs from ours — showing
                    both saves a second lookup when you ring them. */}
                {scheme.entity_name && scheme.hmrc_name !== scheme.entity_name && (
                  <>HMRC hold this as <b>{scheme.hmrc_name}</b> · </>
                )}
                PAYE ref <b>{scheme.paye_ref}</b>
                {scheme.accounts_office_ref && <> · Accounts Office <b>{scheme.accounts_office_ref}</b></>}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3 }}>
                Scraped {dateTime(scheme.scraped_at)} · tax year {scheme.tax_year || '—'}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              {scheme.entity_id && (
                <a
                  href={`/clients/${scheme.entity_id}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#0e7fe0', textDecoration: 'none' }}
                >
                  Client <ExternalLink size={11} />
                </a>
              )}
              <button
                onClick={onClose}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4, lineHeight: 0 }}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
          </div>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', padding: '16px 20px 40px', flex: 1 }}>
          {error && (
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: 8, padding: '8px 12px', fontSize: 12, marginBottom: 12 }}>
              {error}
            </div>
          )}

          {/* Position summary */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 18 }}>
            <Figure label="Total owed" value={fmtGbpDetailed(scheme.total_debt)} colour="#b91c1c" big />
            <Figure label="Accruing interest" value={fmtGbpDetailed(scheme.accruing_interest)} colour="#c2410c" />
            <Figure label="Overdue — monthly" value={fmtGbpDetailed(scheme.overdue_monthly)} colour="#64748b" />
            <Figure label="Overdue — other" value={fmtGbpDetailed(scheme.overdue_additional)} colour="#64748b" />
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
            {scheme.payment_plan && <Pill colour="#0369a1" bg="#f0f9ff" title="HMRC has a time-to-pay arrangement in place">Payment plan</Pill>}
            {scheme.variable_dd && <Pill colour="#059669" bg="#f0fdf4" title="Paying by variable direct debit">Variable DD</Pill>}
            {scheme.claiming_ea && <Pill colour="#7c3aed" bg="#faf5ff" title="Employment Allowance is being claimed against this scheme">Employment Allowance</Pill>}
            {scheme.penalty_items > 0 && (
              <Pill colour="#b91c1c" bg="#fef2f2" title="Late-filing or late-payment penalties are among the overdue charges">
                {scheme.penalty_items} penalt{scheme.penalty_items === 1 ? 'y' : 'ies'} · {fmtGbp(scheme.penalties)}
              </Pill>
            )}
            {scheme.oldest_due_date && (
              <Pill colour="#475569" title={`Oldest unpaid charge was due ${shortDate(scheme.oldest_due_date)}`}>
                Oldest arrears {ageLabel(scheme.days_oldest_overdue)}
              </Pill>
            )}
          </div>

          {loading ? (
            <div style={{ color: '#94a3b8', fontSize: 13, padding: 24 }}>Loading scheme detail…</div>
          ) : (
            <>
              <Block
                title="Overdue — monthly PAYE bills"
                subtitle={monthly.length
                  ? `${monthly.length} unpaid month${monthly.length === 1 ? '' : 's'}, oldest first`
                  : 'No overdue monthly bills'}
              >
                {monthly.length > 0 && <OverdueTable rows={monthly} />}
              </Block>

              {additional.length > 0 && (
                <Block
                  title="Overdue — other charges"
                  subtitle="Penalties, interest and one-off charges outside the monthly cycle"
                >
                  <OverdueTable rows={additional} />
                </Block>
              )}

              <Block
                title="Monthly position"
                subtitle={years.length
                  ? 'What was charged, what was relieved by credits, what has been paid'
                  : 'No monthly rows scraped for this scheme'}
                aside={years.length > 1 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {years.map((y) => (
                      <button
                        key={y}
                        onClick={() => setYear(y)}
                        style={{
                          padding: '3px 9px', fontSize: 11, fontFamily: font, borderRadius: 999,
                          cursor: 'pointer', whiteSpace: 'nowrap',
                          fontWeight: y === shownYear ? 600 : 500,
                          color: y === shownYear ? '#0f172a' : '#94a3b8',
                          background: y === shownYear ? '#f1f5f9' : '#fff',
                          border: `1px solid ${y === shownYear ? '#cbd5e1' : '#e5e7eb'}`,
                        }}
                      >
                        {y}
                      </button>
                    ))}
                  </div>
                )}
              >
                {monthRows.length > 0 && (
                  <table style={tableStyle}>
                    <thead>
                      <tr style={headRow}>
                        <th style={th}>Month</th>
                        <th style={thNum}>Charged</th>
                        <th style={thNum}>Credits</th>
                        <th style={thNum}>Paid</th>
                        <th style={thNum}>Still due</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthRows.map((m) => (
                        <tr key={m.id} style={{ borderTop: '1px solid #f1f5f9', background: m.overdue ? '#fef2f2' : undefined }}>
                          <td style={td}>
                            <span style={{ fontWeight: 500 }}>{MONTH_NAMES[m.tax_month] || `M${m.tax_month}`}</span>
                            <span style={{ color: '#94a3b8', fontSize: 11, marginLeft: 6 }}>month {m.tax_month}</span>
                          </td>
                          <td style={tdNum}>{fmtGbpDetailed(m.charges)}</td>
                          <td style={{ ...tdNum, color: m.credits > 0 ? '#059669' : '#cbd5e1' }}>
                            {m.credits > 0 ? `-${fmtGbpDetailed(m.credits)}` : '—'}
                          </td>
                          <td style={tdNum}>{m.payments > 0 ? fmtGbpDetailed(m.payments) : '—'}</td>
                          <td style={{ ...tdNum, fontWeight: m.amount_due > 0 ? 600 : 400, color: m.amount_due > 0 ? '#b91c1c' : '#94a3b8' }}>
                            {m.amount_due > 0 ? fmtGbpDetailed(m.amount_due) : '—'}
                          </td>
                        </tr>
                      ))}
                      <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f8fafc' }}>
                        <td style={{ ...td, fontWeight: 600, fontSize: 12 }}>{shownYear} total</td>
                        <td style={{ ...tdNum, fontWeight: 600 }}>{fmtGbpDetailed(yearTotal.charges)}</td>
                        <td style={{ ...tdNum, fontWeight: 600, color: yearTotal.credits > 0 ? '#059669' : '#cbd5e1' }}>
                          {yearTotal.credits > 0 ? `-${fmtGbpDetailed(yearTotal.credits)}` : '—'}
                        </td>
                        <td style={{ ...tdNum, fontWeight: 600 }}>{fmtGbpDetailed(yearTotal.payments)}</td>
                        <td style={{ ...tdNum, fontWeight: 700, color: yearTotal.amount_due > 0 ? '#b91c1c' : '#94a3b8' }}>
                          {fmtGbpDetailed(yearTotal.amount_due)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </Block>

              <Block
                title="Payments HMRC has received"
                subtitle={detail?.payments?.length
                  ? 'Most recent first, with the month HMRC allocated each one to'
                  : 'No payments recorded against this scheme in the scraped year'}
              >
                {detail?.payments?.length > 0 && (
                  <table style={tableStyle}>
                    <thead>
                      <tr style={headRow}>
                        <th style={th}>Received</th>
                        <th style={th}>Allocated to</th>
                        <th style={thNum}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.payments.map((p) => (
                        <tr key={p.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                          <td style={{ ...td, whiteSpace: 'nowrap' }}>{p.received_on_text}</td>
                          <td style={{ ...td, fontSize: 12, color: '#475569' }}>
                            {/* An unallocated payment is worth spotting: it is
                                sitting on the scheme not reducing any bill. */}
                            {p.allocated_to
                              ? p.allocated_to
                              : <span style={{ color: '#c2410c', fontWeight: 500 }}>Unallocated</span>}
                          </td>
                          <td style={tdNum}>{fmtGbpDetailed(p.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Block>

              <Block
                title="Credits applied"
                subtitle={detail?.credits?.length
                  ? 'Employment Allowance, statutory pay recovery, CIS suffered and early-payment interest'
                  : 'No credits applied to this scheme'}
              >
                {detail?.credits?.length > 0 && (
                  <table style={tableStyle}>
                    <thead>
                      <tr style={headRow}>
                        <th style={th}>Type</th>
                        <th style={th}>Applied to</th>
                        <th style={thNum}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.credits.map((c) => (
                        <tr key={c.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                          <td style={{ ...td, fontSize: 12 }}>{c.credit_type}</td>
                          <td style={{ ...td, fontSize: 12, color: '#475569' }}>{c.allocated_to || '—'}</td>
                          <td style={{ ...tdNum, color: '#059669' }}>{fmtGbpDetailed(c.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Block>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function OverdueTable({ rows }) {
  return (
    <table style={tableStyle}>
      <thead>
        <tr style={headRow}>
          <th style={th}>Period</th>
          <th style={th}>Due</th>
          <th style={th}>Type</th>
          <th style={thNum}>Interest</th>
          <th style={thNum}>Amount</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((o) => (
          <tr key={o.id} style={{ borderTop: '1px solid #f1f5f9' }}>
            <td style={{ ...td, fontSize: 12, color: '#475569' }}>{o.period}</td>
            <td style={{ ...td, whiteSpace: 'nowrap', fontSize: 12 }}>{o.due_date_text}</td>
            <td style={{ ...td, fontSize: 12 }}>
              {o.charge_type === 'Penalty'
                ? <span style={{ color: '#b91c1c', fontWeight: 600 }}>{o.charge_type}</span>
                : <span style={{ color: '#64748b' }}>{o.charge_type || '—'}</span>}
            </td>
            <td style={{ ...tdNum, color: o.interest > 0 ? '#c2410c' : '#cbd5e1' }}>
              {o.interest > 0 ? fmtGbpDetailed(o.interest) : '—'}
            </td>
            <td style={{ ...tdNum, fontWeight: 600 }}>{fmtGbpDetailed(o.amount_due)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Block({ title, subtitle, aside, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{title}</div>
        {aside}
      </div>
      {subtitle && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, marginBottom: 8 }}>{subtitle}</div>}
      {children && <div style={{ ...card, marginTop: 6 }}>{children}</div>}
    </div>
  );
}

function Figure({ label, value, colour, big }) {
  return (
    <div style={{ background: '#f8fafc', borderRadius: 8, padding: '9px 11px', borderLeft: `3px solid ${colour}` }}>
      <div style={{ fontSize: 9, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: big ? 20 : 15, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>{value}</div>
    </div>
  );
}

const tableStyle = { width: '100%', fontSize: 13, borderCollapse: 'collapse' };
const headRow = {
  background: '#f8fafc', fontSize: 10, textTransform: 'uppercase',
  letterSpacing: 0.5, color: '#64748b',
};
