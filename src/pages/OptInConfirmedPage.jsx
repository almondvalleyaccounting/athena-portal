import React from 'react';

/*
  Public opt-in confirmation page (no login). The comm-optin edge function
  records the client's choice, then 302-redirects here — Supabase's
  functions domain serves HTML as plain text, so the human-facing page
  lives on the app domain instead. Purely presentational; the preference
  is already saved by the time the client lands here.

  /opt-in?choice=in | choice=out | status=invalid
*/

const MESSAGES = {
  in: {
    heading: "You're opted in",
    body: "You're opted in — we'll send you tax payment reminders. You can change your mind any time by replying to our email.",
  },
  out: {
    heading: 'No problem',
    body: "No problem — we won't email you tax payment reminders. You can change your mind any time by replying to our email.",
  },
  invalid: {
    heading: "This link isn't valid",
    body: "This link isn't valid — please reply to the email instead and we'll set your preference for you.",
  },
};

export default function OptInConfirmedPage() {
  const params = new URLSearchParams(window.location.search);
  const choice = (params.get('choice') || '').toLowerCase();
  const status = (params.get('status') || '').toLowerCase();
  const key = choice === 'in' ? 'in' : choice === 'out' ? 'out' : 'invalid';
  const m = MESSAGES[status === 'invalid' ? 'invalid' : key];

  return (
    <div style={{ margin: 0, padding: 0, background: '#f8fafc', minHeight: '100vh', fontFamily: 'Arial, Helvetica, sans-serif' }}>
      <div style={{
        maxWidth: 520, margin: '48px auto', padding: '32px 28px', background: '#fff',
        border: '1px solid #e5e7eb', borderRadius: 10, color: '#222',
      }}>
        <h1 style={{ fontSize: 18, margin: '0 0 6px' }}>Almond Valley Accounting</h1>
        <h2 style={{ fontSize: 15, margin: '0 0 16px', color: '#555', fontWeight: 'normal' }}>{m.heading}</h2>
        <p style={{ fontSize: 14, lineHeight: 1.6, margin: 0 }}>{m.body}</p>
      </div>
    </div>
  );
}
