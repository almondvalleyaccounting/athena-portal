import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { canAccessPath } from '../modules.config';

// Shown instead of a page the person's sidebar doesn't offer them — typed in,
// bookmarked, or followed from a link elsewhere. Same flags as the sidebar.
export default function AccessGuard({ profile, children }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  if (canAccessPath(pathname, profile)) return children;

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', padding: 32, fontFamily: "'Outfit', sans-serif" }}>
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        <div style={{ width: 44, height: 44, borderRadius: 12, background: '#f1f5f9', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
          <Lock size={20} color="#64748b" />
        </div>
        <h1 style={{ margin: '0 0 6px', fontSize: 19, fontWeight: 700, color: '#0f172a' }}>You don&rsquo;t have access to this page</h1>
        <p style={{ margin: '0 0 18px', fontSize: 13.5, color: '#64748b', lineHeight: 1.5 }}>
          It isn&rsquo;t switched on for your login. If you need it, ask an admin to turn it on in Settings › Staff &amp; Permissions.
        </p>
        <button
          onClick={() => navigate('/home')}
          style={{ padding: '9px 16px', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
        >
          Back to Home
        </button>
      </div>
    </div>
  );
}
