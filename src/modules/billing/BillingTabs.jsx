import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { tones } from '../../lib/tokens';

const font = "'Outfit', sans-serif";

// 4-tab strip across the Billing Review pipeline. Each tab shows a
// live badge count so you always know what's waiting on you:
//   Dashboard  → no badge
//   Import     → suggested-monthly services not yet approved
//   Change     → rows with at least one pending uplift staged locally
//   Push       → rows in uplift_review_status='approved' (ready to push)
//
// The counts come from a single supabase query on mount and a focus
// listener so they refresh when the tab regains focus.
export default function BillingTabs({ active }) {
  const navigate = useNavigate();
  const [counts, setCounts] = useState({ pending: 0, staged: 0, approved: 0, manualMonthly: 0 });

  const refresh = async () => {
    const { data } = await supabase
      .from('live_billing')
      .select('services, uplift_review_status, qbo_recurring_txn_id, entity:entities(entity_status)')
      .eq('status', 'active');

    let pending = 0, staged = 0, approved = 0, manualMonthly = 0;
    for (const r of data || []) {
      const services = Array.isArray(r.services) ? r.services : [];
      const isNlac = r.entity?.entity_status === 'nlac';
      if (!isNlac) {
        let approvedMonthly = 0;
        for (const s of services) {
          if (s.cadence !== 'monthly') continue;
          if (s.recurring_status === 'ending') continue;
          const status = s.approval_status || (r.qbo_recurring_txn_id ? 'approved' : 'suggested');
          if (status === 'suggested') pending++;
          if (status === 'approved') approvedMonthly += Number(s.monthly_amount) || 0;
        }
        if (!r.qbo_recurring_txn_id && approvedMonthly > 0) manualMonthly++;
      }
      const hasPending = services.some((s) => s.pending_monthly_amount != null);
      if (hasPending) {
        staged++;
        if (r.uplift_review_status === 'approved') approved++;
      }
    }
    setCounts({ pending, staged, approved, manualMonthly });
  };

  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tabs = [
    { id: 'dashboard', label: 'Dashboard', route: '/manage/billing',         badge: null },
    { id: 'import',    label: 'Import',    route: '/manage/billing/review',  badge: counts.pending  || null, tone: 'warning' },
    { id: 'change',    label: 'Change',    route: '/manage/billing/change',  badge: counts.staged   || null, tone: 'accent'  },
    { id: 'push',      label: 'Push',      route: '/manage/billing/uplifts', badge: counts.approved || null, tone: 'success' },
    { id: 'sources',   label: 'Sources',   route: '/manage/billing/sources', badge: counts.manualMonthly || null, tone: 'danger' },
    { id: 'mapping',   label: 'Mapping',   route: '/manage/billing/mapping', badge: null },
  ];

  return (
    <div style={{ display: 'flex', gap: 0, marginBottom: 18, borderBottom: '1px solid #e5e7eb' }}>
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => navigate(t.route)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '10px 16px',
              fontSize: 13,
              fontWeight: isActive ? 600 : 500,
              background: 'none',
              color: isActive ? '#0f172a' : '#64748b',
              border: 'none',
              borderBottom: isActive ? '2px solid #0f172a' : '2px solid transparent',
              marginBottom: -1,
              cursor: 'pointer',
              fontFamily: font,
            }}
          >
            <span>{t.label}</span>
            {t.badge != null && <Badge value={t.badge} tone={t.tone} active={isActive} />}
          </button>
        );
      })}
    </div>
  );
}

function Badge({ value, tone, active }) {
  const t = tones[tone] || tones.warning;
  return (
    <span style={{
      fontSize: 10, fontWeight: 700,
      padding: '2px 7px', borderRadius: 999,
      background: t.bg, color: t.fg,
      minWidth: 18, textAlign: 'center',
      opacity: active ? 1 : 0.85,
    }}>{value}</span>
  );
}
