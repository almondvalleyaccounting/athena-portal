import React from 'react';
import { useSearchParams } from 'react-router-dom';
import PricingDefaultsPage from './PricingDefaultsPage';
import ProposalPackTab from '../modules/proposals/ProposalPackTab';

// Fee Engine → Pricing & Proposals: the fee schedule, and the proposal pack
// (the per-service pages a client's proposal PDF is built from).
const TABS = [
  { id: 'pricing', label: 'Pricing defaults' },
  { id: 'pack', label: 'Proposal pack' },
];

export default function PricingProposalsPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'pricing';
  return (
    <div>
      <div className="px-6 pt-5 flex items-center gap-1 border-b border-gray-200">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setParams(t.id === 'pricing' ? {} : { tab: t.id }, { replace: true })}
            className={`px-3 py-2 text-sm -mb-px border-b-2 ${tab === t.id ? 'border-ocean-600 text-ocean-700 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'pricing' ? <PricingDefaultsPage /> : <div className="p-6"><ProposalPackTab /></div>}
    </div>
  );
}
