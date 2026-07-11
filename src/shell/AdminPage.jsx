import React, { useState, useEffect, useRef } from 'react';
import { Palette, UserPlus, Pencil, Check, X } from 'lucide-react';
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
  { key: 'work_planner', label: 'Work planner' },
  { key: 'can_view_timesheets', label: 'Timesheets' },
  { key: 'can_view_billing', label: 'Billing' },
  { key: 'can_approve_billing', label: 'Approve billing' },
  { key: 'can_view_pd_tracker', label: 'CPD Tracker' },
  { key: 'can_view_onboarding', label: 'Onboarding' },
  { key: 'can_import_data', label: 'Data Import' },
  { key: 'can_manage_portal', label: 'Portal admin' },
];

// Use select('*') to avoid failing on missing columns — the admin page
// renders whatever columns exist and toggles create them on first use
const SELECT_COLS = '*';

const font = "'Outfit', sans-serif";

const COLOUR_SWATCHES = [
  '#b91c1c', '#dc2626', '#ef4444', '#f87171', '#fca5a5',
  '#c2410c', '#ea580c', '#f97316', '#fb923c', '#fdba74',
  '#ca8a04', '#eab308', '#f59e0b', '#facc15', '#fde047',
  '#15803d', '#16a34a', '#22c55e', '#4ade80', '#86efac',
  '#0f766e', '#0d9488', '#14b8a6', '#2dd4bf', '#5eead4',
  '#0e7490', '#0891b2', '#06b6d4', '#22d3ee', '#67e8f9',
  '#1d4ed8', '#2563eb', '#3b82f6', '#60a5fa', '#38bdf8',
  '#4f46e5', '#6366f1', '#7c3aed', '#8b5cf6', '#a78bfa',
  '#be185d', '#db2777', '#ec4899', '#f472b6', '#f9a8d4',
  '#0f172a', '#334155', '#475569', '#64748b', '#94a3b8',
];

