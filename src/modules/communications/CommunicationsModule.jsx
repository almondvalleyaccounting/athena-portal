import React from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { pillStyle } from '../../lib/tokens';
import EmailView from './views/EmailView';
import MessagesView from './views/MessagesView';

const font = "'Outfit', sans-serif";

const TABS = [
  { path: '/comms/email', label: 'Email' },
  { path: '/comms/sms', label: 'Text Messages' },
  { path: '/comms/whatsapp', label: 'WhatsApp' },
];

// Communications — the team's inboxes in one place. Email = each team
// member's own Gmail plus shared mailboxes (info@, payroll@); Text
// Messages / WhatsApp = the practice Telnyx number (shared with Clerk
// SMS in Teams, which keeps working alongside).
export default function CommunicationsModule() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div style={{ padding: '18px 22px', fontFamily: font, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', margin: 0 }}>Communications</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {TABS.map((t) => (
            <button
              key={t.path}
              onClick={() => navigate(t.path)}
              style={pillStyle({ tone: 'info', active: location.pathname.startsWith(t.path) })}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Routes>
          <Route index element={<Navigate to="/comms/email" replace />} />
          <Route path="email" element={<EmailView />} />
          <Route path="sms" element={<MessagesView channel="sms" />} />
          <Route path="whatsapp" element={<MessagesView channel="whatsapp" />} />
          <Route path="*" element={<Navigate to="/comms/email" replace />} />
        </Routes>
      </div>
    </div>
  );
}
