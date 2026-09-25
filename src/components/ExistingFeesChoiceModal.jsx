import React from 'react';
import { X, SlidersHorizontal, FilePlus2, ArrowRight } from 'lucide-react';
import { fmt } from './ui';

// Shown when New Quote lands on a client we already bill. A quote prices
// a client from scratch; changing what an existing client pays belongs
// in the fee review (old beside new, a reason per change, a letter and
// email to the client). So ask which one is meant before going further.
export default function ExistingFeesChoiceModal({ name, monthlyNet, serviceCount, onReview, onFresh, onClose }) {
  return (
    <div className="fixed inset-0 z-[100] bg-slate-900/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-[560px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 px-5 pt-5">
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-ocean-700">{name} is already a client</h2>
            <p className="text-sm text-gray-500 mt-1">
              They pay {fmt(monthlyNet)}/mo net across {serviceCount} service{serviceCount === 1 ? '' : 's'}. What would you like to do?
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1" aria-label="Close"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-3">
          <button
            onClick={onReview}
            className="w-full text-left rounded-lg border-2 border-ocean-600 bg-ocean-50 hover:bg-ocean-100 p-4 flex items-start gap-3 transition-colors"
          >
            <SlidersHorizontal size={20} className="text-ocean-700 mt-0.5 shrink-0" />
            <span className="flex-1">
              <span className="block text-sm font-semibold text-ocean-800">Review their existing fees</span>
              <span className="block text-xs text-gray-600 mt-1 leading-relaxed">
                Change prices, add or remove services on what they pay now — old beside new, a reason for each change, and a letter and email explaining it.
              </span>
            </span>
            <ArrowRight size={16} className="text-ocean-700 mt-1 shrink-0" />
          </button>

          <button
            onClick={onFresh}
            className="w-full text-left rounded-lg border border-gray-200 hover:border-gray-300 hover:bg-gray-50 p-4 flex items-start gap-3 transition-colors"
          >
            <FilePlus2 size={20} className="text-gray-500 mt-0.5 shrink-0" />
            <span className="flex-1">
              <span className="block text-sm font-semibold text-gray-800">Continue with a brand new quote</span>
              <span className="block text-xs text-gray-500 mt-1 leading-relaxed">
                Price them from scratch, with no comparison to their existing fees.
              </span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
