import React, { useState } from 'react';
import { supabase } from './supabase';
import { theme as t } from './theme';

/*
  Passwordless sign-in with a 6-digit code. The code is sent by our own
  portal-send-code edge function (Resend, from info@ — reliable inbox delivery),
  which mints a genuine Supabase email OTP for invited clients only. The client
  types the code; we verify it with supabase.auth.verifyOtp (type 'email'),
  which establishes a real Supabase session.
*/
export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [stage, setStage] = useState('email'); // email | sent
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  // Read the function's JSON { error } out of a non-2xx invoke response.
  async function messageFor(err, fallback) {
    try {
      const body = await err?.context?.json?.();
      if (body?.error) return body.error;
    } catch { /* fall through */ }
    return err?.message || fallback;
  }

  async function requestCode(addr) {
    const { error: err } = await supabase.functions.invoke('portal-send-code', {
      body: { email: addr },
    });
    if (err) throw new Error(await messageFor(err, 'Could not send a code — please try again.'));
  }

  async function sendCode(e) {
    e.preventDefault();
    if (!email.includes('@')) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await requestCode(email.trim().toLowerCase());
      setStage('sent');
    } catch (err) { setError(err.message); }
    setBusy(false);
  }

  async function resendCode() {
    setBusy(true); setError(null); setNotice(null);
    try {
      await requestCode(email.trim().toLowerCase());
      setNotice('New code sent.');
    } catch (err) { setError(err.message); }
    setBusy(false);
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
    if (err) setError('That code is incorrect or has expired — try again, or send a new one.');
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
            <form onSubmit={sendCode}>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6, color: t.text }}>Sign in</div>
              <p style={{ fontSize: 13.5, color: t.muted, margin: '0 0 16px', lineHeight: 1.55 }}>
                Enter your email and we'll send you a sign-in code — no password needed.
              </p>
              <input
                style={input} type="email" placeholder="you@example.com" value={email}
                autoComplete="email" inputMode="email"
                onChange={(e) => setEmail(e.target.value)} autoFocus
              />
              <button style={{ ...button, marginTop: 12 }} disabled={busy}>
                {busy ? 'Sending…' : 'Email me a sign-in code'}
              </button>
            </form>
          )}
          {stage === 'sent' && (
            <form onSubmit={verifyCode}>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6, color: t.text }}>Check your email 📬</div>
              <p style={{ fontSize: 13.5, color: t.muted, margin: '0 0 16px', lineHeight: 1.55 }}>
                We've emailed a sign-in code to <strong style={{ color: t.text }}>{email}</strong>.
                Enter it below — it's valid for one hour.
              </p>
              <input
                style={{ ...input, textAlign: 'center', letterSpacing: 6, fontSize: 20, fontWeight: 600 }}
                inputMode="numeric" autoComplete="one-time-code" placeholder="········" maxLength={8} value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus
              />
              <button style={{ ...button, marginTop: 12 }} disabled={busy || code.length < 6}>
                {busy ? 'Checking…' : 'Sign in'}
              </button>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button
                  type="button" onClick={() => { setStage('email'); setCode(''); setError(null); setNotice(null); }}
                  style={{ flex: 1, background: 'none', border: 'none', color: t.muted, fontSize: 13, cursor: 'pointer', minHeight: 40 }}
                >
                  Use a different email
                </button>
                <button
                  type="button" onClick={resendCode} disabled={busy}
                  style={{ flex: 1, background: 'none', border: 'none', color: t.muted, fontSize: 13, cursor: 'pointer', minHeight: 40 }}
                >
                  Resend code
                </button>
              </div>
              <p style={{ fontSize: 12, color: t.faint, margin: '10px 0 0', lineHeight: 1.5, textAlign: 'center' }}>
                Nothing arrived after a minute or two? Check your junk folder — and mark us
                as safe so you never miss an update.
              </p>
            </form>
          )}
          {notice && <div style={{ marginTop: 12, fontSize: 13, color: t.teal }}>{notice}</div>}
          {error && <div style={{ marginTop: 12, fontSize: 13, color: '#b91c1c' }}>{error}</div>}
        </div>

        <div style={{ textAlign: 'center', fontSize: 12, color: t.faint, marginTop: 18 }}>
          Almond Valley Accounting Ltd
        </div>
      </div>
    </div>
  );
}
