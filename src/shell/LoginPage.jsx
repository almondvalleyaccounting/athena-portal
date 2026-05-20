import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

/* ─── Cinematic panel (right side) ────────────────────────────── */
function CinematicPanel() {
  const [dotIndex, setDotIndex] = useState(-1);
  const [burst, setBurst] = useState(false);

  useEffect(() => {
    const timers = [];
    for (let i = 0; i < 7; i++) {
      timers.push(setTimeout(() => setDotIndex(i), 800 + i * 400));
    }
    timers.push(setTimeout(() => setBurst(true), 800 + 7 * 400));
    // Loop: reset after pause
    timers.push(setTimeout(() => { setDotIndex(-1); setBurst(false); }, 800 + 7 * 400 + 2000));
    const interval = setInterval(() => {
      setDotIndex(-1); setBurst(false);
      const t2 = [];
      for (let i = 0; i < 7; i++) {
        t2.push(setTimeout(() => setDotIndex(i), 800 + i * 400));
      }
      t2.push(setTimeout(() => setBurst(true), 800 + 7 * 400));
      t2.push(setTimeout(() => { setDotIndex(-1); setBurst(false); }, 800 + 7 * 400 + 2000));
    }, 800 + 7 * 400 + 3000);
    return () => { timers.forEach(clearTimeout); clearInterval(interval); };
  }, []);

  return (
    <div style={{
      flex: 1, background: '#000', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Subtle radial glow */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'radial-gradient(ellipse at 50% 50%, rgba(56,189,248,0.06) 0%, transparent 70%)',
      }} />

      <h1 style={{
        fontFamily: "'Major Mono Display', monospace",
        fontSize: 52, color: '#fff', letterSpacing: '0.12em',
        marginBottom: 32, zIndex: 1,
      }}>
        ATHENA
      </h1>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, zIndex: 1 }}>
        {Array.from({ length: 7 }).map((_, i) => {
          const isLit = dotIndex >= i || burst;
          const isLast = i === 6;
          const showBurst = isLast && burst;
          return (
            <div key={i} style={{
              width: showBurst ? 14 : 8, height: showBurst ? 14 : 8,
              borderRadius: '50%',
              backgroundColor: isLit ? '#38bdf8' : '#333',
              transition: 'all 0.3s ease',
              boxShadow: showBurst
                ? '0 0 20px 8px rgba(56,189,248,0.6), 0 0 40px 16px rgba(56,189,248,0.3)'
                : isLit ? '0 0 8px rgba(56,189,248,0.5)' : 'none',
            }} />
          );
        })}
      </div>

      <p style={{
        position: 'absolute', bottom: 28, fontFamily: "'Outfit', sans-serif",
        fontSize: 11, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.03em',
      }}>
        Powered by Almond Valley Accounting
      </p>
    </div>
  );
}

/* ─── Login page ──────────────────────────────────────────────── */
export default function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) navigate('/home', { replace: true });
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) navigate('/home', { replace: true });
    });
    return () => subscription.unsubscribe();
  }, [navigate]);

  const handleSubmit = async () => {
    setError('');
    setLoading(true);
    try {
      const { error: err } = await supabase.auth.signInWithPassword({ email, password });
      if (err) throw err;
      navigate('/home', { replace: true });
    } catch (e) {
      setError(e.message || 'Authentication failed');
    }
    setLoading(false);
  };

  const handleResetPassword = async () => {
    if (!email) { setError('Enter your email address first'); return; }
    setError('');
    const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/login`,
    });
    if (err) setError(err.message);
    else setResetSent(true);
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {/* ── Left: Login form (white) ── */}
      <div style={{
        width: '440px', flexShrink: 0, background: '#fff',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '48px 40px',
      }}>
        {/* Logo */}
        <img src="/ava-logo.jpg" alt="AVA" style={{ width: 56, height: 56, borderRadius: 10, marginBottom: 20 }} />

        <h1 style={{
          fontFamily: "'Major Mono Display', monospace",
          fontSize: 24, color: '#0f172a', marginBottom: 8,
        }}>
          ATHENA
        </h1>
        <p style={{
          fontFamily: "'Outfit', sans-serif", fontSize: 13, color: '#94a3b8',
          marginBottom: 32,
        }}>
          Sign in to your account
        </p>

        {/* Email */}
        <input
          value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="Email" type="email" disabled={loading}
          style={inputStyle}
          onFocus={(e) => e.target.style.borderColor = '#38bdf8'}
          onBlur={(e) => e.target.style.borderColor = '#e5e7eb'}
        />

        {/* Password */}
        <input
          value={password} onChange={(e) => setPassword(e.target.value)}
          placeholder="Password" type="password" disabled={loading}
          onKeyDown={(e) => e.key === 'Enter' && !loading && email && password && handleSubmit()}
          style={{ ...inputStyle, marginBottom: 20 }}
          onFocus={(e) => e.target.style.borderColor = '#38bdf8'}
          onBlur={(e) => e.target.style.borderColor = '#e5e7eb'}
        />

        {/* Sign in */}
        <button
          onClick={handleSubmit}
          disabled={loading || !email || !password}
          style={{
            width: '100%', backgroundColor: loading || !email || !password ? '#94a3b8' : '#0f172a',
            color: '#fff', fontFamily: "'Outfit', sans-serif", fontWeight: 600,
            fontSize: 14, borderRadius: 10, padding: 14, border: 'none',
            cursor: loading || !email || !password ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s ease', marginBottom: 16,
          }}
        >
          {loading ? 'Signing in...' : 'Sign in'}
        </button>

        {/* Forgot password */}
        <div style={{ textAlign: 'center' }}>
          {resetSent ? (
            <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: 13, color: '#22c55e' }}>
              Reset link sent — check your email.
            </p>
          ) : (
            <button onClick={handleResetPassword} style={{
              background: 'none', border: 'none', fontFamily: "'Outfit', sans-serif",
              fontSize: 13, color: '#94a3b8', cursor: 'pointer', padding: 0,
            }}>
              Forgot password?
            </button>
          )}
        </div>

        {/* Error */}
        {error && (
          <p style={{ color: '#ef4444', fontSize: 13, fontFamily: "'Outfit', sans-serif", marginTop: 12, textAlign: 'center' }}>
            {error}
          </p>
        )}
      </div>

      {/* ── Electric blue divider bar ── */}
      <div style={{
        width: 4, background: 'linear-gradient(180deg, #38bdf8 0%, #0ea5e9 50%, #38bdf8 100%)',
        boxShadow: '0 0 12px rgba(56,189,248,0.4), 0 0 24px rgba(56,189,248,0.2)',
        flexShrink: 0,
      }} />

      {/* ── Right: Cinematic ATHENA ── */}
      <CinematicPanel />
    </div>
  );
}

const inputStyle = {
  width: '100%', border: '1px solid #e5e7eb', borderRadius: 10,
  padding: '12px 16px', fontSize: 14, fontFamily: "'Outfit', sans-serif",
  outline: 'none', marginBottom: 12, boxSizing: 'border-box',
  transition: 'border-color 0.2s ease',
};
