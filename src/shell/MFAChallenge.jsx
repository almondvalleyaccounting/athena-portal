import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { rememberThisDevice, forgetThisDevice, TRUSTED_DEVICE_DAYS, UNTRUSTED_SESSION_DAYS } from '../lib/trustedDevice';

// Shown after password sign-in when the user has a verified TOTP factor
// and the current session is still aal1. On successful verify, the
// session elevates to aal2 and the app proceeds.
//
// The "stay signed in" tick does not skip this screen next time — nothing
// does, and see trustedDevice.js for why that is deliberate. It decides how
// long the session this code is about to elevate may live: 30 days ticked,
// 7 unticked. Untick it on a machine that is not yours.
export default function MFAChallenge({ onPassed }) {
  const [factorId, setFactorId] = useState(null);
  const [challengeId, setChallengeId] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [staySignedIn, setStaySignedIn] = useState(true);

  useEffect(() => {
    (async () => {
      const { data, error: listErr } = await supabase.auth.mfa.listFactors();
      if (listErr) { setError(listErr.message); setLoading(false); return; }
      const totp = (data?.totp || []).find((f) => f.status === 'verified');
      if (!totp) { setError('No verified authenticator on this account.'); setLoading(false); return; }
      setFactorId(totp.id);
      const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId: totp.id });
      if (chErr) { setError(chErr.message); setLoading(false); return; }
      setChallengeId(ch.id);
      setLoading(false);
    })();
  }, []);

  const handleVerify = async () => {
    if (!factorId || !challengeId || code.length < 6) return;
    setVerifying(true);
    setError('');
    const { error: vErr } = await supabase.auth.mfa.verify({ factorId, challengeId, code });
    if (vErr) {
      setError(vErr.message || 'Verification failed');
      setVerifying(false);
      // Issue a fresh challenge so the user can try again without reloading.
      const { data: ch } = await supabase.auth.mfa.challenge({ factorId });
      if (ch?.id) setChallengeId(ch.id);
      setCode('');
      return;
    }
    // Verified: the session is aal2 from here. Record (or clear) the
    // device before handing back, so the shell's lifetime check reads a
    // settled answer rather than racing this write.
    const { data: { user } } = await supabase.auth.getUser();
    if (staySignedIn) {
      if (user) await rememberThisDevice(user.id);
    } else {
      await forgetThisDevice();
    }
    setVerifying(false);
    onPassed?.();
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a', fontFamily: "'Outfit', sans-serif" }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 32, width: 380, boxShadow: '0 20px 50px rgba(0,0,0,0.3)' }}>
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 500, color: '#0f172a', margin: 0 }}>Two-factor verification</h1>
        <p style={{ fontSize: 13, color: '#64748b', marginTop: 6, marginBottom: 20 }}>
          Open your authenticator app and enter the 6-digit code for Athena.
        </p>
        {loading ? (
          <p style={{ fontSize: 13, color: '#94a3b8' }}>Loading…</p>
        ) : (
          <>
            <input
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => { if (e.key === 'Enter') handleVerify(); }}
              placeholder="123456"
              inputMode="numeric"
              style={{ width: '100%', fontSize: 24, fontFamily: 'monospace', textAlign: 'center', letterSpacing: 6, padding: '12px 8px', border: '1px solid #e5e7eb', borderRadius: 8, outline: 'none' }}
            />
            {error && <p style={{ fontSize: 12, color: '#b91c1c', marginTop: 10 }}>{error}</p>}
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 14, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={staySignedIn}
                onChange={(e) => setStaySignedIn(e.target.checked)}
                style={{ marginTop: 2, cursor: 'pointer' }}
              />
              <span style={{ fontSize: 12, color: '#64748b', lineHeight: 1.45 }}>
                Stay signed in on this device for {TRUSTED_DEVICE_DAYS} days.
                <span style={{ display: 'block', color: '#94a3b8' }}>
                  Untick on a shared or borrowed machine and this browser signs out after {UNTRUSTED_SESSION_DAYS} days instead.
                  Either way you'll enter a code again the next time you sign in.
                </span>
              </span>
            </label>
            <button
              onClick={handleVerify}
              disabled={verifying || code.length < 6 || !challengeId}
              style={{ width: '100%', marginTop: 14, padding: '10px 14px', background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: verifying || code.length < 6 ? 'not-allowed' : 'pointer', opacity: verifying || code.length < 6 ? 0.6 : 1 }}
            >
              {verifying ? 'Verifying…' : 'Verify'}
            </button>
            <button
              onClick={handleSignOut}
              style={{ width: '100%', marginTop: 10, padding: '8px 14px', background: 'none', color: '#94a3b8', border: 'none', fontSize: 12, cursor: 'pointer' }}
            >
              Sign out
            </button>
          </>
        )}
      </div>
    </div>
  );
}
