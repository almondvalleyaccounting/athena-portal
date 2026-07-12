import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { supabase } from '../../../lib/supabase';

const font = "'Outfit', sans-serif";

/*
  Latest updates — high-level onboarding milestones across all clients:
  HMRC numbers/codes received, quotes accepted, QuickBooks/payroll set up,
  clients requesting new services, onboardings starting/finishing. Fed by
  v_onboarding_updates (milestone-flagged steps + service requests +
  lifecycle events). Small events (messages, uploads) deliberately excluded.
  The same feed drives the Monday-morning team email (onboarding-weekly).
*/

const MILESTONE_LABELS = [
  [/letter of engagement/i, ['📝', 'Letter of Engagement signed']],
  [/2 forms of id/i, ['🪪', 'ID documents received']],
  [/authentication code/i, ['🔑', 'Companies House auth code received']],
  [/accepted quote/i, ['✅', 'Quote accepted']],
  [/personal utr/i, ['🏛️', 'Personal UTR received']],
  [/company utr/i, ['🏛️', 'Company UTR received']],
  [/vat number/i, ['🧾', 'VAT number received']],
  [/paye ref/i, ['💷', 'PAYE reference received']],
  [/ct agent code/i, ['🔗', 'CT agent code received']],
  [/agent code/i, ['🔗', 'HMRC agent code received']],
  [/cis code/i, ['🏗️', 'CIS code received']],
  [/qb licence/i, ['💻', 'QuickBooks set up']],
  [/brightpay/i, ['💷', 'Payroll set up on Brightpay']],
  [/live billing/i, ['💳', 'Billing live in QuickBooks']],
  [/billing tracker/i, ['💳', 'Added to billing']],
];

export function updateDisplay(u) {
  if (u.kind === 'milestone') {
    for (const [re, [icon, label]] of MILESTONE_LABELS) {
      if (re.test(u.title)) return { icon, label };
    }
    return { icon: '✔️', label: u.title };
  }
  if (u.kind === 'service_request') return { icon: '🛎️', label: u.title };
  if (u.kind === 'started') return { icon: '🚀', label: 'Onboarding started' };
  if (u.kind === 'completed') return { icon: '🎉', label: 'Onboarding complete' };
  return { icon: '•', label: u.title };
}

export default function UpdatesView() {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [days, setDays] = useState(14);

  useEffect(() => {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    supabase
      .from('v_onboarding_updates')
      .select('*')
      .gte('happened_at', since)
      .order('happened_at', { ascending: false })
      .limit(300)
      .then(({ data, error: err }) => {
        if (err) setError(err.message);
        else setRows(data || []);
      });
  }, [days]);

  const byDay = useMemo(() => {
    const m = new Map();
    for (const r of rows || []) {
      const day = new Date(r.happened_at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
      if (!m.has(day)) m.set(day, []);
      m.get(day).push(r);
    }
    return [...m.entries()];
  }, [rows]);

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '24px 20px', fontFamily: font }}>
      <button
        onClick={() => navigate('/onboarding')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: '#64748b', fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 14, fontFamily: font }}
      >
        <ArrowLeft size={14} /> Back to pipeline
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <Sparkles size={18} color="#d97706" />
        <h1 style={{ margin: 0, fontSize: 21, fontWeight: 700, color: '#0f172a' }}>Latest updates</h1>
        <select
          value={days} onChange={(e) => setDays(Number(e.target.value))}
          style={{ marginLeft: 'auto', padding: '5px 9px', fontSize: 12.5, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 7, background: '#fff' }}
        >
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
      <div style={{ fontSize: 13, color: '#64748b', marginBottom: 20 }}>
        Major onboarding milestones across all clients — the same feed the Monday team email uses.
      </div>

      {error && <div style={{ color: '#b91c1c', fontSize: 13 }}>{error}</div>}
      {!rows && !error && <div style={{ color: '#94a3b8', fontSize: 13 }}>Loading…</div>}
      {rows && rows.length === 0 && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '28px 22px', textAlign: 'center', color: '#94a3b8', fontSize: 13.5 }}>
          No milestones in this period yet.
        </div>
      )}

      {byDay.map(([day, items]) => (
        <div key={day} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
            {day}
          </div>
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
            {items.map((u, i) => {
              const d = updateDisplay(u);
              return (
                <div
                  key={`${u.onboarding_id}-${u.kind}-${u.happened_at}-${i}`}
                  onClick={() => u.onboarding_id && navigate(`/onboarding/${u.onboarding_id}`)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px',
                    borderTop: i > 0 ? '1px solid #f1f5f9' : 'none',
                    cursor: u.onboarding_id ? 'pointer' : 'default',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#f8fafc'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{ fontSize: 17 }}>{d.icon}</span>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: '#0f172a', flex: '0 0 auto' }}>{u.entity_name}</span>
                  <span style={{ fontSize: 13, color: '#475569', flex: 1 }}>{d.label}</span>
                  <span style={{ fontSize: 11.5, color: '#94a3b8', whiteSpace: 'nowrap' }}>
                    {new Date(u.happened_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
