import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { resolveQuoteRecipients } from '../lib/quoteRecipients';
import { resolvePrimaryContact, firstNameOf } from '../modules/billing/recipients';
import { Btn } from './ui';

// A quote regularly goes to two directors, so both the To and CC boxes take a
// comma- or semicolon-separated list. The edge function splits them again
// server-side — this is only so the modal can validate and echo back what it
// is about to send.
const parseEmails = (raw) => {
  const seen = new Set();
  return String(raw || '')
    .split(/[,;]/)
    .map(e => e.trim())
    .filter(e => {
      if (!e) return false;
      const key = e.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

const gbp = (n) => `£${(Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// What the client receives for a single quote. The message box holds only the
// greeting — send-quote-email adds the table, the Direct Debit, the accept
// button and the sign-off — so without this the dialog looks like it is about
// to send an empty email. Mirrors renderEmailHtml in send-quote-email; change
// both together.
function SingleQuotePreview({ quote, lineItems, message, senderName }) {
  const monthlyGross = Number(quote.monthly_gross) || 0;
  const monthlyNet = round2((Number(quote.annual_total) || 0) / 12);
  const monthlyVat = round2(monthlyGross - monthlyNet);
  const annualGross = round2(monthlyGross * 12);
  const items = lineItems || [];
  const recurring = items.filter(l => l.is_recurring && Number(l.annual_amount) !== 0)
    .map(l => ({ label: l.description || 'Service', monthly: round2((Number(l.annual_amount) || 0) / 12) }));
  const oneOff = items.filter(l => !l.is_recurring && Number(l.annual_amount) !== 0);
  const gap = round2(monthlyNet - recurring.reduce((t, l) => t + l.monthly, 0));
  if (Math.abs(gap) >= 0.01 && recurring.length) recurring.push({ label: 'Adjustment', monthly: gap });
  const validUntil = quote.valid_until
    ? new Date(quote.valid_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';
  const paras = String(message || '').trim().split(/\n{2,}/).filter(Boolean);
  const cell = 'px-3 py-1.5 border-b border-gray-100';

  return (
    <div className="border border-gray-200 rounded-lg bg-gray-50 p-3 text-[13px] text-gray-800 space-y-3">
      <div className="text-[11px] font-semibold tracking-wider text-ocean-700 border-b-2 border-ocean-700 pb-1">
        ALMOND VALLEY ACCOUNTING
      </div>
      {paras.map((p, i) => <p key={i} className="whitespace-pre-line">{p}</p>)}
      <table className="w-full bg-white border border-gray-200 border-collapse">
        <thead>
          <tr className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500">
            <th className={`${cell} text-left font-semibold`}>Service</th>
            <th className={`${cell} text-right font-semibold`}>Per month</th>
          </tr>
        </thead>
        <tbody>
          {recurring.map((l, i) => (
            <tr key={i}><td className={cell}>{l.label}</td><td className={`${cell} text-right whitespace-nowrap`}>{gbp(l.monthly)}</td></tr>
          ))}
          <tr className="font-semibold"><td className={cell}>Monthly fee (excl. VAT)</td><td className={`${cell} text-right`}>{gbp(monthlyNet)}</td></tr>
          <tr className="text-gray-500"><td className={cell}>VAT at 20%</td><td className={`${cell} text-right`}>{gbp(monthlyVat)}</td></tr>
          <tr className="bg-ocean-700 text-white font-semibold"><td className="px-3 py-1.5">Monthly Direct Debit</td><td className="px-3 py-1.5 text-right">{gbp(monthlyGross)}</td></tr>
        </tbody>
      </table>
      <p className="text-[11px] text-gray-500 -mt-1">
        12 equal monthly payments: 12 &times; {gbp(monthlyGross)} = {gbp(annualGross)} a year including VAT. Nothing extra is added for paying monthly.
      </p>
      {oneOff.length > 0 && (
        <table className="w-full bg-white border border-gray-200 border-collapse">
          <thead>
            <tr className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500">
              <th className={`${cell} text-left font-semibold`}>One-off</th>
              <th className={`${cell} text-right font-semibold`}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {oneOff.map((l, i) => (
              <tr key={i}><td className={cell}>{l.description || 'One-off fee'}</td><td className={`${cell} text-right whitespace-nowrap`}>{gbp(l.annual_amount)} + VAT</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="text-center">
        <span className="inline-block bg-ocean-700 text-white font-semibold rounded-md px-4 py-2">Review and accept your quote</span>
        <p className="text-[11px] text-gray-400 mt-1">{validUntil ? `This quote is valid until ${validUntil}.` : 'The link works for a limited time.'}</p>
      </div>
      <p>The full quote, with what each service covers, is attached. If you have any questions, just reply to this email.</p>
      <div>
        <p>Kind regards,</p>
        {senderName && <p className="font-semibold">{senderName}</p>}
        <p className="text-gray-500 text-xs">Almond Valley Accounting</p>
      </div>
    </div>
  );
}

// Modal for composing and sending a quote to a client via email.
// Generates PDF client-side, sends via Supabase Edge Function.
export default function SendQuoteModal({ quote, lineItems, profile, onSent, onClose, pdfGenerator, groupId, entityIds }) {
  const [recipientEmail, setRecipientEmail] = useState('');
  const [ccEmail, setCcEmail] = useState('');
  // We already hold this address — on the client record, on its contacts, and
  // in the audit trail of the last send. Opening the box empty meant retyping
  // it for every re-send, which is how a quote goes to a typo.
  const [prefill, setPrefill] = useState(null);
  const [prefillLoading, setPrefillLoading] = useState(true);
  const [prefillEdited, setPrefillEdited] = useState(false);
  const client = quote.relationship_group || 'Client';
  const [subject, setSubject] = useState(groupId ? `Services Quote: ${client}` : `Your quote from Almond Valley Accounting — ${client}`);
  const expiryStr = quote.valid_until ? new Date(quote.valid_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  // Lead with the instalment arithmetic. The annual figure held on the quote is
  // NET, so quoting it next to a gross Direct Debit without spelling out the
  // VAT step reads as though the monthly amount carries interest.
  const monthlyGross = Number(quote.monthly_gross) || 0;
  const annualGross = Math.round(monthlyGross * 12 * 100) / 100;
  // A single quote's email (send-quote-email) lays out the table, the Direct
  // Debit, the accept button, the close and the sign-off itself, so the
  // message is just the greeting and one line. A group email still carries
  // its figures and sign-off in the message.
  const singleMessage = (name) => `Dear ${name || client},\n\nThank you for considering us. Here is our quote for ${client}.`;
  const [message, setMessage] = useState(groupId
    ? `Dear Client,\n\nPlease find attached your services quote from Almond Valley Accounting.\n\nQuote Reference: ${quote.quote_ref}\nMonthly Direct Debit: \u00A3${monthlyGross.toFixed(2)} (inc VAT)\nThis is 12 equal monthly instalments \u2014 12 \u00D7 \u00A3${monthlyGross.toFixed(2)} = \u00A3${annualGross.toFixed(2)} a year including VAT. Nothing extra is added for paying monthly.${expiryStr ? `\n\nThis quote is valid until ${expiryStr}.` : ''}\n\nPlease don't hesitate to get in touch if you have any questions.\n\nKind regards,\n${profile?.name || 'Almond Valley Accounting'}`
    : singleMessage(null));
  // Greet the client's primary contact by first name when we hold one; only
  // while the message is still the untouched default.
  useEffect(() => {
    if (groupId || !quote.entity_id) return;
    let live = true;
    supabase.from('entities')
      .select('id, name, billing_email, entity_people(is_primary_contact, person:people(id, name, first_name, preferred_name, email)), qbo_customer_mappings(qbo_email, role)')
      .eq('id', quote.entity_id).maybeSingle()
      .then(({ data }) => {
        const first = data ? firstNameOf(resolvePrimaryContact(data)) : null;
        if (live && first) setMessage((m) => (m === singleMessage(null) ? singleMessage(first) : m));
      });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote.entity_id, groupId]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const entityIdKey = (entityIds || []).filter(Boolean).join(',');
  useEffect(() => {
    let cancelled = false;
    setPrefillLoading(true);
    resolveQuoteRecipients(quote, { groupId, entityIds })
      .then(res => {
        if (cancelled) return;
        setPrefill(res);
        setPrefillLoading(false);
        // Never overwrite something already typed.
        if (res.to.length) {
          setRecipientEmail(prev => (prev.trim() ? prev : res.to.join(', ')));
        }
        if (res.cc.length) {
          setCcEmail(prev => (prev.trim() ? prev : res.cc.join(', ')));
        }
      })
      .catch(() => { if (!cancelled) setPrefillLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote?.id, groupId, entityIdKey]);

  const toList = parseEmails(recipientEmail);
  const ccList = parseEmails(ccEmail).filter(
    e => !toList.some(t => t.toLowerCase() === e.toLowerCase())
  );

  const handleSend = async () => {
    if (!toList.length) { setError('Enter at least one recipient email.'); return; }
    setSending(true);
    setError('');

    try {
      // Generate PDF as base64 — use custom generator if provided (e.g. group PDF)
      let pdfBase64;
      if (pdfGenerator) {
        pdfBase64 = await pdfGenerator();
      } else {
        const { generateQuotePdfBase64 } = await import('../lib/quotePdf');
        pdfBase64 = await generateQuotePdfBase64(quote, lineItems);
      }

      // Call Supabase Edge Function — function handles status update + audit
      // log server-side. For a group send we pass group_id (not quote_id):
      // the function summarises the whole group and the accept link covers
      // every member company.
      const emailBody = groupId
        ? {
            group_id: groupId,
            group_ref: quote.quote_ref,
            group_name: quote.relationship_group,
            to: toList,
            cc: ccList,
            subject,
            message,
            pdfBase64,
            filename: `${quote.quote_ref}.pdf`,
            include_accept_link: true,
          }
        : {
            quote_id: quote.id,
            to: toList,
            cc: ccList,
            subject,
            message,
            pdfBase64,
            filename: `${quote.quote_ref}.pdf`,
            include_accept_link: true,
          };
      const { data, error: fnErr } = await supabase.functions.invoke('send-quote-email', {
        body: emailBody,
      });

      if (fnErr) {
        // Try to surface server-side error detail (supabase-js wraps non-2xx in FunctionsHttpError)
        let detail = fnErr.message || 'Failed to send email';
        try {
          const respBody = await fnErr.context?.response?.clone().json();
          if (respBody?.error) detail = respBody.error;
        } catch { /* ignore — fall back to generic */ }
        throw new Error(detail);
      }

      if (data && data.success === false) {
        throw new Error(data.error || 'Send failed');
      }

      // Partial-success path: email sent but post-send DB update failed. Log it — manual reconcile.
      if (data?.warning) {
        console.warn('[send-quote-email] partial success:', data.warning, data);
      }

      setSent(true);
      if (onSent) onSent();
    } catch (e) {
      setError(e.message || 'Failed to send email');
    }
    setSending(false);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-xl p-5 max-h-[calc(100vh-48px)] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-sm font-bold text-ocean-700">Send Quote to Client</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg">&times;</button>
        </div>

        {sent ? (
          <div className="text-center py-6">
            <p className="text-sm text-green-700 font-medium mb-2">Quote sent successfully!</p>
            <p className="text-xs text-gray-500">Sent to {toList.join(', ')}</p>
            {ccList.length > 0 && (
              <p className="text-xs text-gray-500">CC {ccList.join(', ')}</p>
            )}
            <Btn onClick={onClose} className="mt-4">Close</Btn>
          </div>
        ) : (
          <>
            {error && <div className="text-xs text-red-600 bg-red-50 rounded p-2 mb-3">{error}</div>}

            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">
                  Recipient email <span className="text-gray-400">(separate multiple with a comma)</span>
                </label>
                <input
                  type="email"
                  multiple
                  value={recipientEmail}
                  onChange={e => { setRecipientEmail(e.target.value); setPrefillEdited(true); }}
                  placeholder={prefillLoading ? 'Looking up the client’s email…' : 'director1@example.com, director2@example.com'}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2"
                />
                {/* Say where the address came from — a prefill you cannot trace
                    is a prefill nobody checks. */}
                {!prefillLoading && prefill?.sourceLabel && !prefillEdited && (
                  <p className="text-[11px] text-gray-400 mt-1">
                    From {prefill.sourceLabel}
                    {prefill.source === 'last_send' && prefill.sentAt
                      ? ` on ${new Date(prefill.sentAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
                      : ''}
                    {' — check it before sending.'}
                  </p>
                )}
                {!prefillLoading && prefillEdited && prefill?.to?.length > 0
                  && recipientEmail.trim() !== prefill.to.join(', ') && (
                  <button
                    type="button"
                    onClick={() => { setRecipientEmail(prefill.to.join(', ')); setPrefillEdited(false); }}
                    className="text-[11px] text-ocean-600 hover:underline mt-1"
                  >
                    Restore {prefill.to.join(', ')}
                  </button>
                )}
                {!prefillLoading && !prefill?.to?.length && (
                  <p className="text-[11px] text-gray-400 mt-1">
                    No email on file for this client — add one to the client record so the next
                    quote fills itself in.
                  </p>
                )}
                {toList.length > 1 && (
                  <p className="text-[11px] text-gray-400 mt-1">
                    {toList.length} recipients — the accept link works for all of them, and the
                    acceptance is recorded against {toList[0]}.
                  </p>
                )}
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">
                  CC <span className="text-gray-400">(optional)</span>
                </label>
                <input
                  type="email"
                  multiple
                  value={ccEmail}
                  onChange={e => setCcEmail(e.target.value)}
                  placeholder="accountant@example.com"
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Subject</label>
                <input
                  value={subject}
                  onChange={e => setSubject(e.target.value)}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">
                  {groupId ? 'Message' : <>Opening message <span className="text-gray-400">(the fees, accept button and sign-off are added below it)</span></>}
                </label>
                <textarea
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  rows={groupId ? 8 : 4}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 font-mono text-xs"
                />
              </div>
              {!groupId && (
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">What the client will receive</label>
                  <SingleQuotePreview quote={quote} lineItems={lineItems} message={message} senderName={profile?.name} />
                </div>
              )}
            </div>

            <div className="flex gap-2 mt-4">
              <Btn onClick={handleSend} disabled={sending || !toList.length} className="flex-1">
                {sending ? 'Sending...' : 'Send Quote'}
              </Btn>
              <Btn onClick={onClose} variant="ghost">Cancel</Btn>
            </div>

            <p className="text-[11px] text-gray-400 mt-2">
              The quote PDF will be generated and attached automatically.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
