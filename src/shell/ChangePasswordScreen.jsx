import React, { useState } from 'react';
import { supabase } from '../lib/supabase';

export default function ChangePasswordScreen({ onComplete, onLogout }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    setError('');

    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setSaving(true);

    const { error: updateError } = await supabase.auth.updateUser({
      password,
    });

    if (updateError) {
      setError(updateError.message);
      setSaving(false);
      return;
    }

    await onComplete();
  };

  const inputStyle = {
    width: '100%',
    border: '1px solid #e5e7eb',
    borderRadius: '10px',
    padding: '12px 16px',
    fontSize: '14px',
    fontFamily: "'Outfit', sans-serif",
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.2s ease',
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{ backgroundColor: '#fafafa' }}
    >
      <div
        style={{
          backgroundColor: '#ffffff',
          borderRadius: '16px',
          padding: '40px',
          maxWidth: '420px',
          width: '100%',
          border: '1px solid #e5e7eb',
        }}
      >
        <div className="flex justify-center mb-4">
          <img
            src="/ava-logo.jpg"
            alt="AVA"
            style={{ width: '48px', height: '48px', borderRadius: '8px' }}
          />
        </div>

        <h2
          style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: '22px',
            fontWeight: 500,
            color: '#0f172a',
            textAlign: 'center',
            marginBottom: '8px',
          }}
        >
          Set your password
        </h2>
        <p
          style={{
            fontFamily: "'Outfit', sans-serif",
            fontSize: '14px',
            color: '#64748b',
            textAlign: 'center',
            marginBottom: '24px',
            lineHeight: '1.5',
          }}
        >
          Please choose a new password before continuing.
        </p>

        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="New password"
          type="password"
          disabled={saving}
          style={{ ...inputStyle, marginBottom: '12px' }}
          onFocus={(e) => (e.target.style.borderColor = '#38bdf8')}
          onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
        />

        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Confirm password"
          type="password"
          disabled={saving}
          onKeyDown={(e) => e.key === 'Enter' && !saving && password && confirm && handleSubmit()}
          style={{ ...inputStyle, marginBottom: '16px' }}
          onFocus={(e) => (e.target.style.borderColor = '#38bdf8')}
          onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
        />

        <button
          onClick={handleSubmit}
          disabled={saving || !password || !confirm}
          style={{
            width: '100%',
            backgroundColor: saving || !password || !confirm ? '#94a3b8' : '#0f172a',
            color: '#ffffff',
            fontFamily: "'Outfit', sans-serif",
            fontWeight: 600,
            fontSize: '14px',
            borderRadius: '10px',
            padding: '14px',
            border: 'none',
            cursor: saving || !password || !confirm ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s ease',
          }}
        >
          {saving ? 'Saving...' : 'Set password'}
        </button>

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

        <div style={{ textAlign: 'center', marginTop: '16px' }}>
          <button
            onClick={onLogout}
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
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
