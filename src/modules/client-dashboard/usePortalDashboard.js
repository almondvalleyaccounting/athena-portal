import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PERIOD_PRESETS, ASAT_PRESETS, computePeriod, computeAsAt,
} from './dashboardData';

/*
  The client dashboard's controls and its one data call, shared.

  Two callers, and they have to behave identically:

    • client-portal/src/DashboardSection.jsx — the real page, for the client.
    • src/modules/client-dashboard/ClientViewPreview.jsx — the "preview as
      client" panel, so whoever is granting access sees exactly what they are
      granting.

  Before this hook the two held their own control state, and the preview held
  less of it, which meant the preview could not exercise the date picker it was
  supposedly previewing. Anything the client can do, the preview can now do,
  because it is the same code driving the same endpoint.

  NO SUPABASE IMPORT. This module is reached through the @dash alias, whose rule
  is that shared modules import nothing but React and their own siblings — the
  two apps have different clients and different auth. So the client is passed
  IN. The hook still cannot reach anything but portal-dashboard, which decides
  for itself what a client may see.

  DATES. The caller picks a preset (or a custom range) and this computes the
  actual dates with computePeriod / computeAsAt — the same functions the staff
  dashboard uses, so "last fiscal year" means the same twelve months on both
  screens. The dates are then sent, and the edge function clamps them. Neither
  end trusts the other to have bounded the range: this end because a client
  should see honest dates, that end because it is the one that has to hold.

  Computing a FISCAL preset needs the client's year end, which is why
  portal_my_dashboards returns it (sql/275). Without it the first request for
  "this financial year" would ask about the practice's year instead of theirs.
*/

// Presets a client is offered. A subset of the staff list, in the order a client
// would look for them: the standard view first, the statutory ones next.
export const PORTAL_PERIOD_PRESETS = PERIOD_PRESETS.filter(
  (p) => ['last12full', 'lastMonth', 'lastFiscalYear', 'lastCalendarYear', 'last5years', 'custom'].includes(p.key),
).map((p) => ({
  ...p,
  label: p.key === 'lastFiscalYear' ? 'Last full financial year'
    : p.key === 'lastCalendarYear' ? 'Last calendar year'
      : p.label,
}));

export const PORTAL_ASAT_PRESETS = ASAT_PRESETS.filter(
  (p) => ['lastMonthEnd', 'today', 'lastFiscalYearEnd', 'custom'].includes(p.key),
).map((p) => ({
  ...p,
  label: p.key === 'lastFiscalYearEnd' ? 'Last financial year end' : p.label,
}));

// Tabs that read an AS-AT date rather than a period. A balance sheet and an
// aged ledger are positions: "the last 12 months" is not a thing either of them
// can be, so the rail above them shows a date and not a range.
export const ASAT_TABS = new Set(['bs', 'debtors', 'creditors']);

const CLIENT_ERROR = "We couldn't load your figures just now. Please try again shortly.";

export function usePortalDashboard({
  supabase, entityId, previewEmail = null, grant = null,
  // The preview re-fetches when a section flag is toggled, because the server
  // applies those flags — turning P&L on has to fetch the statement, not just
  // reveal an empty one.
  flagSignature = '',
}) {
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [tab, setTab] = useState('overview');
  const [periodKey, setPeriodKey] = useState('last12full');
  const [customPeriod, setCustomPeriod] = useState({ start: '', end: '' });
  const [asAtKey, setAsAtKey] = useState('lastMonthEnd');
  const [customAsAt, setCustomAsAt] = useState({ date: '' });
  const [grain, setGrain] = useState('month');
  const [basis, setBasis] = useState('fiscal');
  const [view, setView] = useState('reported');
  const [plCompare, setPlCompare] = useState('trend');
  const [bsCompare, setBsCompare] = useState('m12');

  const today = useMemo(() => new Date(), []);

  /*
    The fiscal year start month, 0-based.

    From the grant where we have it, then from a payload already in hand, then
    October — which is the PRACTICE's year end and therefore wrong for most
    clients, so it is only ever the last resort before any data has arrived.
  */
  const fyIdx = useMemo(() => {
    const m = grant?.fiscal_year_start_month ?? payload?.fiscal_year_start_month;
    return (m >= 1 && m <= 12) ? m - 1 : 9;
  }, [grant?.fiscal_year_start_month, payload?.fiscal_year_start_month]);

  const period = useMemo(
    () => computePeriod(periodKey, today, fyIdx, customPeriod),
    [periodKey, today, fyIdx, customPeriod],
  );
  const asAt = useMemo(
    () => computeAsAt(asAtKey, today, fyIdx, customAsAt),
    [asAtKey, today, fyIdx, customAsAt],
  );

  // A custom range with a blank box is a range nobody has finished typing.
  // Firing a QuickBooks pull on every keystroke would be both slow and wrong.
  const customIncomplete =
    (periodKey === 'custom' && !(customPeriod.start && customPeriod.end))
    || (asAtKey === 'custom' && !customAsAt.date);

  const load = useCallback(async () => {
    if (!entityId || customIncomplete) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: e } = await supabase.functions.invoke('portal-dashboard', {
        body: {
          entityId,
          ...(previewEmail ? { previewEmail } : {}),
          grain, basis,
          period: {
            start: period.plStart,
            end: period.plEnd,
            // Presets are cached by their date range; ad-hoc ranges are pulled
            // live and never stored, so one person's odd window does not fill
            // the cache with rows nobody asks for twice.
            preset: periodKey !== 'custom',
          },
          asAt: { date: asAt.date },
          plCompare, bsCompare,
        },
      });
      if (e) throw e;
      if (!data?.success) throw new Error(data?.error || CLIENT_ERROR);
      setPayload(data);
    } catch (e) {
      const msg = String(e?.message || e);
      setError(
        previewEmail ? msg
          : msg === 'Not authorised' ? "You don't have access to these figures." : CLIENT_ERROR,
      );
    }
    setLoading(false);
  }, [
    supabase, entityId, previewEmail, grain, basis,
    period.plStart, period.plEnd, periodKey, asAt.date,
    plCompare, bsCompare, customIncomplete, flagSignature,
  ]);

  // Switching client drops the figures BEFORE the next fetch lands, rather than
  // showing the previous client's numbers under the new company's name for a
  // second. Ordered ahead of the load effect so it wins the same render.
  useEffect(() => { setPayload(null); }, [entityId]);

  useEffect(() => { load(); }, [load]);

  return {
    payload, loading, error, reload: load,
    tab, setTab,
    periodKey, setPeriodKey, customPeriod, setCustomPeriod, period,
    asAtKey, setAsAtKey, customAsAt, setCustomAsAt, asAt,
    grain, setGrain, basis, setBasis, view, setView,
    plCompare, setPlCompare, bsCompare, setBsCompare,
    fyIdx,
  };
}

export default usePortalDashboard;
