import React from 'react';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: '◆' },
  { id: 'entities', label: 'Clients', icon: '◇' },
  { id: 'quotes', label: 'Quotes', icon: '▤' },
  { id: 'quote-new', label: 'New Quote', icon: '+' },
];

export default function NavShell({ view, setView, profile, onLogout, children }) {
  return (
    <div className="min-h-screen bg-gray-50 flex">
      <div className="w-48 bg-white border-r border-gray-200 flex flex-col shrink-0">
        <div className="p-4 border-b border-gray-100">
          <h1 className="text-lg font-bold text-ocean-700 tracking-tight">ATHENA</h1>
          <p className="text-xs text-gray-400">AVA Portal</p>
        </div>
        <nav className="flex-1 p-2">
          {NAV_ITEMS.map((n) => (
            <button
              key={n.id}
              onClick={() => setView(n.id)}
              className={`w-full text-left text-sm px-3 py-2 rounded-lg mb-0.5 transition-all flex items-center gap-2 ${
                view === n.id
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
