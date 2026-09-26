import React, { useState } from 'react';
import { X } from 'lucide-react';
import { fmt, StatusBadge } from './ui';

// Shown when a new quote is saved for a client who already has an open
// quote. Either the new one replaces an open quote (which becomes
// "Superseded" and leaves the pipeline — sql/326 does that on insert), or
// both stay in the pipeline. Nothing is chosen for you.
export default function SupersedeQuoteModal({ name, openQuotes, onChoose, onCancel }) {
  const [choice, setChoice] = useState(openQuotes.length === 1 ? openQuotes[0].id : null);
  const Option = ({ value, children }) => (
    <label className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${choice === value ? 'border-ocean-600 bg-ocean-50' : 'border-gray-200 hover:border-gray-300'}`}>
      <input type="radio" className="mt-1" checked={choice === value} onChange={() => setChoice(value)} />
      <span className="flex-1 text-sm">{children}</span>
    </label>
  );
  return (
    <div className="fixed inset-0 z-[100] bg-slate-900/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-[560px]">
        <div className="flex items-start gap-3 px-5 pt-5">
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-ocean-700">{name} already has {openQuotes.length === 1 ? 'an open quote' : `${openQuotes.length} open quotes`}</h2>
            <p className="text-sm text-gray-500 mt-1">Does this new quote replace one, or should both be in the pipeline?</p>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 p-1" aria-label="Close"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-2">
          {openQuotes.map((q) => (
            <Option key={q.id} value={q.id}>
              <span className="block font-semibold text-gray-800">Replaces {q.quote_ref}</span>
              <span className="flex items-center gap-2 mt-1 text-xs text-gray-500">
                <StatusBadge status={q.status} />
                {fmt(q.monthly_net)}/mo net · {new Date(q.created_at).toLocaleDateString('en-GB')}
              </span>
              <span className="block text-xs text-gray-500 mt-1">It becomes Superseded and leaves the pipeline. The client can no longer accept it.</span>
            </Option>
          ))}
          <Option value="keep">
            <span className="block font-semibold text-gray-800">Keep both in the pipeline</span>
            <span className="block text-xs text-gray-500 mt-1">Two separate quotes for the same client, both counted.</span>
          </Option>
        </div>
        <div className="flex justify-end gap-2 px-5 pb-5">
          <button onClick={onCancel} className="text-sm px-4 py-2 rounded-lg border border-gray-200 hover:bg-gray-50">Cancel</button>
          <button onClick={() => onChoose(choice)} disabled={!choice}
            className="text-sm px-4 py-2 rounded-lg bg-ocean-700 text-white font-semibold disabled:opacity-40">Save quote</button>
        </div>
      </div>
    </div>
  );
}
