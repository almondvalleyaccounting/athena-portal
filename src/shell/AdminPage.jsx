import React, { useState, useEffect, useRef } from 'react';
import { Palette } from 'lucide-react';
import { supabase } from '../lib/supabase';

/*
  Permission columns on staff_profiles that map to module access.
  Each entry: { key: DB column name, label: display label }
*/
const PERMISSION_COLS = [
  { key: 'can_view_quotes', label: 'Fee Engine' },
  { key: 'can_edit_quotes', label: 'Edit quotes' },
  { key: 'can_approve_quotes', label: 'Approve quotes' },
  { key: 'can_edit_fee_schedule', label: 'Edit pricing' },
  { key: 'can_view_client_fees', label: 'Client fees' },
  { key: 'can_view_reports', label: 'Reports' },
  { key: 'can_view_work_planner', label: 'Work planner' },
  { key: 'can_view_timesheets', label: 'Timesheets' },
  { key: 'can_view_pd_tracker', label: 'PD tracker' },
  { key: 'can_manage_portal', label: 'Portal admin' },
];

const SELECT_COLS = [
  'id', 'name', 'email', 'is_active', 'colour',
  ...PERMISSION_COLS.map((p) => p.key),
].join(', ');

const COLOUR_SWATCHES = [
  '#0e7fe0', '#2563eb', '#3b82f6', '#60a5fa', '#38bdf8',
  '#059669', '#10b981', '#15803d', '#65a30d',
  '#d97706', '#f59e0b', '#eab308', '#ca8a04',
  '#dc2626', '#ef4444', '#db2777',
  '#7c3aed', '#8b5cf6', '#4f46e5',
  '#0891b2', '#0d9488',
  '#0f172a', '#475569', '#64748b',
];

