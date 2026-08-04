import React from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { pillStyle } from '../../lib/tokens';
import { useAuth } from '../../shell/AppShell';
import EmailView from './views/EmailView';
import MessagesView from './views/MessagesView';
import PreferencesView from './views/PreferencesView';
import ClientRemindersPage from '../reminders/ClientRemindersPage';

const font = "'Outfit', sans-serif";

// Access is decided once, at this module: anyone who can open Communications
// gets every sub-module, and full powers inside each. Tabs may still carry a
// `perm` (a staff_profiles boolean) if that ever needs narrowing again.
//
// Per-account privacy is enforced a level down, not here: the Email tab only
// lists shared mailboxes plus your own (api.js listMailboxes), and comms-gmail
// refuses to read someone else's personal mailbox.
const TABS = [
  { path: '/comms/email', label: 'Email' },
  { path: '/comms/sms', label: 'Text Messages' },
  { path: '/comms/whatsapp', label: 'WhatsApp' },
  { path: '/comms/reminders', label: 'Client Tax Reminders' },
  { path: '/comms/preferences', label: 'Client Preferences' },
];

// Communications — the team's inboxes in one place. Email = each team
// member's own Gmail plus shared mailboxes (info@, payroll@); Text
// Messages / WhatsApp = the practice Telnyx number (shared with Clerk
// SMS in Teams, which keeps working alongside). Client Reminders (moved
// here from Client Work) sends tokened opt-in + tax-payment emails;
// Client Preferences is the consent ledger those responses feed.
export default function CommunicationsModule() {
  const navigate = useNavigate();
  const location = useLocation();
  const { profile } = useAuth();
  const tabs = TABS.filter((t) => !t.perm || profile?.[t.perm] === true);

  return (
    <div style={{ padding: '18px 22px', fontFamily: font, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', margin: 0 }}>Communications</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {tabs.map((t) => (
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
          <Route path="preferences" element={<PreferencesView />} />
          <Route path="reminders" element={<ClientRemindersPage />} />
          <Route path="*" element={<Navigate to="/comms/email" replace />} />
        </Routes>
      </div>
    </div>
  );
}
