import React from 'react';
import { Plug } from 'lucide-react';
import { useAuth } from './AppShell';
import GmailConnectionPanel from '../components/GmailConnectionPanel';

const font = "'Outfit', sans-serif";

/*
  Connections — /admin/connections (can_manage_portal only).
  Central home for external service connections. Gmail today (the same
  panel also appears above the Push uplifts table on the billing
  uplift review page); mailboxes / SMS / WhatsApp to follow.
*/
export default function ConnectionsPage() {
  const { profile } = useAuth();

  if (profile?.can_manage_portal !== true) {
    return (
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 24px', fontFamily: font }}>
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, fontWeight: 500, color: '#0f172a', marginBottom: 8 }}>
          Connections
        </h1>
        <p style={{ fontSize: 14, color: '#64748b' }}>
          You need the Portal admin permission to manage connections.
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 24px', fontFamily: font }}>
      <h1
        style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: 28,
          fontWeight: 500,
          color: '#0f172a',
          marginBottom: 8,
        }}
      >
        Connections
      </h1>
      <p style={{ fontSize: 14, color: '#64748b', marginBottom: 24 }}>
        External services Athena is wired up to.
      </p>

      {/* Gmail */}
      <div style={{ marginBottom: 16 }}>
        <GmailConnectionPanel staffId={profile?.id} />
      </div>

      {/* Coming soon */}
      <div
        style={{
          background: '#fff',
          border: '1px dashed #e5e7eb',
          borderRadius: 12,
          padding: '20px 24px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <Plug size={18} color="#cbd5e1" />
        <div>
          <p style={{ fontSize: 14, fontWeight: 600, color: '#94a3b8', marginBottom: 2 }}>
            More connections coming soon
          </p>
          <p style={{ fontSize: 13, color: '#cbd5e1' }}>
            Email mailboxes, SMS / WhatsApp.
          </p>
        </div>
      </div>
    </div>
  );
}
