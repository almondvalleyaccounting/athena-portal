import React, { useState } from 'react';
import { supabase } from './supabase';
import { theme as t } from './theme';

/*
  Magic-link / one-time-code sign-in. We send the email via signInWithOtp;
  the client either clicks the link in the email (redirects back here) or
  types the 6-digit code shown in the same email.
*/
export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [stage, setStage] = useState('email'); // email | sent
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function sendLink(e) {
    e.preventDefault();
    if (!email.includes('@')) return;
    setBusy(true); setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { shouldCreateUser: true, emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (err) { setError(err.message); return; }
    setStage('sent');
  }

  async function verifyCode(e) {
    e.preventDefault();
    if (code.trim().length < 6) return;
    setBusy(true); setError(null);
    const { error: err } = await supabase.auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token: code.trim(),
      type: 'email',
    });
    setBusy(false);
    if (err) setError(err.message);
    // success → onAuthStateChange in App.jsx takes over
  }

  const input = {
    width: '100%', padding: '13px 15px', fontSize: 16, border: `1.5px solid ${t.border}`,
    borderRadius: 12, outline: 'none', background: '#fff', boxSizing: 'border-box',
    transition: 'border-color 0.2s ease',
  };
  const button = {
    width: '100%', padding: '13px 15px', fontSize: 15, fontWeight: 600, border: 'none',
    borderRadius: 12, background: t.navy, color: '#fff', cursor: 'pointer',
    opacity: busy ? 0.7 : 1, minHeight: 48, transition: 'opacity 0.2s ease',
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      position: 'relative', overflow: 'hidden',
      background: `linear-gradient(135deg, #f6f8f9 0%, #eef5f5 50%, #f2f0e6 100%)`,
    }}>
      <div className="blob" style={{ width: 380, height: 380, background: t.teal, top: '-120px', right: '-80px', opacity: 0.16 }} />
      <div className="blob" style={{ width: 320, height: 320, background: '#F5C518', bottom: '-100px', left: '-70px', opacity: 0.14, animationDelay: '3s' }} />
      <div className="blob" style={{ width: 260, height: 260, background: t.navy, top: '40%', left: '-120px', opacity: 0.08, animationDelay: '6s' }} />

      <div style={{ width: '100%', maxWidth: 400, position: 'relative' }}>
        <div className="fade-up" style={{ textAlign: 'center', marginBottom: 24 }}>
          <img
            src="/ava-logo.jpg" alt="Almond Valley Accounting"
            className="pop-in"
            style={{
              width: 76, height: 76, borderRadius: 20, objectFit: 'cover',
              boxShadow: '0 10px 30px rgba(30,69,96,0.22)', marginBottom: 14,
            }}
          />
          <div style={{ fontSize: 26, fontWeight: 700, color: t.navy, letterSpacing: 0.3, lineHeight: 1.25 }}>
            Almond Valley Accounting
          </div>
          <div style={{ fontSize: 13.5, color: t.muted, marginTop: 6, lineHeight: 1.5 }}>
            Your window into everything we're doing for you.
          </div>
        </div>

        <div className="fade-up" style={{
          background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(6px)',
          border: `1px solid ${t.border}`, borderRadius: 20, padding: '26px 24px',
          animationDelay: '150ms', boxShadow: '0 18px 50px rgba(30,69,96,0.12)',
        }}>
          {stage === 'email' && (
            <form onSubmit={sendLink}>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6, color: t.text }}>Sign in</div>
              <p style={{ fontSize: 13.5, color: t.muted, margin: '0 0 16px', lineHeight: 1.55 }}>
                Enter your email and we'll send you a secure sign-in link — no password needed.
              </p>
              <input
                style={input} type="email" placeholder="you@example.com" value={email}
                autoComplete="email" inputMode="email"
                onChange={(e) => setEmail(e.target.value)} autoFocus
              />
              <button style={{ ...button, marginTop: 12 }} disabled={busy}>
                {busy ? 'Sending…' : 'Email me a sign-in link'}
              </button>
            </form>
          )}
          {stage === 'sent' && (
            <form onSubmit={verifyCode}>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6, color: t.text }}>Check your email 📬</div>
              <p style={{ fontSize: 13.5, color: t.muted, margin: '0 0 16px', lineHeight: 1.55 }}>
                We've sent a sign-in link to <strong style={{ color: t.text }}>{email}</strong>.
                Tap the link on this device — or type the 6-digit code from the email below.
              </p>
              <input
                style={{ ...input, textAlign: 'center', letterSpacing: 8, fontSize: 22, fontWeight: 600 }}
                inputMode="numeric" autoComplete="one-time-code" placeholder="······" maxLength={6} value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
              <button style={{ ...button, marginTop: 12 }} disabled={busy || code.length < 6}>
                {busy ? 'Checking…' : 'Sign in with code'}
              </button>
              <button
                type="button" onClick={() => { setStage('email'); setCode(''); }}
                style={{ width: '100%', marginTop: 10, background: 'none', border: 'none', color: t.muted, fontSize: 13, cursor: 'pointer', minHeight: 40 }}
              >
                Use a different email
              </button>
              <p style={{ fontSize: 12, color: t.faint, margin: '10px 0 0', lineHeight: 1.5, textAlign: 'center' }}>
                Nothing arrived after a minute or two? Check your junk folder — and mark us
                as safe so you never miss an update.
              </p>
            </form>
          )}
          {error && <div style={{ marginTop: 12, fontSize: 13, color: '#b91c1c' }}>{error}</div>}
        </div>

        <div style={{ textAlign: 'center', fontSize: 12, color: t.faint, marginTop: 18 }}>
          Almond Valley Accounting Ltd
        </div>
      </div>
    </div>
  );
}
