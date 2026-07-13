import React from 'react';
import { useNavigate } from 'react-router-dom';
import { pillStyle } from '../../../lib/tokens';
import ViewTabs from '../../onboarding/components/ViewTabs';

const font = "'Outfit', sans-serif";

// Shared header for the CH-codes area: the onboarding-level ViewTabs
// (List / Board / CH Codes) plus a secondary nav across the CH-code
// sub-pages (Pipeline / Queue / Templates).
export default function ChSubNav({ active, queuedCount = 0 }) {
  const navigate = useNavigate();
  const items = [
    { path: '/onboarding/ch-codes', label: 'Pipeline' },
    { path: '/onboarding/ch-codes/dashboard', label: 'Dashboard' },
    { path: '/onboarding/ch-codes/queue', label: 'Queue' },
    { path: '/onboarding/ch-codes/templates', label: 'Templates' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-end' }}>
      <ViewTabs active="CH Codes" />
      <div style={{ display: 'flex', gap: 8, fontFamily: font }}>
        {items.map((t) => (
          <button
            key={t.path}
            onClick={() => navigate(t.path)}
            style={{ ...pillStyle({ tone: 'neutral', active: active === t.label }), display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {t.label}
            {t.label === 'Queue' && queuedCount > 0 && (
              <span style={{ background: '#0e7fe0', color: '#fff', borderRadius: 999, fontSize: 10, fontWeight: 700, padding: '1px 6px', minWidth: 16, textAlign: 'center' }}>
                {queuedCount}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
