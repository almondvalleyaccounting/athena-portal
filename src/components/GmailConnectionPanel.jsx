import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

const font = "'Outfit', sans-serif";

// Bare-bones connection panel for the Gmail OAuth flow. Shown above
// the Push uplifts table when no active practice-default connection
// exists, and as a compact "connected as accounts@…" banner once we're
// wired up. Reload after a redirect-back from gmail-auth-callback picks
// up the new row automatically.
//
// Multi-mailbox era: this panel manages only the PRACTICE DEFAULT
// mailbox (the one automations send from). Personal/shared inboxes are
// connected from the Communications module. Reads go through
// v_gmail_connections — the base table (with OAuth tokens) is no longer
// staff-readable.
export default function GmailConnectionPanel() {
  const [conn, setConn] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('v_gmail_connections')
      .select('id, account_email, status, connected_at, last_refreshed_at, error_message')
      .eq('status', 'active')
      .eq('is_practice_default', true)
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

  // gmail-auth-init used to be an unauthenticated 302 that took staff_id from the
  // query string and signed nothing, so anyone could have their own Google account
  // installed as the practice default. It now requires a staff session and signs the
  // OAuth state, so the consent URL has to be fetched. set_default is explicit here:
  // this panel exists to (re)connect the PRACTICE DEFAULT mailbox.
  const handleConnect = async () => {
    try {
      const { data, error } = await supabase.functions.invoke('gmail-auth-init', {
        body: { return_to: window.location.pathname, set_default: true },
      });
      if (error) throw error;
      if (!data?.url) throw new Error(data?.error || 'Could not start the Gmail connection');
      window.location.href = data.url;
    } catch (err) {
      alert(err.message || 'Could not start the Gmail connection.');
    }
  };

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
        <span>Gmail connected as <strong>{conn.account_email}</strong>. Athena uses this account to send client reminder emails, read replies, create draft emails, and archive processed messages.</span>
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
          Sign in once to connect the shared mailbox. Athena uses the connection to send client reminder emails, read replies, create draft emails, and archive processed messages. Changing what the connection is allowed to do means disconnecting and reconnecting.
        </div>
      </div>
      <button
        type="button"
        onClick={handleConnect}
        style={{
          padding: '8px 16px', fontSize: 13, fontWeight: 600,
          background: '#0f172a', color: '#fff', borderRadius: 8,
          border: 'none', cursor: 'pointer', fontFamily: font,
        }}
      >
        Connect Gmail
      </button>
    </div>
  );
}
