import React from 'react';
import { useNavigate } from 'react-router-dom';
import { pillStyle } from '../../../lib/tokens';

const TABS = [
  { path: '/onboarding', label: 'List' },
  { path: '/onboarding/board', label: 'Board' },
  { path: '/onboarding/ch-codes', label: 'CH Codes' },
];

export default function ViewTabs({ active }) {
  const navigate = useNavigate();
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {TABS.map((t) => (
        <button key={t.path} onClick={() => navigate(t.path)} style={pillStyle({ tone: 'info', active: active === t.label })}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
