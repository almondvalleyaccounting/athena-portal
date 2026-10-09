import React, { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { theme as t } from './theme';
import StatementSettingsForm from '@dash/StatementSettingsForm.jsx';

/*
  Preferences — for now, the letterhead on the customer statements a client
  downloads from their Overdue invoices tab.

  One form per business the person can see the sales ledger of (a grant with
  the debtors section on), because a logo belongs to a company, not to a login.
  The form is the same component the dashboard tab and the staff app show;
  both reads and writes go through statement-settings, which checks the grant.
*/

export default function PreferencesPage({ onBack }) {
  const [grants, setGrants] = useState(null);
  const [entityId, setEntityId] = useState('');

  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc('portal_my_dashboards');
      const ok = (data || []).filter((g) => g.show_debtors);
      setGrants(ok);
      if (ok.length) setEntityId(ok[0].entity_id);
    })().catch(() => setGrants([]));
  }, []);

  const call = async (action, settings) => {
    const { data, error } = await supabase.functions.invoke('statement-settings', {
      body: { entityId, action, ...(settings ? { settings } : {}) },
    });
    if (error || !data?.success) throw new Error(data?.error || "We couldn't reach your settings just now.");
    return data.settings || null;
  };

  return (
    <div className="fade-up" style={{ maxWidth: 760, margin: '0 auto' }}>
      <button
        onClick={onBack}
        style={{ border: 'none', background: 'none', color: t.teal, fontWeight: 600, fontSize: 14, cursor: 'pointer', padding: 0, marginBottom: 14 }}
      >
        ← Back
      </button>
      <h1 style={{ fontSize: 22, color: t.navy, margin: '0 0 6px' }}>Preferences</h1>
      <p style={{ fontSize: 14, color: t.muted, margin: '0 0 18px', lineHeight: 1.55 }}>
        Your logo and details for the customer statements you download from <strong>Overdue invoices</strong>.
      </p>

      {grants === null && <div style={{ color: t.faint, fontSize: 14 }}>Loading…</div>}
      {grants && grants.length === 0 && (
        <div style={{ background: '#fff', border: `1px solid ${t.border}`, borderRadius: 16, padding: '24px 20px', fontSize: 14, color: t.muted }}>
          There's nothing to set up yet — statements come with the invoice listing on your dashboard.
        </div>
      )}

      {grants && grants.length > 1 && (
        <select
          value={entityId} onChange={(e) => setEntityId(e.target.value)}
          style={{ border: `1px solid ${t.border}`, borderRadius: 9, padding: '8px 12px', fontSize: 14, marginBottom: 14, background: '#fff' }}
        >
          {grants.map((g) => <option key={g.entity_id} value={g.entity_id}>{g.entity_name}</option>)}
        </select>
      )}

      {entityId && (
        <StatementSettingsForm
          key={entityId}
          load={() => call('get')}
          save={(s) => call('save', s)}
          title={grants.length > 1 ? `Statements for ${grants.find((g) => g.entity_id === entityId)?.entity_name || ''}` : 'Statement settings'}
          palette={{ text: t.text, muted: t.muted, faint: t.faint, border: t.border, accent: t.navy, surface: t.card, soft: t.bg }}
        />
      )}
    </div>
  );
}
