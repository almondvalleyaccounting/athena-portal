import React from 'react';
import { Inbox } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from './AppShell';
import GmailConnectionPanel from '../components/GmailConnectionPanel';

const font = "'Outfit', sans-serif";

/*
  Connections — /admin/connections (can_manage_portal only).
  Central home for external service connections. The Gmail panel here
  manages the PRACTICE DEFAULT mailbox (automation sender); the same
  panel also appears above the Push uplifts table. Personal and shared
  inboxes (plus SMS / WhatsApp) live in the Communications module.
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

      {/* Team + shared mailboxes, SMS, WhatsApp — the Communications module */}
      <div
        style={{
          background: '#fff',
          border: '1px solid #e5e7eb',
          borderRadius: 12,
          padding: '20px 24px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <Inbox size={18} color="#64748b" />
        <div style={{ flex: 1 }}>
          <p style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', marginBottom: 2 }}>
            Team inboxes, SMS &amp; WhatsApp
          </p>
          <p style={{ fontSize: 13, color: '#64748b' }}>
            Personal and shared mailboxes (info@, payroll@) are connected from the
            Communications module; texts and WhatsApp ride the practice Telnyx number.
          </p>
        </div>
        <Link
          to="/comms/email"
          style={{ padding: '8px 14px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', borderRadius: 8, textDecoration: 'none' }}
        >
          Open Communications
        </Link>
      </div>
    </div>
  );
}
