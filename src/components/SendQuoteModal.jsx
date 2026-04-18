import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Btn } from './ui';

// Modal for composing and sending a quote to a client via email.
// Generates PDF client-side, sends via Supabase Edge Function.
export default function SendQuoteModal({ quote, lineItems, profile, onSent, onClose, pdfGenerator }) {
  const [recipientEmail, setRecipientEmail] = useState('');
  const [subject, setSubject] = useState(`Services Quote: ${quote.relationship_group || 'Client'}`);
  const expiryStr = quote.valid_until ? new Date(quote.valid_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const [message, setMessage] = useState(
    `Dear Client,\n\nPlease find attached your services quote from Almond Valley Accounting.\n\nQuote Reference: ${quote.quote_ref}\nMonthly Direct Debit: \u00A3${Number(quote.monthly_gross).toFixed(2)} (inc VAT)${expiryStr ? `\nThis quote is valid until ${expiryStr}.` : ''}\n\nPlease don't hesitate to get in touch if you have any questions.\n\nKind regards,\n${profile?.name || 'Almond Valley Accounting'}`
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const handleSend = async () => {
    if (!recipientEmail) { setError('Enter a recipient email.'); return; }
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

      // Call Supabase Edge Function — function now handles status update + audit log server-side
      const { data, error: fnErr } = await supabase.functions.invoke('send-quote-email', {
        body: {
          quote_id: quote.id,
          to: recipientEmail,
          subject,
          message,
          pdfBase64,
          filename: `${quote.quote_ref}.pdf`,
          include_accept_link: true,
        },
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
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-5">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-sm font-bold text-ocean-700">Send Quote to Client</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg">\u00D7</button>
        </div>

        {sent ? (
          <div className="text-center py-6">
            <p className="text-sm text-green-700 font-medium mb-2">Quote sent successfully!</p>
            <p className="text-xs text-gray-500">Sent to {recipientEmail}</p>
            <Btn onClick={onClose} className="mt-4">Close</Btn>
          </div>
        ) : (
          <>
            {error && <div className="text-xs text-red-600 bg-red-50 rounded p-2 mb-3">{error}</div>}

            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Recipient email</label>
                <input
                  type="email"
                  value={recipientEmail}
                  onChange={e => setRecipientEmail(e.target.value)}
                  placeholder="client@example.com"
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
                <label className="text-xs text-gray-500 mb-1 block">Message</label>
                <textarea
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  rows={8}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 font-mono text-xs"
                />
              </div>
            </div>

            <div className="flex gap-2 mt-4">
              <Btn onClick={handleSend} disabled={sending || !recipientEmail} className="flex-1">
                {sending ? 'Sending...' : 'Send Quote'}
              </Btn>
              <Btn onClick={onClose} variant="ghost">Cancel</Btn>
            </div>

            <p className="text-[10px] text-gray-400 mt-2">
              The quote PDF will be generated and attached automatically.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
