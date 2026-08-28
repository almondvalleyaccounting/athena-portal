import React from 'react';
import { OUTFIT, inputStyle, COMPARATIVES } from './dashboardData';
import { GRAINS, BASES, VIEWS, MONTH_NAMES, yearEndMonthIndex } from './overviewGrain';
import { Segmented } from './DashboardUI';

/*
  The view bar — grain, basis, reported/underlying, and the client's year end.

  Started life inline on the Overview. It is here because every tab that reports
  over time wants the same three questions answered the same way, and because
  the answer has to survive moving between tabs: picking fiscal quarters on the
  Overview and finding the P&L still in calendar months is the sort of thing
  that makes people stop trusting a screen.

  Not every control makes sense everywhere, so each can be hidden:
    • the balance sheet is a position, so `showView` is off — owner costs do not
      change what the company owns
    • the aged reports are as-at, so they get no bar at all
    • the two statement tabs get `compare`, and while a comparative is showing
      they lose grain and basis: a two-column statement has no grain, and a
      control that changes nothing is worse than one that isn't there

  The year-end picker only appears on the fiscal basis, because that is the only
  place it changes a number. It carries its source: a year end nobody has
  confirmed is worth saying out loud, since the fallback is the practice's own
  and would quietly relabel the client's quarters.
*/

const YEAR_END_SOURCE = {
  override: { hint: 'Set here for this client' },
  brightmanager: {
    hint: "From this client's Annual Accounts tasks in BrightManager",
    badge: 'from BrightManager',
  },
  tax_year: {
    hint: 'Assumed: sole traders and partnerships report to the tax year. Set it here if this client differs.',
    badge: 'assumed — tax year',
    warn: true,
  },
  quickbooks: { hint: "From the client's QuickBooks settings" },
  fallback: {
    hint: "Nothing in BrightManager or QuickBooks says when this client's year ends. Until you pick the right month, these are not their quarters.",
    badge: 'not confirmed',
    warn: true,
  },
};

export default function ViewBar({
  grain, setGrain, basis, setBasis, view, setView,
  compare, setCompare, compareHint = null,
  fiscalYear, onFiscalYearEndChange,
  showView = true, showGrain = true, showBasis = true,
  note = null, size = 'md',
}) {
  const src = YEAR_END_SOURCE[fiscalYear?.source] || YEAR_END_SOURCE.fallback;
  const yearEndName = MONTH_NAMES[yearEndMonthIndex('fiscal', fiscalYear?.fyIdx ?? 9)];

  return (
    <div style={{
      display: 'flex', gap: '18px', alignItems: 'center', flexWrap: 'wrap',
      padding: '12px 16px', backgroundColor: '#f8fafc',
      border: '1px solid #e5e7eb', borderRadius: '12px',
    }}>
      {showView && setView && (
        <Segmented
          label="View" value={view} onChange={setView} size={size}
          options={VIEWS.map((v) => ({
            ...v,
            hint: v.key === 'underlying'
              ? 'Owner costs and one-off items removed — the same codes tagged on the Underlying Performance tab'
              : 'Straight from QuickBooks, nothing removed',
          }))}
        />
      )}

      {setCompare && (
        <Segmented
          label="Compare" value={compare} onChange={setCompare} size={size}
          options={COMPARATIVES.map((c) => ({
            ...c,
            hint: c.months
              ? `${compareHint || 'Against'} ${c.months} month${c.months === 1 ? '' : 's'} earlier, with the movement beside it`
              : 'The period-by-period table — the shape rather than the delta',
          }))}
        />
      )}

      {showGrain && setGrain && (
        <Segmented label="By" value={grain} onChange={setGrain} options={GRAINS} size={size} />
      )}

      {showBasis && setBasis && (
        <Segmented
          label="Year" value={basis} onChange={setBasis} size={size}
          options={BASES.map((b) => ({
            ...b,
            hint: b.key === 'fiscal'
              ? `Aligned to this client's year end (${yearEndName})`
              : 'Years to December, quarters to Mar / Jun / Sep / Dec',
          }))}
        />
      )}

      {showBasis && basis === 'fiscal' && fiscalYear && (
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontFamily: OUTFIT, fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#94a3b8' }}>
            Ends
          </span>
          <select
            value={fiscalYear.endMonth != null ? fiscalYear.endMonth + 1 : ''}
            onChange={(e) => onFiscalYearEndChange?.(e.target.value)}
            disabled={!onFiscalYearEndChange}
            title={src.hint}
            style={{
              ...inputStyle, padding: '6px 9px', fontSize: '12.5px',
              borderColor: src.warn ? '#fde68a' : '#e5e7eb',
              backgroundColor: src.warn ? '#fffbeb' : '#ffffff',
            }}
          >
            {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
          {src.badge && (
            <span title={src.hint} style={{
              fontFamily: OUTFIT, fontSize: '11px', fontWeight: 600,
              color: src.warn ? '#b45309' : '#94a3b8',
            }}>
              {src.badge}
            </span>
          )}
        </label>
      )}

      {note && (
        <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8', marginLeft: 'auto' }}>
          {note}
        </span>
      )}
    </div>
  );
}
