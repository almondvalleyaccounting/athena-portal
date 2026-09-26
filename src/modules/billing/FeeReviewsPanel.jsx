import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { fetchAllRows } from '../../lib/fetchAllRows';

// Fee reviews alongside quotes: every client with a fee change from the
// single-client fee review and where it has got to, as rows of the Quotes
// table (reviewAsRow) that open the fee review.
//
// Two sources: fee_proposals (what was issued, sql/300) and live_billing
// lines staged in the fee review but not yet sent (they carry
// pending_changes with no open fee change). A client shows once, at its
// latest state. Both are fee-gated, so staff without fee access see none.
//
// On the Quotes page fee reviews count in the pipeline alongside quotes:
// each state maps to the quote stage it corresponds to (STAGE below), and
// what a review adds to the pipeline is its DELTA — the pipeline shows what
// happens to revenue if everything in it lands, and a fee review changes
// an existing fee rather than adding a whole new one.

export const REVIEW_STATE = {
  unsent:    { label: 'Not sent', bg: '#fee2e2', fg: '#991b1b' },
  notice:    { label: 'Sent — fee notice', bg: '#e0f2fe', fg: '#075985' },
  awaiting:  { label: 'Sent — awaiting acceptance', bg: '#fef3c7', fg: '#92400e' },
  accepted:  { label: 'Accepted', bg: '#dcfce7', fg: '#166534' },
  pushed:    { label: 'In QuickBooks', bg: '#f1f5f9', fg: '#475569' },
  declined:  { label: 'Declined', bg: '#f1f5f9', fg: '#991b1b' },
  withdrawn: { label: 'Withdrawn', bg: '#f1f5f9', fg: '#64748b' },
};

// Review state → the quote status it counts as in the pipeline cards.
// 'review_draft' has its own card (Draft (reviews)); withdrawn counts nowhere.
export const STAGE = {
  unsent: 'review_draft',
  notice: 'sent',
  awaiting: 'sent',
  accepted: 'accepted',
  pushed: 'committed',
  declined: 'declined',
};

// Annual change in fees, net of VAT.
export const annualDelta = (r) => ((Number(r.next) || 0) - (Number(r.current) || 0)) * 12;

// Every client's fee review at its latest state, or null while loading.
export function useFeeReviews() {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const [{ data: props }, billing] = await Promise.all([
        supabase.from('fee_proposals')
          .select('id, entity_id, kind, status, effective_at, issued_at, accepted_at, accepted_via, summary, entity:entities(name)')
          .order('issued_at', { ascending: false }),
        fetchAllRows(() => supabase.from('live_billing')
          .select('id, entity_id, services, entity:entities(name)').eq('status', 'active').order('id')).catch(() => []),
      ]);
      if (!live) return;
      const open = new Set((props || []).filter((p) => ['issued', 'accepted'].includes(p.status)).map((p) => p.id));
      const byEntity = new Map();
      // Latest issued fee change per client.
      for (const p of props || []) {
        if (byEntity.has(p.entity_id)) continue;
        const state = p.status === 'issued' ? (p.kind === 'proposal' ? 'awaiting' : 'notice') : p.status;
        byEntity.set(p.entity_id, {
          entityId: p.entity_id, name: p.entity?.name || 'Client', state, kind: p.kind,
          current: p.summary?.current, next: p.summary?.next, effectiveAt: p.effective_at, when: p.issued_at,
        });
      }
      // Staged in the fee review, not sent: that's the client's latest state.
      for (const r of billing || []) {
        const staged = (r.services || []).filter((s) => s.pending_monthly_amount != null && Array.isArray(s.pending_changes)
          && !(s.pending_proposal_id && open.has(s.pending_proposal_id)));
        if (!staged.length) continue;
        const all = (r.services || []).filter((s) => s.approval_status === 'approved' && s.recurring_status !== 'ending');
        const current = all.reduce((t, s) => t + (Number(s.monthly_amount) || 0), 0);
        const next = all.reduce((t, s) => t + (s.pending_monthly_amount != null ? Number(s.pending_monthly_amount) : (Number(s.monthly_amount) || 0)), 0);
        const eff = staged.map((s) => s.pending_effective_at).filter(Boolean).sort()[0] || null;
        const when = staged.map((s) => s.pending_uplift_staged_at).filter(Boolean).sort().pop() || null;
        byEntity.set(r.entity_id, {
          entityId: r.entity_id, name: r.entity?.name || 'Client', state: 'unsent',
          current, next, effectiveAt: eff, when,
        });
      }
      setRows([...byEntity.values()]
        .map((r) => ({ ...r, stage: STAGE[r.state] || null }))
        .sort((a, b) => String(b.when || '').localeCompare(String(a.when || ''))));
    })();
    return () => { live = false; };
  }, []);
  return rows;
}

// A review as a row of the Quotes table: shaped like a quote so the
// table's columns, sorting, search and exports work unchanged, with the
// money columns holding the change in fees (net, gross, VAT, annual).
export function reviewAsRow(r) {
  const delta = (Number(r.next) || 0) - (Number(r.current) || 0);
  return {
    id: `review:${r.entityId}`,
    _review: r,
    quote_ref: 'Fee review',
    relationship_group: r.name,
    group_id: null,
    status: r.stage,
    monthly_net: delta,
    monthly_gross: delta * 1.2,
    vat: delta * 0.2,
    annual_total: annualDelta(r),
    created_at: r.when || null,
    valid_until: null,
  };
}

// Opens the client's fee review (the modal on Review and change).
export function reviewHref(r) {
  return `/manage/billing/change?client=${encodeURIComponent(r.name)}&reprice=${r.entityId}`;
}

export function ReviewStateBadge({ state }) {
  const st = REVIEW_STATE[state] || REVIEW_STATE.withdrawn;
  return <span style={{ background: st.bg, color: st.fg }} className="text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap">{st.label}</span>;
}
