import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Palette, UserPlus, Pencil, Check, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { fetchPortalClientIdentifiers } from './portalAccessApi';
import { BTN } from '../lib/buttonStyles';
import StaffAccessPanel from './staff-access/StaffAccessPanel';

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
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [authUsers, setAuthUsers] = useState([]);
  // Portal-client auth accounts (public.users rows / claimed invites) —
  // excluded from the "Accounts without profiles" warning below.
  const [portalClients, setPortalClients] = useState({ ids: new Set(), emails: new Set() });
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

    // Client portal sign-ins also live in auth.users — load their ids and
    // invite emails so they don't pollute the "Accounts without profiles"
    // warning (they're clients, not staff missing a profile).
    setPortalClients(await fetchPortalClientIdentifiers());

    setLoading(false);
  };

  useEffect(() => { fetchUsers(); }, []);

  // After an access change: refetch the profiles (module switches move the
  // derived flags) without the loading state, which would unmount the panel
  // and lose who is selected.
  const refreshUsers = async () => {
    const { data } = await supabase.from('staff_profiles').select(SELECT_COLS).order('name', { ascending: true });
    if (data) setUsers(data);
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

  // Find auth users without a staff profile — excluding client portal
  // users (they have a public.users row or a claimed/pending invite;
  // they're managed on /admin/portal-clients, not here).
  const profileIds = new Set(users.map((u) => u.id));
  const unlinkedUsers = authUsers.filter(
    (u) =>
      !profileIds.has(u.id) &&
      !portalClients.ids.has(u.id) &&
      !portalClients.emails.has((u.email || '').toLowerCase())
  );

  const displayName = (u) => u.name || u.email || 'Unknown';

  const renderProfile = (user) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', fontFamily: font }}>
      {editingId === user.id ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <input
            value={editForm.name}
            onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Name"
            style={{ fontFamily: font, fontSize: '14px', padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: '8px', outline: 'none', width: 180 }}
          />
          <input
            value={editForm.email}
            onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
            placeholder="Email"
            style={{ fontFamily: font, fontSize: '14px', padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: '8px', outline: 'none', width: 240 }}
          />
          <button onClick={() => saveEdit(user.id)} disabled={saving === `${user.id}:edit`} style={{ ...BTN.primary.sm, display: 'flex', alignItems: 'center', gap: 4 }}>
            <Check size={14} /> Save
          </button>
          <button onClick={() => setEditingId(null)} style={{ ...BTN.secondary.sm, display: 'flex', alignItems: 'center', gap: 4 }}>
            <X size={14} /> Cancel
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div>
            <div style={{ fontSize: '18px', fontWeight: 600, color: '#0f172a' }}>{displayName(user)}</div>
            <div style={{ fontSize: '13px', color: '#94a3b8' }}>{user.email}</div>
          </div>
          <button
            onClick={() => startEdit(user)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', display: 'flex', alignItems: 'center' }}
            title="Edit name and email"
          >
            <Pencil size={13} style={{ color: '#64748b' }} />
          </button>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#64748b' }}>
          Colour
          <ColourPicker colour={user.colour} onChange={(c) => setUserColour(user.id, c)} />
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#64748b' }}>
          Working days
          <WorkingDaysEditor
            value={user.working_days || 'mon,tue,wed,thu,fri'}
            onChange={async (days) => {
              setSaving(`${user.id}:working_days`);
              await supabase.from('staff_profiles').update({ working_days: days }).eq('id', user.id);
              setUsers((prev) => prev.map((u) => u.id === user.id ? { ...u, working_days: days } : u));
              setSaving(null);
            }}
          />
        </span>
        <button
          onClick={() => handleDelete(user)}
          disabled={deleting === user.id}
          style={{ ...BTN.danger.sm, cursor: deleting === user.id ? 'wait' : 'pointer' }}
          title={`Delete ${displayName(user)}`}
        >
          {deleting === user.id ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </div>
  );

  const inputStyle = {
    width: '100%',
    border: '1px solid #e5e7eb',
    borderRadius: '10px',
    padding: '10px 14px',
    fontSize: '14px',
    fontFamily: "'Outfit', sans-serif",
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.2s ease',
  };

  return (
    <div style={{ margin: '0 auto', padding: '40px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <h1
          style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: '28px',
            fontWeight: 500,
            color: '#0f172a',
          }}
        >
          Staff &amp; permissions
        </h1>
        <button
          onClick={() => { setShowInvite(!showInvite); setInviteError(''); setInviteSuccess(''); }}
          style={{ ...BTN.primary.md, cursor: 'pointer', transition: 'opacity 0.2s ease' }}
        >
          {showInvite ? 'Cancel' : '+ Add user'}
        </button>
      </div>
      <p
        style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: '14.5px',
          color: '#64748b',
          marginBottom: '24px',
        }}
      >
        Who can see which modules, and whose figures. Pick a person on the left, or switch to By module.
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
              fontSize: '15.5px',
              fontWeight: 600,
              color: '#0f172a',
              marginBottom: '16px',
            }}
          >
            Add new user
          </h3>
          <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 180px' }}>
              <label style={{ fontFamily: "'Outfit', sans-serif", fontSize: '13px', fontWeight: 600, color: '#64748b', display: 'block', marginBottom: '4px' }}>
                Full name
              </label>
              <input
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                placeholder="e.g. Jane Smith"
                disabled={inviting}
                style={inputStyle}
                onFocus={(e) => (e.target.style.borderColor = '#38bdf8')}
                onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
              />
            </div>
            <div style={{ flex: '1 1 220px' }}>
              <label style={{ fontFamily: "'Outfit', sans-serif", fontSize: '13px', fontWeight: 600, color: '#64748b', display: 'block', marginBottom: '4px' }}>
                Email
              </label>
              <input
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="jane@example.com"
                type="email"
                disabled={inviting}
                style={inputStyle}
                onFocus={(e) => (e.target.style.borderColor = '#38bdf8')}
                onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
              />
            </div>
            <div style={{ flex: '1 1 160px' }}>
              <label style={{ fontFamily: "'Outfit', sans-serif", fontSize: '13px', fontWeight: 600, color: '#64748b', display: 'block', marginBottom: '4px' }}>
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
                ...BTN.primary.md,
                opacity: inviting ? 0.45 : 1,
                cursor: inviting ? 'wait' : 'pointer',
                transition: 'all 0.2s ease',
              }}
            >
              {inviting ? 'Creating...' : 'Create user'}
            </button>
            {inviteError && (
              <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: '14px', color: '#ef4444' }}>
                {inviteError}
              </p>
            )}
            {inviteSuccess && (
              <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: '14px', color: '#22c55e' }}>
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
            <h3 style={{ fontFamily: font, fontSize: '14.5px', fontWeight: 600, color: '#92400e', marginBottom: '8px' }}>
              Accounts without profiles ({unlinkedUsers.length})
            </h3>
            <p style={{ fontFamily: font, fontSize: '14px', color: '#a16207', marginBottom: '12px' }}>
              These users have login accounts but no staff profile. They see "Access pending" when they sign in.
              Client portal sign-ins are excluded — manage those on{' '}
              <button
                onClick={() => navigate('/admin/portal-clients')}
                style={{
                  fontFamily: font, fontSize: '14px', fontWeight: 600, color: '#0e7fe0',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  textDecoration: 'underline',
                }}
              >
                Portal Clients
              </button>.
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
                  <span style={{ fontFamily: font, fontSize: '14.5px', fontWeight: 500, color: '#0f172a' }}>
                    {authUser.email}
                  </span>
                  <span style={{ fontFamily: font, fontSize: '13px', color: '#94a3b8', marginLeft: '8px' }}>
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
                        fontFamily: font, fontSize: '14px', padding: '8px 12px',
                        border: '1px solid #e5e7eb', borderRadius: '8px', outline: 'none', width: '180px',
                      }}
                      onFocus={(e) => (e.target.style.borderColor = '#38bdf8')}
                      onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
                    />
                    <button
                      onClick={() => handleCreateProfile(authUser)}
                      disabled={!createForm.full_name.trim() || saving === 'create'}
                      style={{
                        ...BTN.primary.sm,
                        opacity: !createForm.full_name.trim() ? 0.45 : 1,
                        cursor: !createForm.full_name.trim() ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {saving === 'create' ? 'Creating...' : 'Create'}
                    </button>
                    <button
                      onClick={() => { setShowCreateFor(null); setCreateForm({ full_name: '' }); }}
                      style={{ ...BTN.secondary.sm }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowCreateFor(authUser.id)}
                    style={{
                      ...BTN.primary.sm, display: 'flex', alignItems: 'center', gap: '4px',
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

      {loading ? (
        <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: '14.5px', color: '#94a3b8' }}>
          Loading users...
        </p>
      ) : (
        <StaffAccessPanel users={users} onUsersChange={refreshUsers} renderProfile={renderProfile} />
      )}
    </div>
  );
}

/* ─── Colour picker: palette icon → popover with swatches ──
   Exported for reuse on /settings/me (UserSettingsPage). ── */
export function ColourPicker({ colour, onChange }) {
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
            borderTop: '1px solid #f1f5f9', fontSize: 12, color: '#64748b',
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
                width: '100%', fontSize: 12, color: '#94a3b8', background: 'none',
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

// Exported for reuse on /settings/me (UserSettingsPage).
export function WorkingDaysEditor({ value, onChange }) {
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
              fontSize: 11, fontWeight: 600, cursor: 'pointer',
              fontFamily: "'Outfit', sans-serif",
              background: isActive ? '#1E4560' : '#f1f5f9',
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
