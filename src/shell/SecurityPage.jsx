import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

const font = "'Outfit', sans-serif";

// Security settings: enroll/remove a TOTP authenticator. After enrollment
// the user is signed in at aal2; future password logins will be prompted
// for a 6-digit code before reaching the app.
export default function SecurityPage() {
  const [factors, setFactors] = useState([]);
  const [enrolling, setEnrolling] = useState(null); // { factorId, qrSvg, secret, challengeId, code, verifying, error }
  const [aal, setAal] = useState({ currentLevel: 'aal1', nextLevel: 'aal1' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = async () => {
    setLoading(true);
    const [{ data: list, error: lErr }, { data: levels }] = await Promise.all([
      supabase.auth.mfa.listFactors(),
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    ]);
    if (lErr) setError(lErr.message);
    setFactors(list?.totp || []);
    if (levels) setAal(levels);
    setLoading(false);
  };

  useEffect(() => { refresh(); }, []);

  const startEnroll = async () => {
    setError('');
    const { data, error: eErr } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Athena (' + new Date().toISOString().slice(0, 10) + ')',
    });
    if (eErr) { setError(eErr.message); return; }
    const factorId = data.id;
    const qrSvg = data.totp.qr_code; // raw <svg>…</svg>
    const secret = data.totp.secret;
    const { data: ch, error: cErr } = await supabase.auth.mfa.challenge({ factorId });
    if (cErr) { setError(cErr.message); return; }
    setEnrolling({ factorId, qrSvg, secret, challengeId: ch.id, code: '', verifying: false, error: '' });
  };

  const cancelEnroll = async () => {
    if (enrolling?.factorId) {
      // Drop the unverified factor so it doesn't accumulate.
      await supabase.auth.mfa.unenroll({ factorId: enrolling.factorId });
    }
    setEnrolling(null);
    refresh();
  };

  const verifyEnroll = async () => {
    if (!enrolling || enrolling.code.length < 6) return;
    setEnrolling({ ...enrolling, verifying: true, error: '' });
    const { error: vErr } = await supabase.auth.mfa.verify({
      factorId: enrolling.factorId,
      challengeId: enrolling.challengeId,
      code: enrolling.code,
    });
    if (vErr) {
      // New challenge so they can retry.
      const { data: ch } = await supabase.auth.mfa.challenge({ factorId: enrolling.factorId });
      setEnrolling({ ...enrolling, verifying: false, code: '', challengeId: ch?.id || enrolling.challengeId, error: vErr.message || 'Verification failed' });
      return;
    }
    setEnrolling(null);
    refresh();
  };

  const removeFactor = async (factorId) => {
    if (!window.confirm('Remove this authenticator? You will no longer be prompted for a code at sign-in.')) return;
    const { error: uErr } = await supabase.auth.mfa.unenroll({ factorId });
    if (uErr) { setError(uErr.message); return; }
    refresh();
  };

  return (
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 720 }}>
      <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
        Security
      </h1>
      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 640, marginBottom: 18 }}>
        Set up two-factor authentication so signing in to Athena requires both your password and a code from your phone's authenticator app.
      </p>

      {error && <div style={{ fontSize: 12, color: '#b91c1c', background: '#fee2e2', borderRadius: 8, padding: '8px 12px', marginBottom: 14 }}>{error}</div>}

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 18, marginBottom: 18 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', margin: 0, marginBottom: 4 }}>
          Authenticator app (TOTP)
        </h3>
        <p style={{ fontSize: 12, color: '#64748b', margin: 0, marginBottom: 14 }}>
          Use Google Authenticator, Authy, 1Password, or any TOTP-compatible app on your phone.
        </p>

        {loading ? (
          <p style={{ fontSize: 13, color: '#94a3b8' }}>Loading…</p>
        ) : factors.length === 0 ? (
          <button
            onClick={startEnroll}
            style={{ padding: '8px 14px', background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            Enrol authenticator
          </button>
        ) : (
          <>
            {factors.map((f) => (
              <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderTop: '1px solid #f1f5f9' }}>
                <div style={{ fontSize: 13 }}>
                  <div style={{ color: '#0f172a', fontWeight: 500 }}>{f.friendly_name || 'Authenticator'}</div>
                  <div style={{ color: '#64748b', fontSize: 11 }}>
                    {f.status === 'verified' ? 'Active' : 'Unverified'} · added {new Date(f.created_at).toLocaleDateString('en-GB')}
                  </div>
                </div>
                <button
                  onClick={() => removeFactor(f.id)}
                  style={{ padding: '6px 10px', background: 'none', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}
                >
                  Remove
                </button>
              </div>
            ))}
            <p style={{ fontSize: 12, color: '#64748b', marginTop: 10, marginBottom: 0 }}>
              Session security level: <strong style={{ color: aal.currentLevel === 'aal2' ? '#15803d' : '#92400e' }}>{aal.currentLevel}</strong>
            </p>
          </>
        )}
      </div>

      {/* Enrollment flow */}
      {enrolling && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 28, width: 420, maxWidth: '90vw' }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: 0, marginBottom: 8 }}>
              Enrol authenticator
            </h3>
            <p style={{ fontSize: 12, color: '#64748b', marginTop: 0, marginBottom: 14 }}>
              Scan this QR code with your authenticator app, then enter the 6-digit code it shows.
            </p>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }} dangerouslySetInnerHTML={{ __html: enrolling.qrSvg }} />
            <details style={{ fontSize: 11, color: '#94a3b8', marginBottom: 14 }}>
              <summary style={{ cursor: 'pointer' }}>Can't scan? Enter this code manually.</summary>
              <div style={{ fontFamily: 'monospace', wordBreak: 'break-all', marginTop: 6, color: '#475569' }}>{enrolling.secret}</div>
            </details>
            <input
              autoFocus
              value={enrolling.code}
              onChange={(e) => setEnrolling({ ...enrolling, code: e.target.value.replace(/\D/g, '').slice(0, 6) })}
              onKeyDown={(e) => { if (e.key === 'Enter') verifyEnroll(); }}
              placeholder="123456"
              inputMode="numeric"
              style={{ width: '100%', fontSize: 22, fontFamily: 'monospace', textAlign: 'center', letterSpacing: 6, padding: '10px 8px', border: '1px solid #e5e7eb', borderRadius: 8, outline: 'none' }}
            />
            {enrolling.error && <p style={{ fontSize: 12, color: '#b91c1c', marginTop: 8, marginBottom: 0 }}>{enrolling.error}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
              <button onClick={cancelEnroll} style={{ padding: '8px 14px', background: 'none', color: '#64748b', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
              <button
                onClick={verifyEnroll}
                disabled={enrolling.verifying || enrolling.code.length < 6}
                style={{ padding: '8px 14px', background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: enrolling.verifying || enrolling.code.length < 6 ? 'not-allowed' : 'pointer', opacity: enrolling.verifying || enrolling.code.length < 6 ? 0.6 : 1 }}
              >
                {enrolling.verifying ? 'Verifying…' : 'Verify & activate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
