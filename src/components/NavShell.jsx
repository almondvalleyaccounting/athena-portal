import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

const NAV_ITEMS = [
  { path: '/', label: 'Dashboard', icon: '\u25C6' },
  { path: '/manage/quotes/new', label: 'New Quote', icon: '+' },
  { path: '/manage/clients', label: 'Clients', icon: '\u25C7' },
  { path: '/manage/quotes', label: 'Quotes', icon: '\u25A4' },
  { path: '/manage/groups', label: 'Groups', icon: '\u25A6' },
  { path: '/manage/billing', label: 'Billing', icon: '\u00A3' },
];

const PRICING_ITEM = { path: '/manage/quotes/pricing', label: 'Pricing', icon: '\u2699' };

export default function NavShell({ profile, onLogout, children }) {
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (item) => {
    if (item.path === '/manage/quotes') {
      // Highlight for /manage/quotes and /manage/quotes/:id but NOT /new, /pricing
      return location.pathname === '/manage/quotes' ||
        (/^\/manage\/quotes\/[0-9a-f-]+/.test(location.pathname) &&
         !location.pathname.includes('/edit'));
    }
    if (item.path === '/manage/groups') {
      return location.pathname === '/manage/groups';
    }
    if (item.path === '/manage/billing') {
      return location.pathname === '/manage/billing';
    }
    if (item.path === '/manage/quotes/new') {
      return location.pathname === '/manage/quotes/new';
    }
    if (item.path === '/manage/quotes/pricing') {
      return location.pathname === '/manage/quotes/pricing';
    }
    return location.pathname === item.path;
  };

  const items = [...NAV_ITEMS];
  if (profile?.can_edit_fee_schedule) {
    items.push(PRICING_ITEM);
  }

  return (
    <div className="min-h-screen bg-gray-50 flex">
      <div className="w-48 bg-white border-r border-gray-200 flex flex-col shrink-0">
        <div className="p-4 border-b border-gray-100">
          <img
            src="/ava-logo.jpg"
            alt="AVA"
            className="w-20 h-auto mx-auto mb-2"
            style={{ imageRendering: 'auto' }}
          />
          <h1 className="text-lg font-bold text-ocean-700 tracking-tight text-center">ATHENA</h1>
          <p className="text-xs text-gray-400 text-center">Fee Engine</p>
        </div>
        <nav className="flex-1 p-2">
          {items.map((n) => (
            <button
              key={n.path}
              onClick={() => navigate(n.path)}
              className={`w-full text-left text-sm px-3 py-2 rounded-lg mb-0.5 transition-all flex items-center gap-2 ${
                isActive(n)
                  ? 'bg-ocean-50 text-ocean-700 font-medium'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
              }`}
            >
              <span className="text-xs w-4 text-center">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="p-3 border-t border-gray-100">
          <p className="text-xs text-gray-500 truncate mb-1">{profile?.name || profile?.email}</p>
          <button onClick={onLogout} className="text-xs text-gray-400 hover:text-red-500">
            Sign out
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}
