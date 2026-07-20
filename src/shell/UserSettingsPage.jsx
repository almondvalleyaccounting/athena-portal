import React, { useState, useEffect } from 'react';
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
    fontFamily: font, fontSize: 12, fontWeight: 600, color: '#64748b',
    display: 'block', marginBottom: 6,
  };

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 24px' }}>
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
      <p style={{ fontFamily: font, fontSize: 14, color: '#64748b', marginBottom: 24 }}>
        Your own profile — how your name and colour appear across Athena.
      </p>

      <div
        style={{
          background: '#fff',
          border: '1px solid #e5e7eb',
          borderRadius: 12,
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        {/* Name */}
        <div>
          <label style={labelStyle}>Name</label>
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); markDirty(); }}
            placeholder="Your name"
            style={{
              width: '100%', maxWidth: 360, border: '1px solid #e5e7eb', borderRadius: 10,
              padding: '10px 14px', fontSize: 13, fontFamily: font, outline: 'none',
              boxSizing: 'border-box', transition: 'border-color 0.2s ease',
            }}
            onFocus={(e) => (e.target.style.borderColor = '#0e7fe0')}
            onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
          />
        </div>

        {/* Email — read-only */}
        <div>
          <label style={labelStyle}>Email</label>
          <input
            value={profile?.email || ''}
            readOnly
            disabled
            style={{
              width: '100%', maxWidth: 360, border: '1px solid #e5e7eb', borderRadius: 10,
              padding: '10px 14px', fontSize: 13, fontFamily: font, outline: 'none',
              boxSizing: 'border-box', background: '#f8fafc', color: '#94a3b8',
            }}
          />
          <p style={{ fontFamily: font, fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
            Ask an admin on Staff &amp; Permissions to change your sign-in email.
          </p>
        </div>

        {/* Colour */}
        <div>
          <label style={labelStyle}>Colour</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ColourPicker
              colour={colour}
              onChange={(c) => { setColour(c); markDirty(); }}
            />
            <span style={{ fontFamily: font, fontSize: 12, color: '#94a3b8' }}>
              Used for your avatar and planner entries.
            </span>
          </div>
        </div>

        {/* Working days */}
        <div>
          <label style={labelStyle}>Working days</label>
          <div style={{ display: 'inline-block' }}>
            <WorkingDaysEditor
              value={workingDays}
              onChange={(days) => { setWorkingDays(days); markDirty(); }}
            />
          </div>
        </div>

        {/* Save */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderTop: '1px solid #f1f5f9', paddingTop: 16 }}>
          <button
            onClick={save}
            disabled={saving || !dirty}
            style={{
              fontFamily: font, fontSize: 13, fontWeight: 600, color: '#fff',
              backgroundColor: saving || !dirty ? '#94a3b8' : '#0e7fe0',
              border: 'none', borderRadius: 10, padding: '10px 24px',
              cursor: saving ? 'wait' : dirty ? 'pointer' : 'default',
              transition: 'all 0.2s ease',
            }}
          >
            {saving ? 'Saving...' : 'Save changes'}
          </button>
          {msg && (
            <p style={{
              fontFamily: font, fontSize: 13,
              color: msg.tone === 'success' ? '#16a34a' : '#ef4444',
            }}>
              {msg.text}
            </p>
          )}
        </div>
      </div>

      <p style={{ fontFamily: font, fontSize: 12, color: '#94a3b8', marginTop: 16 }}>
        Password and two-factor settings live under Security &amp; 2FA in the avatar menu.
        Module permissions are managed by admins on Staff &amp; Permissions.
      </p>
    </div>
  );
}