export default function AdminPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [deleting, setDeleting] = useState(null); // user id while deleting

  // Invite form state
  const [showInvite, setShowInvite] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [invitePassword, setInvitePassword] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState('');

  const fetchUsers = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('staff_profiles')
      .select(SELECT_COLS)
      .order('name', { ascending: true });
    setUsers(data || []);
    setLoading(false);
  };

  useEffect(() => { fetchUsers(); }, []);

  const togglePermission = async (userId, key, currentValue) => {
    const tag = `${userId}:${key}`;
    setSaving(tag);

    const { error } = await supabase
      .from('staff_profiles')
      .update({ [key]: !currentValue })
      .eq('id', userId);

    if (!error) {
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, [key]: !currentValue } : u))
      );
    }
    setSaving(null);
  };

  const setUserColour = async (userId, colour) => {
    setSaving(`${userId}:colour`);
    const { error } = await supabase
      .from('staff_profiles')
      .update({ colour: colour || null })
      .eq('id', userId);

    if (!error) {
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, colour } : u))
      );
    }
    setSaving(null);
  };

  const handleInvite = async () => {
    setInviteError('');
    setInviteSuccess('');

    if (!inviteName.trim() || !inviteEmail.trim() || !invitePassword.trim()) {
      setInviteError('All fields are required.');
      return;
    }
    if (invitePassword.length < 6) {
      setInviteError('Password must be at least 6 characters.');
      return;
    }

    setInviting(true);

    try {
      // Call the Edge Function to create the user
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invite-user`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            name: inviteName.trim(),
            email: inviteEmail.trim(),
            password: invitePassword.trim(),
          }),
        }
      );

      const result = await resp.json();
      if (!result.success) {
        throw new Error(result.error || 'Failed to create user');
      }

      setInviteSuccess(`${inviteName.trim()} has been added. They can sign in now.`);
      setInviteName('');
      setInviteEmail('');
      setInvitePassword('');
      fetchUsers();
    } catch (err) {
      setInviteError(String(err.message || err));
    }

    setInviting(false);
  };

  const handleDelete = async (user) => {
    if (!window.confirm(`Delete ${user.name || user.email}? This cannot be undone.`)) return;

    setDeleting(user.id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/delete-user`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ user_id: user.id }),
        }
      );
      const result = await resp.json();
      if (result.success) {
        setUsers((prev) => prev.filter((u) => u.id !== user.id));
      } else {
        alert(result.error || 'Failed to delete user');
      }
    } catch (err) {
      alert(String(err));
    }
    setDeleting(null);
  };

  const displayName = (u) => u.name || u.email || 'Unknown';

  const inputStyle = {
    width: '100%',
    border: '1px solid #e5e7eb',
    borderRadius: '10px',
    padding: '10px 14px',
    fontSize: '13px',
    fontFamily: "'Outfit', sans-serif",
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.2s ease',
  };

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '40px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <h1
          style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: '28px',
            fontWeight: 500,
            color: '#0f172a',
          }}
        >
          Admin
        </h1>
        <button
          onClick={() => { setShowInvite(!showInvite); setInviteError(''); setInviteSuccess(''); }}
          style={{
            fontFamily: "'Outfit', sans-serif",
            fontSize: '13px',
            fontWeight: 600,
            color: '#ffffff',
            backgroundColor: '#0f172a',
            border: 'none',
            borderRadius: '10px',
            padding: '10px 20px',
            cursor: 'pointer',
            transition: 'opacity 0.2s ease',
          }}
        >
          {showInvite ? 'Cancel' : '+ Add user'}
        </button>
      </div>
      <p
        style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: '14px',
          color: '#64748b',
          marginBottom: '24px',
        }}
      >
        Manage user access to portal modules.
      </p>

      {/* Invite user form */}
      {showInvite && (
        <div
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e5e7eb',
            borderRadius: '12px',
            padding: '24px',
            marginBottom: '24px',
          }}
        >
          <h3
            style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: '15px',
              fontWeight: 600,
              color: '#0f172a',
              marginBottom: '16px',
            }}
          >
            Add new user
          </h3>
          <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 180px' }}>
              <label style={{ fontFamily: "'Outfit', sans-serif", fontSize: '12px', fontWeight: 600, color: '#64748b', display: 'block', marginBottom: '4px' }}>
                Full name
              </label>
              <input
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                placeholder="e.g. Tracy Smith"
                disabled={inviting}
                style={inputStyle}
                onFocus={(e) => (e.target.style.borderColor = '#38bdf8')}
                onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
              />
            </div>
            <div style={{ flex: '1 1 220px' }}>
              <label style={{ fontFamily: "'Outfit', sans-serif", fontSize: '12px', fontWeight: 600, color: '#64748b', display: 'block', marginBottom: '4px' }}>
                Email
              </label>
              <input
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="tracy@example.com"
                type="email"
                disabled={inviting}
                style={inputStyle}
                onFocus={(e) => (e.target.style.borderColor = '#38bdf8')}
                onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
              />
            </div>
            <div style={{ flex: '1 1 160px' }}>
              <label style={{ fontFamily: "'Outfit', sans-serif", fontSize: '12px', fontWeight: 600, color: '#64748b', display: 'block', marginBottom: '4px' }}>
                Temporary password
              </label>
              <input
                value={invitePassword}
                onChange={(e) => setInvitePassword(e.target.value)}
                placeholder="min 6 characters"
                type="text"
                disabled={inviting}
                style={inputStyle}
                onFocus={(e) => (e.target.style.borderColor = '#38bdf8')}
                onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
              />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button
              onClick={handleInvite}
              disabled={inviting}
              style={{
                fontFamily: "'Outfit', sans-serif",
                fontSize: '13px',
                fontWeight: 600,
                color: '#ffffff',
                backgroundColor: inviting ? '#94a3b8' : '#38bdf8',
                border: 'none',
                borderRadius: '10px',
                padding: '10px 24px',
                cursor: inviting ? 'wait' : 'pointer',
                transition: 'all 0.2s ease',
              }}
            >
              {inviting ? 'Creating...' : 'Create user'}
            </button>
            {inviteError && (
              <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: '13px', color: '#ef4444' }}>
                {inviteError}
              </p>
            )}
            {inviteSuccess && (
              <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: '13px', color: '#22c55e' }}>
                {inviteSuccess}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Permissions grid */}
      {loading ? (
        <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: '14px', color: '#94a3b8' }}>
          Loading users...
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'separate',
              borderSpacing: 0,
              fontFamily: "'Outfit', sans-serif",
              fontSize: '13px',
            }}
          >
            <thead>
              <tr>
                <th
                  style={{
                    textAlign: 'left',
                    padding: '10px 16px',
                    fontWeight: 600,
                    color: '#0f172a',
                    borderBottom: '2px solid #e5e7eb',
                    whiteSpace: 'nowrap',
                    position: 'sticky',
                    left: 0,
                    backgroundColor: '#fafafa',
                    zIndex: 1,
                  }}
                >
                  User
                </th>
                <th
                  style={{
                    textAlign: 'center',
                    padding: '10px 12px',
                    fontWeight: 600,
                    color: '#0f172a',
                    borderBottom: '2px solid #e5e7eb',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Colour
                </th>
                {PERMISSION_COLS.map((col) => (
                  <th
                    key={col.key}
                    style={{
                      textAlign: 'center',
                      padding: '10px 12px',
                      fontWeight: 600,
                      color: '#0f172a',
                      borderBottom: '2px solid #e5e7eb',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {col.label}
                  </th>
                ))}
                <th
                  style={{
                    textAlign: 'center',
                    padding: '10px 12px',
                    fontWeight: 600,
                    color: '#0f172a',
                    borderBottom: '2px solid #e5e7eb',
                    whiteSpace: 'nowrap',
                    width: '1%',
                  }}
                />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td
                    style={{
                      padding: '10px 16px',
                      borderBottom: '1px solid #f1f5f9',
                      whiteSpace: 'nowrap',
                      position: 'sticky',
                      left: 0,
                      backgroundColor: '#fafafa',
                      zIndex: 1,
                    }}
                  >
                    <div style={{ fontWeight: 500, color: '#0f172a' }}>
                      {displayName(user)}
                    </div>
                    <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                      {user.email}
                    </div>
                  </td>
                  <td
                    style={{
                      textAlign: 'center',
                      padding: '6px 8px',
                      borderBottom: '1px solid #f1f5f9',
                    }}
                  >
                    <ColourPicker
                      colour={user.colour}
                      onChange={(c) => setUserColour(user.id, c)}
                    />
                  </td>
                  {PERMISSION_COLS.map((col) => {
                    const val = user[col.key] === true;
                    const isSaving = saving === `${user.id}:${col.key}`;
                    return (
                      <td
                        key={col.key}
                        style={{
                          textAlign: 'center',
                          padding: '10px 12px',
                          borderBottom: '1px solid #f1f5f9',
                        }}
                      >
                        <button
                          onClick={() => togglePermission(user.id, col.key, val)}
                          disabled={isSaving}
                          style={{
                            width: '22px',
                            height: '22px',
                            borderRadius: '6px',
                            border: val ? 'none' : '2px solid #d1d5db',
                            backgroundColor: val ? '#0f172a' : '#ffffff',
                            cursor: isSaving ? 'wait' : 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            transition: 'all 0.15s ease',
                            opacity: isSaving ? 0.5 : 1,
                          }}
                          title={`${val ? 'Remove' : 'Grant'} ${col.label} for ${displayName(user)}`}
                        >
                          {val && (
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                              <path
                                d="M2.5 6L5 8.5L9.5 3.5"
                                stroke="#ffffff"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </button>
                      </td>
                    );
                  })}
                  <td
                    style={{
                      textAlign: 'center',
                      padding: '10px 8px',
                      borderBottom: '1px solid #f1f5f9',
                    }}
                  >
                    <button
                      onClick={() => handleDelete(user)}
                      disabled={deleting === user.id}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: deleting === user.id ? 'wait' : 'pointer',
                        padding: '4px',
                        opacity: deleting === user.id ? 0.4 : 0.4,
                        transition: 'opacity 0.15s ease',
                      }}
                      onMouseEnter={(e) => { if (deleting !== user.id) e.currentTarget.style.opacity = '1'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.4'; }}
                      title={`Delete ${displayName(user)}`}
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path d="M2 4h10M5 4V3a1 1 0 011-1h2a1 1 0 011 1v1M11 4v7a1 1 0 01-1 1H4a1 1 0 01-1-1V4" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ─── Colour picker: palette icon → popover with swatches ── */
function ColourPicker({ colour, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: 28, height: 28, borderRadius: 6, border: '1px solid #e5e7eb',
          background: colour || '#fff', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          transition: 'border-color 0.15s',
        }}
        title={colour || 'Default colour'}
      >
        {!colour && <Palette size={14} style={{ color: '#94a3b8' }} />}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
          marginTop: 6, background: '#fff', border: '1px solid #e5e7eb',
          borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          padding: 10, zIndex: 50, width: 180,
        }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: colour ? 8 : 0 }}>
            {COLOUR_SWATCHES.map((c) => (
              <div
                key={c}
                onClick={() => { onChange(c); setOpen(false); }}
                style={{
                  width: 20, height: 20, borderRadius: 4, background: c, cursor: 'pointer',
                  border: colour === c ? '2px solid #0f172a' : '1px solid #e5e7eb',
                  transition: 'transform 0.1s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.2)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
              />
            ))}
          </div>
          {colour && (
            <button
              onClick={() => { onChange(null); setOpen(false); }}
              style={{
                width: '100%', fontSize: 11, color: '#94a3b8', background: 'none',
                border: 'none', cursor: 'pointer', padding: '4px 0',
                fontFamily: "'Outfit', sans-serif", fontWeight: 500,
              }}
            >
              Reset to default
            </button>
          )}
        </div>
      )}
    </div>
  );
}
