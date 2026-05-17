import React from 'react';
import { useNavigate } from 'react-router-dom';

const font = "'Outfit', sans-serif";

// Sub-tab strip shared by the two Billing Review sections.
//   import  → /manage/billing/review        (existing approval queue)
//   change  → /manage/billing/change        (new client × service matrix)
export default function BillingSubNav({ active }) {
  const navigate = useNavigate();
  const tabs = [
    { id: 'import', label: 'Import Current Billing', route: '/manage/billing/review' },
    { id: 'change', label: 'Review and Change',      route: '/manage/billing/change' },
  ];
  return (
    <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderBottom: '1px solid #e5e7eb' }}>
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => navigate(t.route)}
            style={{
              padding: '8px 16px',
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
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
