import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { MODULES } from '../modules.config';

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
  { key: 'can_view_pd_tracker', label: 'PD tracker' },
  { key: 'is_portal_admin', label: 'Portal admin' },
];

const SELECT_COLS = [
  'id', 'full_name', 'name', 'email', 'role', 'is_active',
  ...PERMISSION_COLS.map((p) => p.key),
].join(', ');

export default function AdminPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null); // "userId:key" while saving

  const fetchUsers = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('staff_profiles')
      .select(SELECT_COLS)
      .order('full_name', { ascending: true });
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

  const displayName = (u) => u.full_name || u.name || u.email || 'Unknown';

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '40px 24px' }}>
      <h1
        style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: '28px',
          fontWeight: 500,
          color: '#0f172a',
          marginBottom: '8px',
        }}
      >
        Admin
      </h1>
      <p
        style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: '14px',
          color: '#64748b',
          marginBottom: '32px',
        }}
      >
        Manage user access to portal modules.
      </p>

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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
