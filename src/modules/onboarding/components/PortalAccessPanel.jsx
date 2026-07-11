import React, { useCallback, useEffect, useState } from 'react';
import { Globe, Trash2 } from 'lucide-react';
import { tones, chipStyle } from '../../../lib/tokens';
import { useAuth } from '../../../shell/AppShell';
import { listPortalAccess, invitePortalUser, removePortalInvite } from '../api';

const font = "'Outfit', sans-serif";
export const PORTAL_URL = 'https://athena-client-portal.vercel.app';

/*
  Grants a client email access to the client portal for this entity.
  The invite is claimed automatically the first time that email signs in
  with a magic link — no password setup, nothing else to do our side.
*/
export default function PortalAccessPanel({ entityId, onboardingId }) {
  const { profile } = useAuth();
  const [invites, setInvites] = useState([]);
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    listPortalAccess(entityId).then(setInvites).catch((e) => setMsg({ tone: 'danger', text: e.message }));
  }, [entityId]);
  useEffect(() => { load(); }, [load]);

  async function invite() {
    if (!email.includes('@')) return;
    setBusy(true); setMsg(null);
    try {
      await invitePortalUser(entityId, email, { actorId: profile?.id, onboardingId });
      setEmail('');
      setMsg({ tone: 'success', text: 'Invited — they can sign in straight away with this email.' });
      load();
    } catch (e) {
      setMsg({ tone: 'danger', text: e.message?.includes('duplicate') ? 'That email is already invited for this client.' : e.message });
    }
    setBusy(false);
  }

  async function remove(inv) {
    if (!window.confirm(`Remove portal invite for ${inv.email}?${inv.claimed_at ? ' (Their existing sign-in link to this client stays until membership is removed — this just stops re-claims.)' : ''}`)) return;
    try { await removePortalInvite(inv.id); load(); } catch (e) { setMsg({ tone: 'danger', text: e.message }); }
  }

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 18px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Globe size={14} color="#64748b" />
        <span style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Client portal access
        </span>
      </div>
      <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>
        Invited emails can sign in at <a href={PORTAL_URL} target="_blank" rel="noreferrer" style={{ color: '#0e7fe0' }}>{PORTAL_URL.replace('https://', '')}</a> and see their setup progress + what we need from them.
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <input
          value={email} onChange={(e) => setEmail(e.target.value)} placeholder="client@email.com"
          onKeyDown={(e) => e.key === 'Enter' && invite()}
          style={{ flex: 1, padding: '7px 10px', fontSize: 12.5, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8 }}
        />
        <button
          onClick={invite} disabled={busy || !email.includes('@')}
          style={{ padding: '7px 14px', fontSize: 12.5, fontWeight: 600, fontFamily: font, background: '#F5C518', color: '#1E4560', border: 'none', borderRadius: 8, cursor: 'pointer' }}
        >
          Invite
        </button>
      </div>
      {msg && <div style={{ fontSize: 12, color: tones[msg.tone].fg, marginBottom: 8 }}>{msg.text}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {invites.map((inv) => (
          <div key={inv.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#334155' }}>
            <span style={{ flex: 1 }}>{inv.email}</span>
            <span style={chipStyle(inv.claimed_at ? 'success' : 'neutral')}>
              {inv.claimed_at ? 'signed in' : 'invited'}
            </span>
            <button onClick={() => remove(inv)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', display: 'flex', padding: 2 }}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {invites.length === 0 && <div style={{ fontSize: 12, color: '#cbd5e1' }}>No one invited yet.</div>}
      </div>
    </div>
  );
}
