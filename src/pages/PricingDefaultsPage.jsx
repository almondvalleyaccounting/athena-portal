import React from 'react';
import { Btn } from '../components/ui';

export default function PricingDefaultsPage({ defaults, profile, onSaved }) {
  return (
    <div className="p-6 max-w-3xl">
      <h2 className="text-lg font-bold text-ocean-700 mb-4">Pricing Defaults</h2>
      <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
        <p className="text-sm text-gray-400">Pricing defaults editor — building in Step 3...</p>
        <p className="text-xs text-gray-300 mt-1">Current version: v{defaults?.version || '?'}</p>
      </div>
    </div>
  );
}
