import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { rememberThisDevice, forgetThisDevice, checkTrustedDevice, TRUSTED_DEVICE_DAYS, UNTRUSTED_SESSION_DAYS } from '../lib/trustedDevice';

const font = "'Outfit', sans-serif";

// Security settings: enroll/remove a TOTP authenticator. After enrollment
// the user is signed in at aal2; future password logins will be prompted
// for a 6-digit code before reaching the app.
export default function SecurityPage({ onEnrolled, embedded = false }) {
  const [factors, setFactors] = useState([]);
  const [enrolling, setEnrolling] = useState(null); // { factorId, qrSvg, secret, challengeId, code, verifying, error }
  const [aal, setAal] = useState({ currentLevel: 'aal1', nextLevel: 'aal1' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [trusted, setTrusted] = useState(null); // null = unknown

  const refresh = async () => {
    setLoading(true);
    const [{ data: list, error: lErr }, { data: levels }, { data: { user } }] = await Promise.all([
      supabase.auth.mfa.listFactors(),
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      supabase.auth.getUser(),
    ]);
    if (lErr) setError(lErr.message);
    setFactors(list?.totp || []);
    if (levels) setAal(levels);
    setTrusted(user ? await checkTrustedDevice(user.id) : false);
    setLoading(false);
  };

  // Turning "stay signed in" on or off from here changes only how long this
  // browser keeps a session before it has to sign in again. It has never
  // been a way to skip the 6-digit code, and must not become one.
  const setStaySignedIn = async (on) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    if (on) await rememberThisDevice(user.id);
    else await forgetThisDevice();
    refresh();
  };

  useEffect(() => { refresh(); }, []);

  const startEnroll = async () => {
    setError('');
    // Clear any stale UNVERIFIED factors from abandoned attempts first —
    // otherwise the next enroll collides on the friendly name. Verified
    // factors are left alone (they're real, working authenticators).
    const { data: existing } = await supabase.auth.mfa.listFactors();
    for (const f of (existing?.totp || [])) {
      if (f.status !== 'verified') {
        await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
    }
    // Readable name; uniqueness is guaranteed by the unverified-cleanup above.
    const friendlyName = 'Athena (' + new Date().toLocaleString('en-GB') + ')';
    const { data, error: eErr } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName,
    });
    if (eErr) { setError(eErr.message); return; }
    const factorId = data.id;
    // Supabase returns qr_code as a data: URI (SVG). Normalise it so it
    // renders as a clean <img>: if it's the unencoded
    // `data:image/svg+xml;utf-8,<svg…>` form, URL-encode the SVG part,
    // otherwise an unencoded '#' / '<' can corrupt the image on some
    // browsers (which stops phones recognising the QR).
    const rawQr = data.totp.qr_code || '';
    let qrSrc = rawQr;
    const m = rawQr.match(/^data:image\/svg\+xml(;utf-8|;charset=utf-8)?,(.*)$/s);
    if (m && !/;base64,/.test(rawQr)) {
      qrSrc = `data:image/svg+xml;utf-8,${encodeURIComponent(m[2])}`;
    }
    const secret = data.totp.secret;
    const uri = data.totp.uri || '';
    const { data: ch, error: cErr } = await supabase.auth.mfa.challenge({ factorId });
    if (cErr) { setError(cErr.message); return; }
    setEnrolling({ factorId, qrSrc, secret, uri, challengeId: ch.id, code: '', verifying: false, error: '' });
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
    // Enrolment just elevated this session to aal2. Remember the device so
    // this browser holds its session for 30 days rather than 7 — the prompt
    // itself still comes back at the next sign-in.
    const { data: { user } } = await supabase.auth.getUser();
    if (user) await rememberThisDevice(user.id);
    setEnrolling(null);
    refresh();
    onEnrolled?.();
  };

  const removeFactor = async (factorId) => {
    if (!window.confirm('Remove this authenticator? You will no longer be prompted for a code at sign-in, and any "remembered" devices for this account will be cleared.')) return;
    const { error: uErr } = await supabase.auth.mfa.unenroll({ factorId });
    if (uErr) { setError(uErr.message); return; }
    // Wipe the local trusted-device token and any rows on the server —
    // there's no enrolled factor any more, so trusted-device claims must
    // not survive.
    await forgetThisDevice();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) await supabase.from('mfa_trusted_devices').delete().eq('user_id', user.id);
    refresh();
  };

  return (
    <div style={{ padding: embedded ? 0 : '20px 28px', fontFamily: font, maxWidth: embedded ? '100%' : 720 }}>
      {!embedded && (
        <>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
            Security
          </h1>
          <p style={{ fontSize: 13, color: '#64748b', maxWidth: 640, marginBottom: 18 }}>
            Set up two-factor authentication so signing in to Athena requires both your password and a code from your phone's authenticator app.
          </p>
        </>
      )}

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
            {trusted !== null && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginTop: 12, paddingTop: 12, borderTop: '1px solid #f1f5f9' }}>
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  <div style={{ color: '#0f172a', fontWeight: 500, fontSize: 13 }}>This device</div>
                  {trusted
                    ? `Stays signed in for ${TRUSTED_DEVICE_DAYS} days, so you enter a code about once a month.`
                    : `Signs out after ${UNTRUSTED_SESSION_DAYS} days, so you enter a code about once a week.`}
                </div>
                <button
                  onClick={() => setStaySignedIn(!trusted)}
                  style={{ flexShrink: 0, padding: '6px 10px', background: 'none', color: '#0f172a', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontFamily: font }}
                >
                  {trusted ? 'Forget this device' : 'Stay signed in here'}
                </button>
              </div>
            )}
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
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
              <img src={enrolling.qrSrc} alt="Authenticator QR code" width={220} height={220} style={{ display: 'block' }} />
            </div>
            <details style={{ fontSize: 11, color: '#94a3b8', marginBottom: 14 }}>
              <summary style={{ cursor: 'pointer' }}>Can't scan? Enter this code manually.</summary>
              <p style={{ marginTop: 6, marginBottom: 4, color: '#64748b' }}>In your authenticator app choose "enter a setup key" and paste:</p>
              <div style={{ fontFamily: 'monospace', wordBreak: 'break-all', color: '#0f172a', fontSize: 13, letterSpacing: 1 }}>{enrolling.secret}</div>
              <p style={{ marginTop: 4, color: '#94a3b8' }}>Account: Athena · Type: time-based</p>
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
