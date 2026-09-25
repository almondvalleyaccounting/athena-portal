import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { fetchAllRows } from '../../lib/fetchAllRows';
import { fmtGbpDetailed } from '../../lib/money';
import { longDate } from './repriceReasons';

// Fee reviews alongside quotes: every client with a fee change from the
// single-client fee review, where it has got to, and a way back into it.
//
// Two sources: fee_proposals (what was issued, sql/300) and live_billing
// lines staged in the fee review but not yet sent (they carry
// pending_changes with no open fee change). A client shows once, at its
// latest state. Both are fee-gated, so staff without fee access see nothing
// and the panel hides itself.

const STATE = {
  unsent:    { label: 'Not sent', bg: '#fee2e2', fg: '#991b1b' },
  notice:    { label: 'Sent — fee notice', bg: '#e0f2fe', fg: '#075985' },
  awaiting:  { label: 'Sent — awaiting acceptance', bg: '#fef3c7', fg: '#92400e' },
  accepted:  { label: 'Accepted', bg: '#dcfce7', fg: '#166534' },
  pushed:    { label: 'In QuickBooks', bg: '#f1f5f9', fg: '#475569' },
  declined:  { label: 'Declined', bg: '#f1f5f9', fg: '#991b1b' },
  withdrawn: { label: 'Withdrawn', bg: '#f1f5f9', fg: '#64748b' },
};

export default function FeeReviewsPanel({ search = '' }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [showClosed, setShowClosed] = useState(false);

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
      setRows([...byEntity.values()].sort((a, b) => String(b.when || '').localeCompare(String(a.when || ''))));
    })();
    return () => { live = false; };
  }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rows || [])
      .filter((r) => showClosed || !['pushed', 'declined', 'withdrawn'].includes(r.state))
      .filter((r) => !q || r.name.toLowerCase().includes(q));
  }, [rows, showClosed, search]);

  if (!rows || rows.length === 0) return null;
  const closed = rows.filter((r) => ['pushed', 'declined', 'withdrawn'].includes(r.state)).length;

  return (
    <div className="bg-white rounded-lg border border-gray-200 mb-4">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
        <div className="text-sm font-semibold text-ocean-700">
          Fee reviews <span className="text-xs font-normal text-gray-400">· fee changes for existing clients</span>
        </div>
        {closed > 0 && (
          <button onClick={() => setShowClosed((v) => !v)} className="text-xs text-ocean-600 hover:underline">
            {showClosed ? 'Hide finished' : `Show finished (${closed})`}
          </button>
        )}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] text-gray-500 text-left">
            <th className="px-3 py-1.5 font-medium">Client</th>
            <th className="px-3 py-1.5 font-medium">Where it is</th>
            <th className="px-3 py-1.5 font-medium text-right">Current / mo</th>
            <th className="px-3 py-1.5 font-medium text-right">New / mo</th>
            <th className="px-3 py-1.5 font-medium">From</th>
            <th className="px-3 py-1.5" />
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => {
            const st = STATE[r.state] || STATE.withdrawn;
            const d = (Number(r.next) || 0) - (Number(r.current) || 0);
            return (
              <tr key={r.entityId} className="border-t border-gray-100">
                <td className="px-3 py-2 text-gray-800">{r.name}</td>
                <td className="px-3 py-2">
                  <span style={{ background: st.bg, color: st.fg }} className="text-[11px] font-semibold px-2 py-0.5 rounded-full">{st.label}</span>
                </td>
                <td className="px-3 py-2 text-right font-mono text-gray-500">{fmtGbpDetailed(r.current)}</td>
                <td className="px-3 py-2 text-right font-mono">
                  {fmtGbpDetailed(r.next)}
                  {d !== 0 && <span className={`ml-1 text-[11px] ${d > 0 ? 'text-green-700' : 'text-red-700'}`}>{d > 0 ? '+' : ''}{fmtGbpDetailed(d)}</span>}
                </td>
                <td className="px-3 py-2 text-gray-500">{r.effectiveAt ? longDate(r.effectiveAt) : '—'}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button
                    onClick={() => navigate(`/manage/billing/change?client=${encodeURIComponent(r.name)}&reprice=${r.entityId}`)}
                    className="text-xs text-ocean-600 hover:underline mr-3"
                  >Open fee review</button>
                  {['awaiting', 'accepted', 'notice'].includes(r.state) && (
                    <button onClick={() => navigate('/manage/billing/uplifts')} className="text-xs text-ocean-600 hover:underline">Push uplifts</button>
                  )}
                </td>
              </tr>
            );
          })}
          {visible.length === 0 && (
            <tr><td colSpan={6} className="px-3 py-3 text-xs text-gray-400">No fee reviews in progress.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
