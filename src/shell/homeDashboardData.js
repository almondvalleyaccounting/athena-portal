// Data layer for the director home screen.
//
// One hook, one parallel fetch, one plain object out. Every number here is
// deliberately aligned with an existing surface Bobby already trusts:
//   - CH / SA deadline counts mirror the weekly deadline digest
//     (supabase/functions/deadline-digest): "Companies House Submission%" /
//     "Self Assessment Submission%" tasks in bm_task_schedule, state='planned'.
//   - Quote buckets match the fee-engine lifecycle (pending → sent → accepted
//     → committed; commit is the terminal step).
//   - The practice pulse is AVA's own QBO actuals via dashboard-qbo-pull
//     (metrics pl_fytd + balances). The AVA connection is flagged is_practice
//     and RLS-hidden from staff without can_view_practice_financials, so the
//     realm lookup below returns nothing for anyone else.
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

const CH_FILING = 'Companies House Submission%';
const SA_FILING = 'Self Assessment Submission%';
const CH_HORIZON_MONTHS = 6;

/* ── date helpers (UTC, matching the digest) ── */
function todayUTC() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}
function ymd(d) {
  return d.toISOString().slice(0, 10);
}
function addMonths(d, n) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}
function monthEnd(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}
function monthKeyOf(iso) {
  return iso.slice(0, 7);
}
// The next occurring 31 January (self-assessment deadline).
function nextJanEnd(from) {
  const year = from.getUTCMonth() === 0 ? from.getUTCFullYear() : from.getUTCFullYear() + 1;
  return { start: `${year}-01-01`, end: `${year}-01-31`, year };
}
export function daysLate(deadlineIso) {
  return Math.max(0, Math.floor((todayUTC() - new Date(`${deadlineIso}T00:00:00Z`)) / 86400000));
}

// Working weeks between tomorrow and `to` inclusive, weekdays only. The digest
// also excludes bank holidays; this is the same idea to ±1 day, hence the "~"
// wherever a run-rate is shown.
export function workingWeeksUntil(to) {
  const from = todayUTC();
  let days = 0;
  const cur = new Date(from.getTime() + 86400000);
  while (cur <= to) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) days++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return Math.max(days, 1) / 5;
}
export function runRate(outstanding, weeks) {
  if (outstanding <= 0) return 0;
  return Math.ceil(outstanding / Math.max(weeks, 0.2));
}

