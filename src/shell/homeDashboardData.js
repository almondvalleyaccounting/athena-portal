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
      const jan = nextJanEnd(today);

      const [
        bucketsRes,
        chOverdueRes,
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
        snapshotRes,
        qboMappingRes,
        triageRes,
        chRefreshRes,
      ] = await Promise.all([
        // ONE definition of every deadline number — v_deadline_buckets is
        // shared with the Monday digest, so the two can never drift again.
        // Buckets are disjoint (this month excludes overdue) and exact (no
        // silent row caps).
        supabase.from('v_deadline_buckets').select('*').single(),
        // The late CH filings, named, for the attention queue
        supabase
          .from('bm_task_schedule')
          .select(
            'id, bm_deadline, bm_status, bm_task_name, entity:entities!bm_task_schedule_entity_id_fkey(id, name, entity_status), owner:staff_profiles!bm_task_schedule_assignee_id_fkey(name)',
          )
          .ilike('bm_task_name', CH_FILING)
          .eq('state', 'planned')
          .is('excluded_at', null)
          .lt('bm_deadline', todayIso)
          .order('bm_deadline')
          .limit(10),
        // SA returns already past a 31 Jan (late — penalties accruing)
        supabase
          .from('bm_task_schedule')
          .select(
            'id, bm_deadline, bm_status, entity:entities!bm_task_schedule_entity_id_fkey(id, name, entity_status)',
          )
          .ilike('bm_task_name', SA_FILING)
          .eq('state', 'planned')
          .is('excluded_at', null)
          .lt('bm_deadline', todayIso)
          .order('bm_deadline')
          .limit(10),
        // Everything planned that has slipped past its BM deadline — full
        // detail, because the planner only covers SA/AA and the home screen is
        // the only place overdue VAT / payroll / management accounts surface.
        supabase
          .from('bm_task_schedule')
          .select(
            'id, service, bm_task_name, bm_deadline, bm_status, entity:entities!bm_task_schedule_entity_id_fkey(id, name, entity_status), owner:staff_profiles!bm_task_schedule_assignee_id_fkey(name)',
          )
          .eq('state', 'planned')
          .is('excluded_at', null)
          .lt('bm_deadline', todayIso)
          .order('bm_deadline')
          .limit(300),
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
        // Latest digest snapshot — the baseline for week-on-week deltas. The
        // Monday digest writes one per send; the same definitions as above.
        supabase
          .from('deadline_digest_snapshots')
          .select('snapshot_date, payload')
          .order('snapshot_date', { ascending: false })
          .limit(1),
        // QBO customers pulled nightly (~5am) that aren't mapped to a client
        // yet. "role is distinct from 'not_a_client'" — a plain .neq() would
        // drop NULL roles, so the OR keeps them in the count.
        supabase
          .from('qbo_customer_mappings')
          .select('id', { count: 'exact', head: true })
          .is('entity_id', null)
          .or('role.is.null,role.neq.not_a_client'),
        // Open triage cases — strike_off is critical (CH status changed under
        // us), on_hold / general are visibility items. Staff-readable via RLS.
        supabase
          .from('triage_cases')
          .select('*, entity:entities(id, name, entity_status)')
          .eq('status', 'open')
          .order('created_at', { ascending: false }),
        // Did last night's Companies House refresh actually run, and cleanly?
        supabase
          .from('ch_refresh_runs')
          .select('run_date, processed, chunks, errors, status_changes')
          .eq('run_date', todayIso)
          .limit(1),
      ]);

      if (cancelled) return;

      // Former clients (nlac/archived) never appear in the attention queues.
      // The headline counts come from v_deadline_buckets, which already
      // excludes them (sql/134); this keeps the named lists consistent.
      const notFormer = (r) => !['nlac', 'archived'].includes(r.entity?.entity_status);

      /* ── Deadline buckets — all counts come from v_deadline_buckets ── */
      const buckets = bucketsRes.data || {};
      const thisKey = monthKeyOf(todayIso);
      const chOverdueCount = buckets.ch_overdue ?? 0;
      const chThisMonth = buckets.ch_this_month ?? 0;
      const chNextMonth = buckets.ch_next_month ?? 0;
      const chSixMonths = buckets.ch_six_months ?? 0;
      const chRunRate = runRate(chSixMonths, workingWeeksUntil(monthEnd(addMonths(today, CH_HORIZON_MONTHS - 1))));

      /* ── Self Assessment ── */
      const saCount = buckets.sa_next_jan ?? 0;
      const saRunRate = runRate(saCount, workingWeeksUntil(new Date(`${jan.end}T00:00:00Z`)));

      /* ── Overdue work: exact total from the view; 300-row detail list ── */
      const overdueJobs = (overdueRes.data || []).filter(notFormer);
      const overdueByService = Object.entries(buckets.overdue_by_service || {})
        .map(([service, count]) => ({ service, count }))
        .sort((a, b) => b.count - a.count);
      const overdueTotal = buckets.overdue_total ?? 0;

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

      /* ── Week-on-week vs the latest digest snapshot ── */
      // Mirrors the digest's own delta maths: month totals compared by key
      // (missing keys count 0, same as the email), scalars only when present.
      const snap = (snapshotRes.data || [])[0];
      const prev = snap?.payload || null;
      let wow = null;
      if (prev) {
        const monthKeys = [];
        for (let i = 0; i < CH_HORIZON_MONTHS; i++) monthKeys.push(monthKeyOf(ymd(addMonths(today, i))));
        const prevCh = prev.ch || {};
        const prevChTotal = monthKeys.reduce(
          (s, k) => s + (typeof prevCh[k] === 'number' ? prevCh[k] : 0),
          0,
        );
        wow = {
          since: snap.snapshot_date,
          chThisMonth:
            typeof prevCh[thisKey] === 'number' ? chThisMonth - prevCh[thisKey] : null,
          chSixMonths: chSixMonths - prevChTotal,
          chOverdue:
            typeof prev.ch_overdue === 'number' ? chOverdueCount - prev.ch_overdue : null,
          sa: typeof prev.sa_jan === 'number' ? saCount - prev.sa_jan : null,
          overdueTotal:
            typeof prev.overdue_total === 'number' ? overdueTotal - prev.overdue_total : null,
        };
      }

      setState({
        loading: false,
        data: {
          ch: {
            overdue: chOverdueCount,
            overdueList: (chOverdueRes.data || []).filter(notFormer),
            thisMonth: chThisMonth,
            nextMonth: chNextMonth,
            sixMonths: chSixMonths,
            runRate: chRunRate,
          },
          sa: {
            count: saCount,
            year: jan.year,
            runRate: saRunRate,
            overdueList: (saOverdueRes.data || []).filter(notFormer),
          },
          overdueWork: { total: overdueTotal, byService: overdueByService, jobs: overdueJobs },
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
          qboUnmapped: qboMappingRes.count ?? 0,
          triage: (triageRes.data || []).filter(notFormer),
          // null = the nightly refresh has no row for today (did not run)
          chRefresh: (chRefreshRes.data || [])[0] || null,
          bmDataAsOf: freshRow?.last_seen_at || null,
          wow,
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
          { body: { realmId: conn.realm_id, metrics: ['pl_fytd', 'pl_fytd_prior', 'balances'] } },
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
            realmId: conn.realm_id,
            plFytd: payload?.metrics?.pl_fytd || null,
            plFytdPrior: payload?.metrics?.pl_fytd_prior || null,
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
