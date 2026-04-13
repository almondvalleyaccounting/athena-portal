import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

/* ─── Cinematic intro sequence ─────────────────────────────────── */
function CinematicIntro({ onComplete }) {
  const [phase, setPhase] = useState('text'); // text → dots → burst → done

  useEffect(() => {
    const dotTimers = [];
    const dotStart = 1200;
    for (let i = 0; i < 7; i++) {
      dotTimers.push(
        setTimeout(() => {
          setPhase(`dot-${i}`);
        }, dotStart + i * 500)
      );
    }

    const burstTimer = setTimeout(() => setPhase('burst'), dotStart + 7 * 500);

    const doneTimer = setTimeout(() => {
      setPhase('fadeout');
      setTimeout(onComplete, 800);
    }, dotStart + 7 * 500 + 600);

    return () => {
      dotTimers.forEach(clearTimeout);
      clearTimeout(burstTimer);
      clearTimeout(doneTimer);
    };
  }, [onComplete]);

  const dotIndex = phase.startsWith('dot-') ? parseInt(phase.split('-')[1]) : -1;
  const isBurst = phase === 'burst' || phase === 'fadeout';
  const isFadeout = phase === 'fadeout';

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black"
      style={{
        opacity: isFadeout ? 0 : 1,
        transition: 'opacity 0.8s ease',
      }}
    >
      <h1
        style={{
          fontFamily: "'Major Mono Display', monospace",
          fontSize: '62px',
          color: '#ffffff',
          letterSpacing: '0.12em',
        }}
      >
        <span style={{ animation: 'fadeInText 1.2s ease forwards' }}>
          ATHENA
        </span>
      </h1>

      <div className="flex items-center gap-3 mt-8">
        {Array.from({ length: 7 }).map((_, i) => {
          const isLit = dotIndex >= i || isBurst;
          const isLast = i === 6;
          const showBurst = isLast && isBurst;

          return (
            <div
              key={i}
              className="relative"
              style={{
                width: showBurst ? '16px' : '8px',
                height: showBurst ? '16px' : '8px',
                borderRadius: '50%',
                backgroundColor: isLit ? '#38bdf8' : '#333',
                transition: 'all 0.3s ease',
                boxShadow: showBurst
                  ? '0 0 20px 8px rgba(56, 189, 248, 0.6), 0 0 40px 16px rgba(56, 189, 248, 0.3)'
                  : isLit
                  ? '0 0 8px rgba(56, 189, 248, 0.5)'
                  : 'none',
              }}
            />
          );
        })}
      </div>

      <p
        style={{
          position: 'absolute',
          bottom: '32px',
          right: '32px',
          fontFamily: "'Outfit', sans-serif",
          fontSize: '12px',
          color: 'rgba(255, 255, 255, 0.5)',
          opacity: dotIndex >= 0 || isBurst ? 1 : 0,
          transition: 'opacity 0.8s ease',
        }}
      >
        Powered by Almond Valley Accounting
      </p>

      <style>{`
        @keyframes fadeInText {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

/* ─── Login page ───────────────────────────────────────────────── */
export default function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  // If user is already logged in, skip straight to /home
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) navigate('/home', { replace: true });
    });
  }, [navigate]);

  const handleSubmit = async () => {
    setError('');
    setLoading(true);

    try {
      const { error: err } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (err) throw err;
      // Auth succeeded — trigger cinematic
      setAuthenticated(true);
    } catch (e) {
      setError(e.message || 'Authentication failed');
    }

    setLoading(false);
  };

  // After cinematic completes, enter the portal
  const handleCinematicComplete = () => {
    navigate('/home', { replace: true });
  };

  const handleResetPassword = async () => {
    if (!email) {
      setError('Enter your email address first');
      return;
    }
    setError('');
    const { error: err } = await supabase.auth.resetPasswordForEmail(email);
    if (err) {
      setError(err.message);
    } else {
      setResetSent(true);
    }
  };

  // Show cinematic after successful login
  if (authenticated) {
    return <CinematicIntro onComplete={handleCinematicComplete} />;
  }

  // Static login form
  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{
        background: 'radial-gradient(ellipse at center, #0a0a0f 0%, #000000 100%)',
      }}
    >
      <div
        style={{
          backgroundColor: '#ffffff',
          borderRadius: '16px',
          padding: '40px',
          maxWidth: '400px',
          width: '100%',
        }}
      >
        {/* Logo */}
        <div className="flex justify-center mb-4">
          <img
            src="/ava-logo.jpg"
            alt="Almond Valley Accounting"
            style={{ width: '48px', height: '48px', borderRadius: '8px' }}
          />
        </div>

        {/* ATHENA wordmark */}
        <h1
          className="text-center mb-6"
          style={{
            fontFamily: "'Major Mono Display', monospace",
            fontSize: '22px',
            color: '#0f172a',
          }}
        >
          ATHENA
        </h1>

        {/* Email */}
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          type="email"
          disabled={loading}
          style={{
            width: '100%',
            border: '1px solid #e5e7eb',
            borderRadius: '10px',
            padding: '12px 16px',
            fontSize: '14px',
            fontFamily: "'Outfit', sans-serif",
            outline: 'none',
            marginBottom: '12px',
            boxSizing: 'border-box',
            transition: 'border-color 0.2s ease',
          }}
          onFocus={(e) => (e.target.style.borderColor = '#38bdf8')}
          onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
        />

        {/* Password */}
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          type="password"
          disabled={loading}
          onKeyDown={(e) => e.key === 'Enter' && !loading && email && password && handleSubmit()}
          style={{
            width: '100%',
            border: '1px solid #e5e7eb',
            borderRadius: '10px',
            padding: '12px 16px',
            fontSize: '14px',
            fontFamily: "'Outfit', sans-serif",
            outline: 'none',
            marginBottom: '16px',
            boxSizing: 'border-box',
            transition: 'border-color 0.2s ease',
          }}
          onFocus={(e) => (e.target.style.borderColor = '#38bdf8')}
          onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
        />

        {/* Sign in button */}
        <button
          onClick={handleSubmit}
          disabled={loading || !email || !password}
          style={{
            width: '100%',
            backgroundColor: loading || !email || !password ? '#94a3b8' : '#0f172a',
            color: '#ffffff',
            fontFamily: "'Outfit', sans-serif",
            fontWeight: 600,
            fontSize: '14px',
            borderRadius: '10px',
            padding: '14px',
            border: 'none',
            cursor: loading || !email || !password ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s ease',
          }}
        >
          {loading ? (
            <span className="inline-flex items-center gap-2">
              <svg
                className="animate-spin"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray="31.4 31.4"
                  strokeDashoffset="10"
                />
              </svg>
              Signing in...
            </span>
          ) : (
            'Sign in'
          )}
        </button>

        {/* Forgot password */}
        <div style={{ textAlign: 'center', marginTop: '12px' }}>
          {resetSent ? (
            <p
              style={{
                fontFamily: "'Outfit', sans-serif",
                fontSize: '13px',
                color: '#22c55e',
              }}
            >
              Reset link sent — check your email.
            </p>
          ) : (
            <button
              onClick={handleResetPassword}
              type="button"
              style={{
                background: 'none',
                border: 'none',
                fontFamily: "'Outfit', sans-serif",
                fontSize: '13px',
                color: '#94a3b8',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              Forgot password?
            </button>
          )}
        </div>

        {/* Error message */}
        {error && (
          <p
            style={{
              color: '#ef4444',
              fontSize: '13px',
              fontFamily: "'Outfit', sans-serif",
              marginTop: '12px',
              textAlign: 'center',
            }}
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
