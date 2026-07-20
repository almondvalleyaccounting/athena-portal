import React, { useCallback, useEffect, useState } from 'react';
import { Globe, RotateCcw } from 'lucide-react';
import { useAuth } from './AppShell';
import { listPortalClients, revokePortalAccess, reinvitePortalUser } from './portalAccessApi';

const font = "'Outfit', sans-serif";

/*
  Portal Clients — /admin/portal-clients (can_manage_portal only).

  One place to see every client portal invite + claimed user across all
  clients (the per-client panel lives on the onboarding detail screen).
  Revoke deletes the invite AND the entity_memberships row, so a claimed
  client's data access genuinely ends — unlike the onboarding panel's
  remove, which only stops re-claims.
*/

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

export default function PortalClientsPage() {
  const { profile } = useAuth();
  const [rows, setRows] = useState([]);
  const [revoked, setRevoked] = useState([]); // rows revoked this session — offered a Re-invite
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null); // invite_id while revoking / re-inviting
  const [msg, setMsg] = useState(null); // { tone, text }

  const canManage = profile?.can_manage_portal === true;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listPortalClients());
    } catch (e) {
      setMsg({ tone: 'error', text: String(e.message || e) });
    }
    setLoading(false);
  }, []);

  useEffect(() => { if (canManage) load(); }, [canManage, load]);

  const revoke = async (row) => {
    const detail = row.claimed_at
      ? 'This deletes their invite AND their data access to this client — they will no longer see anything in the portal.'
      : 'This deletes the unclaimed invite — they will not be able to sign in for this client.';
    if (!window.confirm(`Revoke portal access for ${row.email} (${row.entity_name})?\n\n${detail}`)) return;
    setBusy(row.invite_id);
    setMsg(null);
    try {
      await revokePortalAccess(row.invite_id);
      setRevoked((prev) => [...prev, { ...row, revoked_at: new Date().toISOString() }]);
      setMsg({ tone: 'success', text: `Access revoked for ${row.email}.` });
      await load();
    } catch (e) {
      setMsg({ tone: 'error', text: String(e.message || e) });
    }
    setBusy(null);
  };

  const reinvite = async (row) => {
    setBusy(row.invite_id);
    setMsg(null);
    try {
      await reinvitePortalUser(row.entity_id, row.email, profile?.id);
      setRevoked((prev) => prev.filter((r) => r.invite_id !== row.invite_id));
      setMsg({
        tone: 'success',
        text: `${row.email} re-invited — access is restored the next time they sign in. No email goes out from here; send the welcome email from the client's onboarding screen if needed.`,
      });
      await load();
    } catch (e) {
      setMsg({
        tone: 'error',
        text: e.message?.includes('duplicate')
          ? 'That email already has a live invite for this client.'
          : String(e.message || e),
      });
    }
    setBusy(null);
  };

  const thStyle = {
    textAlign: 'left', padding: '10px 14px', fontWeight: 600, color: '#0f172a',
    borderBottom: '2px solid #e5e7eb', whiteSpace: 'nowrap', fontSize: 13,
  };
  const tdStyle = {
    padding: '10px 14px', borderBottom: '1px solid #f1f5f9', fontSize: 13, color: '#334155',
  };

  if (!canManage) {
    return (
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 24px', fontFamily: font }}>
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, fontWeight: 500, color: '#0f172a', marginBottom: 8 }}>
          Portal Clients
        </h1>
        <p style={{ fontSize: 14, color: '#64748b' }}>
          You need the Portal admin permission to manage client portal access.
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '40px 24px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, fontWeight: 500, color: '#0f172a' }}>
          Portal Clients
        </h1>
      </div>
      <p style={{ fontSize: 14, color: '#64748b', marginBottom: 24 }}>
        Everyone invited to the client portal, across all clients. Invite new emails from the
        client's onboarding screen; revoke here to fully end access.
      </p>

      {msg && (
        <div
          style={{
            fontSize: 13, marginBottom: 16, padding: '10px 14px', borderRadius: 10,
            background: msg.tone === 'success' ? '#f0fdf4' : '#fef2f2',
            border: `1px solid ${msg.tone === 'success' ? '#bbf7d0' : '#fecaca'}`,
            color: msg.tone === 'success' ? '#16a34a' : '#ef4444',
          }}
        >
          {msg.text}
        </div>
      )}

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        {loading ? (
          <p style={{ fontSize: 14, color: '#94a3b8', padding: '20px 24px' }}>Loading portal clients...</p>
        ) : rows.length === 0 ? (
          <div style={{ padding: '28px 24px', textAlign: 'center' }}>
            <Globe size={20} color="#cbd5e1" style={{ marginBottom: 8 }} />
            <p style={{ fontSize: 14, color: '#94a3b8' }}>
              No portal invites yet. Invite clients from their onboarding screen.
            </p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontFamily: font }}>
              <thead>
                <tr>
                  <th style={thStyle}>Email</th>
                  <th style={thStyle}>Client</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Last sign-in</th>
                  <th style={{ ...thStyle, width: '1%' }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.invite_id}>
                    <td style={{ ...tdStyle, fontWeight: 500, color: '#0f172a' }}>{row.email}</td>
                    <td style={tdStyle}>{row.entity_name}</td>
                    <td style={tdStyle}>
                      {row.claimed_at ? (
                        <span
                          style={{
                            fontSize: 12, fontWeight: 600, color: '#16a34a',
                            background: '#f0fdf4', border: '1px solid #bbf7d0',
                            borderRadius: 8, padding: '2px 10px', whiteSpace: 'nowrap',
                          }}
                        >
                          Active since {fmtDate(row.claimed_at)}
                        </span>
                      ) : (
                        <span
                          style={{
                            fontSize: 12, fontWeight: 600, color: '#64748b',
                            background: '#f8fafc', border: '1px solid #e5e7eb',
                            borderRadius: 8, padding: '2px 10px', whiteSpace: 'nowrap',
                          }}
                        >
                          Invited {fmtDate(row.invited_at)}
                        </span>
                      )}
                      {row.claimed_at && row.has_membership === false && (
                        <span style={{ fontSize: 11, color: '#d97706', marginLeft: 8 }}>
                          no data access
                        </span>
                      )}
                    </td>
                    <td style={{ ...tdStyle, color: row.last_sign_in_at ? '#334155' : '#cbd5e1', whiteSpace: 'nowrap' }}>
                      {row.last_sign_in_at ? fmtDate(row.last_sign_in_at) : '—'}
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                      <button
                        onClick={() => revoke(row)}
                        disabled={busy === row.invite_id}
                        style={{
                          fontFamily: font, fontSize: 12, fontWeight: 600, color: '#ef4444',
                          background: 'none', border: '1px solid #fecaca', borderRadius: 8,
                          padding: '5px 12px', cursor: busy === row.invite_id ? 'wait' : 'pointer',
                        }}
                      >
                        {busy === row.invite_id ? 'Revoking...' : 'Revoke'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Revoked this session — one-click re-invite */}
      {revoked.length > 0 && (
        <div
          style={{
            marginTop: 20, background: '#fff', border: '1px solid #e5e7eb',
            borderRadius: 12, padding: '16px 20px',
          }}
        >
          <h3 style={{ fontSize: 13, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
            Recently revoked
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {revoked.map((row) => (
              <div key={row.invite_id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: '#334155' }}>
                <span style={{ flex: 1 }}>
                  <span style={{ fontWeight: 500, color: '#0f172a' }}>{row.email}</span>
                  <span style={{ color: '#94a3b8' }}> — {row.entity_name}</span>
                </span>
                <button
                  onClick={() => reinvite(row)}
                  disabled={busy === row.invite_id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    fontFamily: font, fontSize: 12, fontWeight: 600, color: '#0e7fe0',
                    background: 'none', border: '1px solid #bae6fd', borderRadius: 8,
                    padding: '5px 12px', cursor: busy === row.invite_id ? 'wait' : 'pointer',
                  }}
                >
                  <RotateCcw size={12} />
                  {busy === row.invite_id ? 'Re-inviting...' : 'Re-invite'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