/* ── director dashboard (deadlines, attention, ops) ── */
export function useDirectorDashboard(enabled) {
  const [state, setState] = useState({ loading: true, data: null });

  useEffect(() => {
    if (!enabled) {
      setState({ loading: false, data: null });
      return undefined;
    }
    let cancelled = false;

    (async () => {
      const today = todayUTC();
      const todayIso = ymd(today);
      const monthStartIso = `${monthKeyOf(todayIso)}-01`;
      const horizonEndIso = ymd(monthEnd(addMonths(today, CH_HORIZON_MONTHS - 1)));
      const jan = nextJanEnd(today);

      const [
        chDatesRes,
        chOverdueRes,
        saRes,
        saOverdueRes,
        overdueRes,
        billingReviewRes,
        quotesRes,
        onboardingsRes,
        serviceReqRes,
        chCodesRes,
        adminTasksRes,
        issuesRes,
        freshnessRes,
      ] = await Promise.all([
        // Every open CH filing up to the 6-month horizon (incl. already-late ones)
        supabase
          .from('bm_task_schedule')
          .select('bm_deadline')
          .ilike('bm_task_name', CH_FILING)
          .eq('state', 'planned')
          .lte('bm_deadline', horizonEndIso),
        // The late ones, named, for the attention queue
        supabase
          .from('bm_task_schedule')
          .select(
            'id, bm_deadline, bm_status, bm_task_name, entity:entities!bm_task_schedule_entity_id_fkey(id, name), owner:staff_profiles!bm_task_schedule_assignee_id_fkey(name)',
          )
          .ilike('bm_task_name', CH_FILING)
          .eq('state', 'planned')
          .lt('bm_deadline', todayIso)
          .order('bm_deadline')
          .limit(10),
        // SA returns landing on the next 31 Jan
        supabase
          .from('bm_task_schedule')
          .select('id', { count: 'exact', head: true })
          .ilike('bm_task_name', SA_FILING)
          .eq('state', 'planned')
          .gte('bm_deadline', jan.start)
          .lte('bm_deadline', jan.end),
        // SA returns already past a 31 Jan (late — penalties accruing)
        supabase
          .from('bm_task_schedule')
          .select(
            'id, bm_deadline, bm_status, entity:entities!bm_task_schedule_entity_id_fkey(id, name)',
          )
          .ilike('bm_task_name', SA_FILING)
          .eq('state', 'planned')
          .lt('bm_deadline', todayIso)
          .order('bm_deadline')
          .limit(10),
        // Everything planned that has slipped past its BM deadline, by service
        supabase
          .from('bm_task_schedule')
          .select('service')
          .eq('state', 'planned')
          .lt('bm_deadline', todayIso),
        supabase
          .from('live_billing')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'active')
          .eq('needs_review', true),
        supabase
          .from('quotes')
          .select(
            'id, quote_ref, relationship_group, status, monthly_gross, annual_total, accepted_at, valid_until',
          )
          .in('status', ['pending_approval', 'awaiting_approval', 'accepted']),
        // Two FKs point at entities (entity_id, referred_by_entity_id) — the
        // embed must name the constraint or PostgREST rejects it as ambiguous.
        supabase
          .from('onboardings')
          .select('id, status, entity:entities!onboardings_entity_id_fkey(name)')
          .in('status', ['active', 'issues']),
        supabase
          .from('portal_service_requests')
          .select('id, entity_id, service_title, created_at, entity:entities(name)')
          .eq('status', 'new'),
        supabase
          .from('ch_code_requests')
          .select('status')
          .in('status', ['awaiting_code', 'stalled']),
        supabase
          .from('admin_tasks')
          .select('id', { count: 'exact', head: true })
          .is('done_at', null)
          .is('dismissed_at', null)
          .is('confirmed_at', null),
        supabase
          .from('issues_log')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'open'),
        supabase
          .from('bm_task_schedule')
          .select('last_seen_at')
          .order('last_seen_at', { ascending: false })
          .limit(1),
      ]);

      if (cancelled) return;

      /* ── Companies House buckets ── */
      const chDates = (chDatesRes.data || []).map((r) => r.bm_deadline);
      const thisKey = monthKeyOf(todayIso);
      const nextKey = monthKeyOf(ymd(addMonths(today, 1)));
      const chOverdueCount = chDates.filter((d) => d < todayIso).length;
      const chThisMonth = chDates.filter((d) => monthKeyOf(d) === thisKey).length;
      const chNextMonth = chDates.filter((d) => monthKeyOf(d) === nextKey).length;
      const chSixMonths = chDates.filter((d) => d >= monthStartIso).length;
      const chRunRate = runRate(chSixMonths, workingWeeksUntil(monthEnd(addMonths(today, CH_HORIZON_MONTHS - 1))));

      /* ── Self Assessment ── */
      const saCount = saRes.count ?? 0;
      const saRunRate = runRate(saCount, workingWeeksUntil(new Date(`${jan.end}T00:00:00Z`)));

      /* ── Overdue work by service ── */
      const byService = {};
      (overdueRes.data || []).forEach((r) => {
        const s = r.service || 'Other';
        byService[s] = (byService[s] || 0) + 1;
      });
      const overdueByService = Object.entries(byService)
        .map(([service, count]) => ({ service, count }))
        .sort((a, b) => b.count - a.count);
      const overdueTotal = overdueByService.reduce((s, r) => s + r.count, 0);

      /* ── Quotes ── */
      const quotes = quotesRes.data || [];
      const pendingApproval = quotes.filter((q) =>
        ['pending_approval', 'awaiting_approval'].includes(q.status),
      );
      const acceptedQuotes = quotes
        .filter((q) => q.status === 'accepted')
        .sort((a, b) => (b.accepted_at || '').localeCompare(a.accepted_at || ''));
      const soon = new Date(today.getTime() + 3 * 86400000).toISOString();
      const expiringQuotes = acceptedQuotes.filter(
        (q) => q.valid_until && q.valid_until <= soon && q.valid_until >= todayIso,
      );

      /* ── Ops ── */
      const onboardings = onboardingsRes.data || [];
      const onboardingIssues = onboardings.filter((o) => o.status === 'issues');
      const chCodes = chCodesRes.data || [];
      const freshRow = (freshnessRes.data || [])[0];

      setState({
        loading: false,
        data: {
          ch: {
            overdue: chOverdueCount,
            overdueList: chOverdueRes.data || [],
            thisMonth: chThisMonth,
            nextMonth: chNextMonth,
            sixMonths: chSixMonths,
            runRate: chRunRate,
          },
          sa: {
            count: saCount,
            year: jan.year,
            runRate: saRunRate,
            overdueList: saOverdueRes.data || [],
          },
          overdueWork: { total: overdueTotal, byService: overdueByService },
          billingNeedsReview: billingReviewRes.count ?? 0,
          quotes: {
            pendingApproval,
            accepted: acceptedQuotes,
            expiring: expiringQuotes,
          },
          onboarding: {
            inFlight: onboardings.length,
            issues: onboardingIssues,
          },
          chCodes: {
            awaiting: chCodes.filter((r) => r.status === 'awaiting_code').length,
            stalled: chCodes.filter((r) => r.status === 'stalled').length,
          },
          serviceRequests: serviceReqRes.data || [],
          adminTasksOpen: adminTasksRes.count ?? 0,
          issuesOpen: issuesRes.count ?? 0,
          bmDataAsOf: freshRow?.last_seen_at || null,
        },
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}

/* ── practice pulse: AVA actuals from QuickBooks ── */
// Only callable by holders of can_view_practice_financials: the is_practice
// connection row is RLS-hidden from everyone else (so realm discovery fails),
// and dashboard-qbo-pull enforces the same flag server-side.
export function usePracticePulse(enabled) {
  const [state, setState] = useState({ loading: true, pulse: null, error: null });

  useEffect(() => {
    if (!enabled) {
      setState({ loading: false, pulse: null, error: null });
      return undefined;
    }
    let cancelled = false;

    (async () => {
      try {
        const { data: conns } = await supabase
          .from('qbo_report_connections')
          .select('realm_id, company_name')
          .eq('is_practice', true)
          .eq('status', 'active')
          .limit(1);
        const conn = (conns || [])[0];
        if (!conn) {
          if (!cancelled) setState({ loading: false, pulse: null, error: 'no-connection' });
          return;
        }

        const { data: payload, error: fnErr } = await supabase.functions.invoke(
          'dashboard-qbo-pull',
          { body: { realmId: conn.realm_id, metrics: ['pl_fytd', 'balances'] } },
        );
        if (cancelled) return;
        if (fnErr) {
          setState({ loading: false, pulse: null, error: fnErr.message || 'Request failed' });
          return;
        }

        const errs = payload?.errors ? Object.values(payload.errors) : [];
        const needsReconnect = errs.length > 0 && errs.every((e) => /reconnect/i.test(e));
        setState({
          loading: false,
          error: needsReconnect ? 'reconnect' : null,
          pulse: {
            company: conn.company_name,
            plFytd: payload?.metrics?.pl_fytd || null,
            balances: payload?.metrics?.balances || null,
            pulledAt: payload?.pulled_at || null,
            fromCache: payload?.cached === true,
          },
        });
      } catch (e) {
        if (!cancelled) setState({ loading: false, pulse: null, error: e.message || 'Request failed' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}
