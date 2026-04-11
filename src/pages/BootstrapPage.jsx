import React from 'react';
import { Btn } from '../components/ui';

export default function BootstrapPage({ user, onRetry, onLogout }) {
  const sql = `INSERT INTO staff_profiles (id, name, email, is_active, can_view_quotes, can_edit_quotes, can_approve_quotes, can_edit_fee_schedule, can_view_client_fees, can_manage_portal)
VALUES ('${user.id}', 'Bobby Gallacher', '${user.email}', true, true, true, true, true, true, true);`;

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-6">
          <img
            src="/ava-logo.jpg"
            alt="Almond Valley Accounting"
            className="w-28 h-auto mx-auto mb-3"
            style={{ imageRendering: 'auto' }}
          />
          <h1 className="text-2xl font-bold text-ocean-700">ATHENA</h1>
          <p className="text-xs text-gray-400 mt-1">First-Time Setup</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-amber-700 mb-2">Staff profile not found</h2>
          <p className="text-xs text-gray-600 mb-4">
            Your auth account exists but you don't have a staff_profiles row yet. RLS blocks all
            data access without it. Go to Supabase Dashboard → SQL Editor and run:
          </p>
          <pre className="text-xs font-mono bg-gray-50 p-3 rounded border border-gray-100 overflow-x-auto mb-4 whitespace-pre-wrap">
            {sql}
          </pre>
          <div className="flex gap-2">
            <Btn onClick={onRetry} className="flex-1">I've done it — retry</Btn>
            <Btn onClick={onLogout} variant="ghost">Sign out</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