export default function AdminPage() {
  const [users, setUsers] = useState([]);
  const [authUsers, setAuthUsers] = useState([]);
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

  // Create-profile form for unlinked auth accounts
  const [showCreateFor, setShowCreateFor] = useState(null);
  const [createForm, setCreateForm] = useState({ full_name: '' });

  // Inline edit state
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', email: '' });

  const fetchUsers = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('staff_profiles')
      .select(SELECT_COLS)
      .order('name', { ascending: true });
    setUsers(data || []);

    // Try to fetch auth users (requires list_auth_users function)
    try {
      const { data: auths, error: authErr } = await supabase.rpc('list_auth_users');
      if (!authErr) setAuthUsers(auths || []);
    } catch {
      // Function may not exist yet — silently skip
    }

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

  // ── Create profile for unlinked auth user ──
  const handleCreateProfile = async (authUser) => {
    setSaving('create');
    try {
      const newProfile = {
        id: authUser.id,
        name: createForm.full_name.trim() || authUser.email.split('@')[0],
        email: authUser.email,
        is_active: true,
        must_change_password: false,
      };
      const { error: insertErr } = await supabase.from('staff_profiles').insert(newProfile);
      if (insertErr) throw insertErr;
      setShowCreateFor(null);
      setCreateForm({ full_name: '' });
      fetchUsers();
    } catch (err) {
      alert(String(err.message || err));
    }
    setSaving(null);
  };

  // ── Start inline edit ──
  const startEdit = (user) => {
    setEditingId(user.id);
    setEditForm({ name: user.name || '', email: user.email || '' });
  };

  // ── Save inline edit ──
  const saveEdit = async (userId) => {
    setSaving(`${userId}:edit`);
    const user = users.find((u) => u.id === userId);
    try {
      // Update name
      if (editForm.name !== user.name) {
        const { error } = await supabase
          .from('staff_profiles')
          .update({ name: editForm.name })
          .eq('id', userId);
        if (error) throw error;
      }
      // Update email (via RPC if available, otherwise just staff_profiles)
      if (editForm.email !== user.email) {
        const { error: rpcErr } = await supabase.rpc('admin_update_user_email', {
          p_user_id: userId,
          p_new_email: editForm.email,
        });
        if (rpcErr) {
          // Fallback: update just staff_profiles if RPC doesn't exist
          const { error } = await supabase
            .from('staff_profiles')
            .update({ email: editForm.email })
            .eq('id', userId);
          if (error) throw error;
        }
      }
      setUsers((prev) =>
        prev.map((u) => u.id === userId ? { ...u, name: editForm.name, email: editForm.email } : u)
      );
      setEditingId(null);
    } catch (err) {
      alert(String(err.message || err));
    }
    setSaving(null);
  };

  // Find auth users without a staff profile
  const profileIds = new Set(users.map((u) => u.id));
  const unlinkedUsers = authUsers.filter((u) => !profileIds.has(u.id));

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
          Staff &amp; Permissions
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

      {/* Unlinked auth accounts */}
      {unlinkedUsers.length > 0 && (
        <div style={{ marginBottom: '24px' }}>
          <div
            style={{
              backgroundColor: '#fffbeb',
              border: '1px solid #fde68a',
              borderRadius: '12px',
              padding: '16px 20px',
            }}
          >
            <h3 style={{ fontFamily: font, fontSize: '14px', fontWeight: 600, color: '#92400e', marginBottom: '8px' }}>
              Accounts without profiles ({unlinkedUsers.length})
            </h3>
            <p style={{ fontFamily: font, fontSize: '13px', color: '#a16207', marginBottom: '12px' }}>
              These users have login accounts but no staff profile. They see "Access pending" when they sign in.
            </p>
            {unlinkedUsers.map((authUser) => (
              <div
                key={authUser.id}
                style={{
                  backgroundColor: '#ffffff',
                  border: '1px solid #e5e7eb',
                  borderRadius: '10px',
                  padding: '12px 16px',
                  marginBottom: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '8px',
                }}
              >
                <div>
                  <span style={{ fontFamily: font, fontSize: '14px', fontWeight: 500, color: '#0f172a' }}>
                    {authUser.email}
                  </span>
                  <span style={{ fontFamily: font, fontSize: '12px', color: '#94a3b8', marginLeft: '8px' }}>
                    Created {new Date(authUser.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </span>
                </div>
                {showCreateFor === authUser.id ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <input
                      value={createForm.full_name}
                      onChange={(e) => setCreateForm({ full_name: e.target.value })}
                      placeholder="Full name"
                      style={{
                        fontFamily: font, fontSize: '13px', padding: '8px 12px',
                        border: '1px solid #e5e7eb', borderRadius: '8px', outline: 'none', width: '180px',
                      }}
                      onFocus={(e) => (e.target.style.borderColor = '#38bdf8')}
                      onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
                    />
                    <button
                      onClick={() => handleCreateProfile(authUser)}
                      disabled={!createForm.full_name.trim() || saving === 'create'}
                      style={{
                        fontFamily: font, fontSize: '12px', fontWeight: 600, color: '#fff',
                        backgroundColor: !createForm.full_name.trim() ? '#94a3b8' : '#0f172a',
                        border: 'none', borderRadius: '8px', padding: '8px 14px',
                        cursor: !createForm.full_name.trim() ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {saving === 'create' ? 'Creating...' : 'Create'}
                    </button>
                    <button
                      onClick={() => { setShowCreateFor(null); setCreateForm({ full_name: '' }); }}
                      style={{
                        fontFamily: font, fontSize: '12px', color: '#64748b',
                        background: 'none', border: '1px solid #e5e7eb', borderRadius: '8px',
                        padding: '8px 12px', cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowCreateFor(authUser.id)}
                    style={{
                      fontFamily: font, fontSize: '12px', fontWeight: 600, color: '#fff',
                      backgroundColor: '#38bdf8', border: 'none', borderRadius: '8px',
                      padding: '8px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
                    }}
                  >
                    <UserPlus size={14} />
                    Create profile
                  </button>
                )}
              </div>
            ))}
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
                  Working Days
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
                      minWidth: '200px',
                    }}
                  >
                    {editingId === user.id ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <input
                          value={editForm.name}
                          onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                          placeholder="Name"
                          style={{
                            fontFamily: font, fontSize: '13px', padding: '4px 8px',
                            border: '1px solid #e5e7eb', borderRadius: '6px', outline: 'none', width: '100%',
                          }}
                          onFocus={(e) => (e.target.style.borderColor = '#38bdf8')}
                          onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
                        />
                        <input
                          value={editForm.email}
                          onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                          placeholder="Email"
                          style={{
                            fontFamily: font, fontSize: '11px', padding: '4px 8px',
                            border: '1px solid #e5e7eb', borderRadius: '6px', outline: 'none', width: '100%',
                          }}
                          onFocus={(e) => (e.target.style.borderColor = '#38bdf8')}
                          onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
                        />
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <button
                            onClick={() => saveEdit(user.id)}
                            disabled={saving === `${user.id}:edit`}
                            style={{
                              background: 'none', border: 'none', cursor: 'pointer', padding: '2px',
                              color: '#22c55e', display: 'flex', alignItems: 'center',
                            }}
                            title="Save"
                          >
                            <Check size={14} />
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            style={{
                              background: 'none', border: 'none', cursor: 'pointer', padding: '2px',
                              color: '#94a3b8', display: 'flex', alignItems: 'center',
                            }}
                            title="Cancel"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <div>
                          <div style={{ fontWeight: 500, color: '#0f172a' }}>
                            {displayName(user)}
                          </div>
                          <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                            {user.email}
                          </div>
                        </div>
                        <button
                          onClick={() => startEdit(user)}
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer', padding: '2px',
                            opacity: 0.3, transition: 'opacity 0.15s', display: 'flex', alignItems: 'center',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                          onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.3')}
                          title="Edit name and email"
                        >
                          <Pencil size={12} style={{ color: '#64748b' }} />
                        </button>
                      </div>
                    )}
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
                  <td style={{ textAlign: 'center', padding: '6px 4px', borderBottom: '1px solid #f1f5f9' }}>
                    <WorkingDaysEditor
                      value={user.working_days || 'mon,tue,wed,thu,fri'}
                      onChange={async (days) => {
                        setSaving(`${user.id}:working_days`);
                        await supabase.from('staff_profiles').update({ working_days: days }).eq('id', user.id);
                        setUsers((prev) => prev.map((u) => u.id === user.id ? { ...u, working_days: days } : u));
                        setSaving(null);
                      }}
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
          padding: 10, zIndex: 50, width: 214,
        }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
            {COLOUR_SWATCHES.map((c) => (
              <div
                key={c}
                onClick={() => { onChange(c); setOpen(false); }}
                style={{
                  width: 20, height: 20, borderRadius: 4, background: c, cursor: 'pointer',
                  border: (colour || '').toLowerCase() === c ? '2px solid #0f172a' : '1px solid #e5e7eb',
                  transition: 'transform 0.1s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.2)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
              />
            ))}
          </div>
          <label style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
            borderTop: '1px solid #f1f5f9', fontSize: 11, color: '#64748b',
            fontFamily: "'Outfit', sans-serif", fontWeight: 500, cursor: 'pointer',
          }}>
            <input
              type="color"
              value={colour || '#0e7fe0'}
              onChange={(e) => onChange(e.target.value)}
              style={{ width: 26, height: 26, padding: 0, border: '1px solid #e5e7eb', borderRadius: 4, background: 'none', cursor: 'pointer' }}
            />
            Custom colour
          </label>
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

/* ─── Working days editor: 7 day toggle buttons ── */
const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS = { mon: 'M', tue: 'T', wed: 'W', thu: 'T', fri: 'F', sat: 'S', sun: 'S' };
const DAY_FULL = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

function WorkingDaysEditor({ value, onChange }) {
  const active = new Set((value || 'mon,tue,wed,thu,fri').split(',').map((d) => d.trim()));

  const toggle = (day) => {
    const next = new Set(active);
    if (next.has(day)) next.delete(day);
    else next.add(day);
    onChange(ALL_DAYS.filter((d) => next.has(d)).join(','));
  };

  return (
    <div style={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
      {ALL_DAYS.map((day) => {
        const isActive = active.has(day);
        return (
          <button
            key={day}
            onClick={() => toggle(day)}
            title={DAY_FULL[day]}
            style={{
              width: 22, height: 22, borderRadius: 4, border: 'none',
              fontSize: 10, fontWeight: 600, cursor: 'pointer',
              fontFamily: "'Outfit', sans-serif",
              background: isActive ? '#0f172a' : '#f1f5f9',
              color: isActive ? '#fff' : '#94a3b8',
              transition: 'all 0.12s',
            }}
          >
            {DAY_LABELS[day]}
          </button>
        );
      })}
    </div>
  );
}
