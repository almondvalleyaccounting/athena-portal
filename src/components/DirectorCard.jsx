import React from 'react';
import { Inp, TabRow, fmt, G4, C4 } from './ui';

export default function DirectorCard({ d, idx, addonRates, onAddonRate, onChange, onRemove, canRemove }) {
  const os = d.otherSources || [];
  const rentAmt = d.hasRentals ? d.rentalProperties * addonRates.rental_property : 0;
  const total =
    d.base +
    (d.otherDividends ? addonRates.other_dividends : 0) +
    rentAmt +
    (d.capitalGains ? addonRates.capital_gains : 0) +
    (d.savingsIncome ? addonRates.savings_income : 0) +
    os.reduce((s, o) => s + (o.amount || 0), 0);

  const u = (f, v) => onChange(idx, f, v);
  const addSrc = () => u('otherSources', [...os, { description: '', amount: 0 }]);
  const updSrc = (si, f, v) => {
    const s = [...os];
    s[si] = { ...s[si], [f]: v };
    u('otherSources', s);
  };
  const rmSrc = (si) => u('otherSources', os.filter((_, i) => i !== si));

  const Row = ({ label, checkbox, checked, onCheck, qty, onQty, rate, onRate, val }) => (
    <div className={G4} style={C4}>
      {checkbox ? (
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={checked} onChange={(e) => onCheck(e.target.checked)} className="w-3 h-3 accent-ocean-600" />
          {label}
        </label>
      ) : (
        <span>{label}</span>
      )}
      <span className="text-right">{qty !== undefined ? <Inp value={qty} onChange={onQty} min={0} className="w-12" /> : ''}</span>
      <span className="text-right">
        {onRate ? <Inp value={rate} onChange={onRate} prefix="£" className="w-14" /> : <span className="font-mono">{fmt(rate)}</span>}
      </span>
      <span className="text-right font-mono">{val != null && val > 0 ? fmt(val) : '—'}</span>
    </div>
  );

  return (
    <div className="bg-gray-50 rounded p-2.5 mb-2 border border-gray-100">
      <div className="flex items-center justify-between mb-2">
        <input
          value={d.name}
          onChange={(e) => u('name', e.target.value)}
          placeholder={`Director ${idx + 1} name`}
          className="text-xs font-medium border border-gray-200 rounded px-2 py-1 bg-white w-36"
        />
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono font-semibold text-ocean-600">{fmt(total)}</span>
          {canRemove && (
            <button onClick={() => onRemove(idx)} className="text-xs text-red-400 hover:text-red-600">✕</button>
          )}
        </div>
      </div>

      <TabRow cells={['', 'Qty', 'Rate', 'Total']} header />

      <div className={G4} style={C4}>
        <span>Base return</span>
        <span></span>
        <span className="text-right"><Inp value={d.base} onChange={(v) => u('base', v)} prefix="£" className="w-14" /></span>
        <span className="text-right font-mono">{fmt(d.base)}</span>
      </div>

      <Row label="Other dividends" checkbox checked={d.otherDividends} onCheck={(v) => u('otherDividends', v)}
        rate={addonRates.other_dividends} onRate={(v) => onAddonRate('other_dividends', v)}
        val={d.otherDividends ? addonRates.other_dividends : 0} />

      <Row label="Rental properties" checkbox checked={d.hasRentals} onCheck={(v) => u('hasRentals', v)}
        qty={d.hasRentals ? d.rentalProperties : undefined} onQty={(v) => u('rentalProperties', v)}
        rate={addonRates.rental_property} onRate={(v) => onAddonRate('rental_property', v)} val={rentAmt} />

      <Row label="Capital gains" checkbox checked={d.capitalGains} onCheck={(v) => u('capitalGains', v)}
        rate={addonRates.capital_gains} onRate={(v) => onAddonRate('capital_gains', v)}
        val={d.capitalGains ? addonRates.capital_gains : 0} />

      <Row label="Savings / investment" checkbox checked={d.savingsIncome} onCheck={(v) => u('savingsIncome', v)}
        rate={addonRates.savings_income} onRate={(v) => onAddonRate('savings_income', v)}
        val={d.savingsIncome ? addonRates.savings_income : 0} />

      {os.map((src, si) => (
        <div key={si} className={G4} style={C4}>
          <input value={src.description} onChange={(e) => updSrc(si, 'description', e.target.value)}
            placeholder="Income description" className="text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white" />
          <span></span>
          <span className="text-right"><Inp value={src.amount} onChange={(v) => updSrc(si, 'amount', v)} prefix="£" className="w-14" /></span>
          <span className="text-right flex items-center justify-end gap-1">
            <span className="font-mono">{fmt(src.amount)}</span>
            <button onClick={() => rmSrc(si)} className="text-red-400 hover:text-red-600">✕</button>
          </span>
        </div>
      ))}

      <button onClick={addSrc} className="text-xs text-ocean-600 hover:text-ocean-700 mt-1">+ Other income source</button>
      <TabRow cells={['Director total', '', '', fmt(total)]} bold />
    </div>
  );
}
