import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchOpenCycle, fetchCycleItems, fetchReasons } from './api';

// Compact operations card for the main Dashboard: how the monthly job review
// is tracking. Renders nothing until data has loaded; shows a gentle prompt
// when no cycle is open.
export default function JobReviewRadar() {
  const navigate = useNavigate();
  const [state, setState] = useState({ loading: true, cycle: null, items: [], chaseCodes: new Set() });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cycle, reasons] = await Promise.all([fetchOpenCycle(), fetchReasons()]);
        const items = cycle ? await fetchCycleItems(cycle.id) : [];
        if (cancelled) return;
        setState({
          loading: false, cycle, items,
          chaseCodes: new Set(reasons.filter((r) => r.triggers_client_chase).map((r) => r.code)),
        });
      } catch {
        if (!cancelled) setState((s) => ({ ...s, loading: false }));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (state.loading) return null;

  const { cycle, items, chaseCodes } = state;
  const total = items.length;
  const answered = items.filter((i) => i.responded_at).length;
  const red = items.filter((i) => i.confidence === 'red').length;
  const slipped = items.filter((i) => i.movement === 'slipped').length;
  const help = items.filter((i) => i.needs_help).length;
  const clientBlocked = items.filter((i) => i.reason_code && chaseCodes.has(i.reason_code)).length;
  const pct = total ? Math.round((answered / total) * 100) : 0;
  const monthLbl = cycle
    ? new Date(cycle.period_month + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    : '';

  return (
    <div
      onClick={() => navigate('/planner/review/team')}
      className="bg-white rounded-lg border border-gray-200 p-4 mb-6 cursor-pointer hover:border-ocean-300"
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700">
          Job Review {cycle ? `· ${monthLbl}` : ''}
        </h3>
        <span className="text-xs text-ocean-600 hover:text-ocean-700">Open →</span>
      </div>

      {!cycle ? (
        <p className="text-xs text-gray-400 py-2">No cycle open this month. Open one from the Job Review page to snapshot stalled jobs.</p>
      ) : (
        <>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
            <Metric label="Stalled jobs" value={total} />
            <Metric label="Answered" value={`${answered}/${total}`} tone={answered === total ? 'good' : 'info'} />
            <Metric label="Will miss" value={red} tone={red ? 'bad' : 'muted'} />
            <Metric label="Slipped" value={slipped} tone={slipped ? 'bad' : 'muted'} />
            <Metric label="Need help" value={help} tone={help ? 'warn' : 'muted'} />
            <Metric label="Client-blocked" value={clientBlocked} tone="info" />
          </div>
          <div className="mt-3">
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full bg-ocean-500" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-[11px] text-gray-400 mt-1">{pct}% of the team have responded.</p>
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, tone = 'default' }) {
  const colour = {
    default: 'text-ocean-700', good: 'text-green-600', bad: 'text-red-600',
    warn: 'text-amber-600', info: 'text-ocean-600', muted: 'text-gray-400',
  }[tone];
  return (
    <div>
      <p className="text-[11px] text-gray-400 mb-0.5">{label}</p>
      <p className={`text-lg font-bold font-mono ${colour}`}>{value}</p>
    </div>
  );
}
