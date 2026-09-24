import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AppShell';
import { ColourPicker, WorkingDaysEditor } from './AdminPage';

const font = "'Outfit', sans-serif";

/*
  My Settings — /settings/me. Available to every logged-in staff member.

  Edits the caller's OWN staff_profiles row, and only the columns
  name / colour / working_days. Saves go through the SECURITY DEFINER
  RPC update_own_profile (sql/123_settings_area.sql) because
  staff_profiles has no self-update RLS policy — only portal admins
  can update rows directly. The RPC whitelists the three columns so
  permission flags can never be self-edited.
*/
export default function UserSettingsPage() {
  const { profile } = useAuth();

  const [name, setName] = useState('');
  const [colour, setColour] = useState(null);
  const [workingDays, setWorkingDays] = useState('mon,tue,wed,thu,fri');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null); // { tone: 'success' | 'error', text }
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setName(profile.name || '');
    setColour(profile.colour || null);
    setWorkingDays(profile.working_days || 'mon,tue,wed,thu,fri');
  }, [profile?.id]);

  const navigate = useNavigate();
  // Two-factor status for the Security card (the full page is /security).
  const [mfaOn, setMfaOn] = useState(null);
  useEffect(() => {
    let cancelled = false;
    supabase.auth.mfa.listFactors()
      .then(({ data }) => { if (!cancelled) setMfaOn((data?.totp || []).some((f) => f.status === 'verified')); })
      .catch(() => { if (!cancelled) setMfaOn(null); });
    return () => { cancelled = true; };
  }, []);

  const markDirty = () => { setDirty(true); setMsg(null); };

  const save = async () => {
    if (!profile?.id) return;
    setSaving(true);
    setMsg(null);
    try {
      const { error } = await supabase.rpc('update_own_profile', {
        p_name: name.trim(),
        p_colour: colour || null,
        p_working_days: workingDays,
      });
      if (error) {
        // RPC not applied yet? Try a direct update of just these columns —
        // works only if an RLS self-update policy exists (admins qualify).
        if (error.code === '42883' || /update_own_profile/i.test(error.message || '')) {
          const { error: updErr } = await supabase
            .from('staff_profiles')
            .update({
              name: name.trim() || profile.name,
              colour: colour || null,
              working_days: workingDays,
            })
            .eq('id', profile.id);
          if (updErr) throw new Error(
            'Could not save — the update_own_profile function is missing (apply sql/123_settings_area.sql).'
          );
        } else {
          throw error;
        }
      }
      setDirty(false);
      setMsg({ tone: 'success', text: 'Saved. Your avatar colour updates on the next page reload.' });
    } catch (err) {
      setMsg({ tone: 'error', text: String(err.message || err) });
    }
    setSaving(false);
  };

  const labelStyle = {
    fontFamily: font, fontSize: 13, fontWeight: 600, color: '#64748b',
    display: 'block', marginBottom: 6,
  };
  const inputStyle = {
    width: '100%', border: '1px solid #e5e7eb', borderRadius: 10,
    padding: '10px 14px', fontSize: 14, fontFamily: font, outline: 'none',
    boxSizing: 'border-box', transition: 'border-color 0.2s ease',
  };
  const card = {
    background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 22,
  };
  const cardTitle = { fontFamily: font, fontSize: 16, fontWeight: 600, color: '#0f172a', margin: '0 0 16px' };
  const hint = { fontFamily: font, fontSize: 13, color: '#94a3b8', marginTop: 6 };

  // Full-width page, fields grouped into cards side by side (UI audit,
  // Sprint 3: forms go into columns rather than stretching one field across).
  return (
    <div style={{ padding: '40px 32px' }}>
      <h1
        style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: 28,
          fontWeight: 500,
          color: '#0f172a',
          marginBottom: 8,
        }}
      >
        My Settings
      </h1>
      <p style={{ fontFamily: font, fontSize: 14.5, color: '#64748b', marginBottom: 24 }}>
        How your name and colour appear across Athena, and the days you work.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, alignItems: 'start' }}>
        {/* Profile — the wide card */}
        <section style={{ ...card, gridColumn: 'span 2' }}>
          <h2 style={cardTitle}>Profile</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 18 }}>
            <div>
              <label style={labelStyle}>Name</label>
              <input
                value={name}
                onChange={(e) => { setName(e.target.value); markDirty(); }}
                placeholder="Your name"
                style={inputStyle}
                onFocus={(e) => (e.target.style.borderColor = '#1E4560')}
                onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
              />
            </div>
            <div>
              <label style={labelStyle}>Sign-in email</label>
              <input
                value={profile?.email || ''}
                readOnly
                disabled
                style={{ ...inputStyle, background: '#f8fafc', color: '#94a3b8' }}
              />
              <p style={hint}>An admin changes this on Staff &amp; Permissions.</p>
            </div>
          </div>
          <label style={labelStyle}>Colour</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ColourPicker
              colour={colour}
              onChange={(c) => { setColour(c); markDirty(); }}
            />
            <span style={{ fontFamily: font, fontSize: 13, color: '#94a3b8' }}>
              Your avatar and planner entries.
            </span>
          </div>
        </section>

        {/* Working week */}
        <section style={card}>
          <h2 style={cardTitle}>Working week</h2>
          <label style={labelStyle}>Days you work</label>
          <div style={{ display: 'inline-block' }}>
            <WorkingDaysEditor
              value={workingDays}
              onChange={(days) => { setWorkingDays(days); markDirty(); }}
            />
          </div>
          <p style={hint}>Used when your planner work is scheduled.</p>
        </section>

        {/* Security — status plus the way in (was only in the avatar menu) */}
        <section style={card}>
          <h2 style={cardTitle}>Security</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: font, fontSize: 14, color: '#334155' }}>
            {mfaOn === false
              ? <><ShieldAlert size={16} color="#b45309" /> Two-factor sign-in is off</>
              : <><ShieldCheck size={16} color="#16a34a" /> Two-factor sign-in {mfaOn ? 'is on' : ''}</>}
          </div>
          <p style={hint}>Your password, authenticator app and trusted devices.</p>
          <a
            href="/security"
            onClick={(e) => { e.preventDefault(); navigate('/security'); }}
            style={{ display: 'inline-block', marginTop: 12, fontFamily: font, fontSize: 14, fontWeight: 600, color: '#1E4560', textDecoration: 'none' }}
          >
            Manage security →
          </a>
        </section>
      </div>

      {/* Save */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, marginTop: 18 }}>
        {msg && (
          <p style={{
            fontFamily: font, fontSize: 14, margin: 0,
            color: msg.tone === 'success' ? '#16a34a' : '#ef4444',
          }}>
            {msg.text}
          </p>
        )}
        <button
          onClick={save}
          disabled={saving || !dirty}
          style={{
            fontFamily: font, fontSize: 14, fontWeight: 600, color: '#fff',
            backgroundColor: saving || !dirty ? '#94a3b8' : '#1E4560',
            border: 'none', borderRadius: 10, padding: '10px 24px',
            cursor: saving ? 'wait' : dirty ? 'pointer' : 'default',
            transition: 'all 0.2s ease',
          }}
        >
          {saving ? 'Saving...' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
