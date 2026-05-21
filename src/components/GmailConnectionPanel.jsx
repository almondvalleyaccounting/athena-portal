import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

const font = "'Outfit', sans-serif";

// Bare-bones connection panel for the Gmail OAuth flow. Shown above
// the Push uplifts table when no active gmail_connections row exists,
// and as a compact "connected as accounts@…" banner once we're wired
// up. Reload after a redirect-back from gmail-auth-callback picks up
// the new row automatically.
export default function GmailConnectionPanel({ staffId }) {
  const [conn, setConn] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('gmail_connections')
      .select('id, account_email, status, connected_at, last_refreshed_at, error_message')
      .eq('status', 'active')
      .maybeSingle();
    setConn(data || null);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    // Re-fetch when we land back from the OAuth flow.
    const params = new URLSearchParams(window.location.search);
    if (params.get('gmail_connected') === '1') {
      // Strip the flag so refreshes don't keep re-triggering.
      params.delete('gmail_connected');
      const newSearch = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (newSearch ? `?${newSearch}` : ''));
    }
  }, [refresh]);

  const connectUrl = (() => {
    const base = `${import.meta.env.VITE_SUPABASE_URL || 'https://neksyvneljgxvpchwgch.supabase.co'}/functions/v1/gmail-auth-init`;
    const params = new URLSearchParams({
      staff_id: staffId || '',
      return_to: window.location.pathname,
    });
    return `${base}?${params.toString()}`;
  })();

  const disconnect = async () => {
    if (!conn) return;
    if (!window.confirm(`Disconnect Gmail (${conn.account_email})? You'll need to re-authorise before creating new drafts.`)) return;
    await supabase
      .from('gmail_connections')
      .update({ status: 'revoked', updated_at: new Date().toISOString() })
      .eq('id', conn.id);
    refresh();
  };

  if (loading) {
    return null;
  }

  // Connected — compact banner.
  if (conn) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 12px', marginBottom: 10,
        background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8,
        fontSize: 12, fontFamily: font, color: '#166534',
      }}>
        <span style={{ fontSize: 14 }}>✉</span>
        <span>Gmail connected as <strong>{conn.account_email}</strong>. Drafts will land in this account's Drafts folder.</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={disconnect}
          style={{ fontSize: 11, color: '#166534', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline', fontFamily: font }}
        >
          Disconnect
        </button>
      </div>
    );
  }

  // Not connected — large CTA.
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '14px 16px', marginBottom: 14,
      background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10,
      fontFamily: font,
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#92400e', marginBottom: 2 }}>
          Gmail not connected
        </div>
        <div style={{ fontSize: 12, color: '#78350f' }}>
          Sign in once to let Athena create fee-raise drafts in your Gmail. We only request the "compose drafts" scope — no reading, no sending on your behalf.
        </div>
      </div>
      <a
        href={connectUrl}
        style={{
          padding: '8px 16px', fontSize: 13, fontWeight: 600,
          background: '#0f172a', color: '#fff', borderRadius: 8,
          textDecoration: 'none', fontFamily: font,
        }}
      >
        Connect Gmail
      </a>
    </div>
  );
}
