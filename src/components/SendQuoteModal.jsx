import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Btn } from './ui';

// Modal for composing and sending a quote to a client via email.
// Generates PDF client-side, sends via Supabase Edge Function.
export default function SendQuoteModal({ quote, lineItems, profile, onSent, onClose }) {
  const [recipientEmail, setRecipientEmail] = useState('');
  const [subject, setSubject] = useState(`Quote ${quote.quote_ref} - Almond Valley Accounting`);
  const [message, setMessage] = useState(
    `Dear Client,\n\nPlease find attached your quote from Almond Valley Accounting.\n\nQuote Reference: ${quote.quote_ref}\nMonthly Direct Debit: £${Number(quote.monthly_gross).toFixed(2)} (inc VAT)\n\nPlease don't hesitate to get in touch if you have any questions.\n\nKind regards,\n${profile?.name || 'Almond Valley Accounting'}`
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const handleSend = async () => {
    if (!recipientEmail) { setError('Enter a recipient email.'); return; }
    setSending(true);
    setError('');

    try {
      // Generate PDF as base64
      const { generateQuotePdfBase64 } = await import('../lib/quotePdf');
      const pdfBase64 = await generateQuotePdfBase64(quote, lineItems);

      // Call Supabase Edge Function
      const { data, error: fnErr } = await supabase.functions.invoke('send-quote-email', {
        body: {
          to: recipientEmail,
          subject,
          message,
          pdfBase64,
          filename: `${quote.quote_ref}.pdf`,
          quoteId: quote.id,
        },
      });

      if (fnErr) throw fnErr;

      // Update quote status to sent
      await supabase.from('quotes').update({
        status: 'sent',
        sent_at: new Date().toISOString(),
      }).eq('id', quote.id);

      // Audit log
      await supabase.from('audit_log').insert({
        user_id: profile.id,
        action: 'sent_to_client',
        entity_type: 'quote',
        entity_id: quote.id,
        detail: { recipient: recipientEmail },
      });

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
