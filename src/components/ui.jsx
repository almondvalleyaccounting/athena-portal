import React from 'react';

export const fmt = (n) => {
  if (n == null || isNaN(n)) return '£0.00';
  if (Math.abs(n) < 0.005) return '£0.00';
  return '£' + Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export function Inp({ value, onChange, prefix, suffix, type = 'number', min, max, step, className = 'w-20', placeholder, disabled }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {prefix && <span className="text-xs text-gray-400">{prefix}</span>}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value)}
        min={min}
        max={max}
        step={step || (type === 'number' ? 'any' : undefined)}
        placeholder={placeholder}
        disabled={disabled}
        className={`text-xs border border-gray-200 rounded px-1.5 py-1 text-right font-mono bg-white ${className} ${disabled ? 'bg-gray-100 text-gray-400' : ''}`}
      />
      {suffix && <span className="text-xs text-gray-400 ml-0.5">{suffix}</span>}
    </span>
  );
}

export function TabRow({ cells, header, bold: isBold }) {
  const cols =
    cells.length === 4 ? '2fr 1fr 1fr 1fr' : cells.length === 3 ? '2fr 1fr 1fr' : '3fr 1fr';
  return (
    <div
      className={`grid gap-1 items-center text-xs ${
        header
          ? 'text-gray-400 font-medium border-b border-gray-200 pb-1 mb-1'
          : isBold
          ? 'border-t border-gray-200 pt-1 mt-1 font-semibold text-ocean-600'
          : 'text-gray-700'
      }`}
      style={{ gridTemplateColumns: cols }}
    >
      {cells.map((c, i) => (
        <span key={i} className={i > 0 ? 'text-right font-mono' : ''}>
          {c}
        </span>
      ))}
    </div>
  );
}

export function Section({ title, enabled, onToggle, children, annual }) {
  return (
    <div className={`rounded-lg border mb-2 transition-all ${enabled ? 'border-ocean-300 bg-white' : 'border-gray-200 bg-gray-50'}`}>
      <div className="flex items-center justify-between p-3 cursor-pointer" onClick={onToggle}>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={onToggle} onClick={(e) => e.stopPropagation()} className="w-4 h-4 accent-ocean-600" />
          <span className={`text-sm font-semibold ${enabled ? 'text-ocean-700' : 'text-gray-400'}`}>{title}</span>
        </label>
        {enabled && annual != null && (
          <span className="text-sm font-mono font-semibold text-ocean-600">
            {fmt(annual)}
            <span className="text-gray-400 font-normal text-xs ml-1">({fmt(annual / 12)}/mo)</span>
          </span>
        )}
      </div>
      {enabled && <div className="px-3 pb-3 border-t border-gray-100 pt-2">{children}</div>}
    </div>
  );
}

const STATUS_BADGE_LABELS = {
  draft: 'Draft',
  pending_approval: 'Awaiting Approval',
  approved: 'Approved',
  sent: 'Sent to Client',
  accepted: 'Accepted',
  declined: 'Rejected',
  expired: 'Expired',
  deleted: 'Deleted',
};

export function StatusBadge({ status }) {
  const colors = {
    draft: 'bg-gray-100 text-gray-600',
    pending_approval: 'bg-amber-100 text-amber-700',
    approved: 'bg-blue-100 text-blue-700',
    sent: 'bg-purple-100 text-purple-700',
    accepted: 'bg-green-100 text-green-700',
    declined: 'bg-red-100 text-red-600',
    expired: 'bg-gray-100 text-gray-400',
    deleted: 'bg-gray-100 text-gray-400',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[status] || colors.draft}`}>
      {STATUS_BADGE_LABELS[status] || (status || 'draft').replace('_', ' ')}
    </span>
  );
}

export function Btn({ children, onClick, variant = 'primary', disabled, className = '' }) {
  const base = 'px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-40';
  const variants = {
    primary: 'bg-sun-300 text-ocean-700 hover:bg-sun-200 font-semibold',
    secondary: 'bg-white text-ocean-600 border border-ocean-300 hover:bg-ocean-50',
    danger: 'bg-red-50 text-red-600 border border-red-200 hover:bg-red-100',
    ghost: 'text-gray-500 hover:text-ocean-600 hover:bg-gray-50',
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${variants[variant]} ${className}`}>
      {children}
    </button>
  );
}

// Grid constants used by the quote form
export const G4 = 'grid gap-1 items-center text-xs text-gray-700';
export const C4 = { gridTemplateColumns: '2fr 1fr 1fr 1fr' };
