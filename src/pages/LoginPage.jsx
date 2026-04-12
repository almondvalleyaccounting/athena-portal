import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Btn } from '../components/ui';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignup, setIsSignup] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setError('');
    setInfo('');
    setLoading(true);

    try {
      if (isSignup) {
        const { data, error: err } = await supabase.auth.signUp({ email, password });
        if (err) throw err;
        // If email confirmation is required, user won't have a session yet
        if (!data.session) {
          setInfo('Account created. Check your email for confirmation, then sign in.');
          setIsSignup(false);
        }
        // If auto-confirmed, the onAuthStateChange listener in App.jsx will pick it up
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
        // Session picked up by onAuthStateChange in App.jsx
      }
    } catch (e) {
      setError(e.message || 'Authentication failed');
    }

    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <img
            src="/ava-logo.jpg"
            alt="Almond Valley Accounting"
            className="w-32 h-auto mx-auto mb-4"
            style={{ imageRendering: 'auto' }}
          />
          <h1 className="text-2xl font-bold text-ocean-700 tracking-tight">ATHENA</h1>
          <p className="text-xs text-gray-400 mt-1">Fee Engine</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">
            {isSignup ? 'Create Account' : 'Sign In'}
          </h2>

          {error && <div className="text-xs text-red-600 bg-red-50 rounded p-2 mb-3">{error}</div>}
          {info && <div className="text-xs text-ocean-600 bg-ocean-50 rounded p-2 mb-3">{info}</div>}

          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            type="email"
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 mb-2"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            type="password"
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 mb-4"
          />

          <Btn onClick={handleSubmit} disabled={loading || !email || !password} className="w-full">
            {loading ? '...' : isSignup ? 'Create Account' : 'Sign In'}
          </Btn>

          <button
            onClick={() => { setIsSignup(!isSignup); setError(''); setInfo(''); }}
            className="w-full text-xs text-gray-400 hover:text-ocean-600 mt-3"
          >
            {isSignup ? 'Already have an account? Sign in' : 'First time? Create account'}
          </button>
        </div>
      </div>
    </div>
  );
}
