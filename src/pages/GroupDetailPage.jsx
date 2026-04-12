import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, StatusBadge, Btn } from '../components/ui';
import { STATUS_TRANSITIONS, STATUS_LABELS } from '../lib/quoteStatus';
import { generateQuotePdf } from '../lib/quotePdf';
import ConsolidationTable from '../components/ConsolidationTable';
import SendQuoteModal from '../components/SendQuoteModal';

// Determine the "worst" (earliest in workflow) status across quotes
const STATUS_ORDER = ['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'declined', 'expired'];
function groupStatus(quotes) {
  if (!quotes.length) return 'draft';
  const statuses = quotes.map(q => q.status);
  // Return the earliest status in the workflow
  for (const s of STATUS_ORDER) {
    if (statuses.includes(s)) return s;
  }
  return statuses[0] || 'draft';
}

export default function GroupDetailPage({ profile, defaults }) {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const [group, setGroup] = useState(null);
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [discounts, setDiscounts] = useState({});
  const [transitioning, setTransitioning] = useState(false);
  const [error, setError] = useState('');
  const [showSendModal, setShowSendModal] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [groupEntities, setGroupEntities] = useState([]);

  const handleRenameGroup = async () => {
    if (!editName.trim() || editName.trim() === group?.name) { setEditingName(false); return; }
    setSavingName(true);
    await supabase.from('billing_groups').update({ name: editName.trim() }).eq('id', groupId);
    setGroup({ ...group, name: editName.trim() });
    setEditingName(false);
    setSavingName(false);
  };

  useEffect(() => { loadGroup(); }, [groupId]);

  const loadGroup = async () => {
    setLoading(true);
    try {
      const [{ data: bg }, { data: gQuotes }, { data: members }] = await Promise.all([
        supabase.from('billing_groups').select('*').eq('id', groupId).single(),
        supabase.from('quotes').select('*, line_items:quote_line_items(*)').eq('group_id', groupId).order('created_at'),
        supabase.from('billing_group_members').select('entity_id, entity:entities(id, name, company_number, type)').eq('group_id', groupId),
      ]);
      setGroup(bg);
      setQuotes(gQuotes || []);
      setGroupEntities((members || []).map(m => m.entity).filter(Boolean));
    } catch {}
    setLoading(false);
  };

  if (loading) return <div className="p-6"><p className="text-sm text-gray-400">Loading group...</p></div>;
  if (!group) return <div className="p-6"><p className="text-sm text-red-500">Group not found.</p></div>;

  // Build entity data for consolidation table
  const entities = quotes.map(q => ({
    id: q.entity_id || q.id,
    name: q.relationship_group || q.quote_ref,
    quoteId: q.id,
    company_number: '',
  }));

  const entityTotals = {};
  quotes.forEach(q => {
    const key = q.entity_id || q.id;
    const recurring = (q.line_items || []).filter(l => l.is_recurring);
    const swLines = recurring.filter(l => l.service_id?.startsWith('software'));
    const serviceLines = recurring.filter(l => !l.service_id?.startsWith('software'));

    entityTotals[key] = {
      lines: recurring.map(l => ({
        id: l.service_id,
        name: l.description,
        annual: Number(l.annual_amount),
      })),
      annualServices: serviceLines.reduce((s, l) => s + Number(l.annual_amount), 0),
      swAnnual: swLines.reduce((s, l) => s + Number(l.annual_amount), 0),
      annualTotal: Number(q.annual_total) || 0,
      monthlyGross: Number(q.monthly_gross) || 0,
    };
  });

  // Group totals
  const groupAnnual = quotes.reduce((s, q) => {
    const key = q.entity_id || q.id;
    const disc = discounts[key] || 0;
    return s + ((Number(q.annual_total) || 0) * (1 - disc / 100));
  }, 0);
  const groupMonthlyNet = Math.round((groupAnnual / 12) * 100) / 100;
  const groupMonthlyVat = Math.round(groupMonthlyNet * 0.2 * 100) / 100;
  const groupMonthlyDD = Math.round((groupMonthlyNet + groupMonthlyVat) * 100) / 100;

  // Status workflow for the group
  const currentStatus = groupStatus(quotes);
  const transitions = STATUS_TRANSITIONS[currentStatus] || [];

  const handleGroupTransition = async (transition) => {
    setTransitioning(true);
    setError('');
    try {
      for (const q of quotes) {
        const updates = { status: transition.next };
        if (transition.next === 'approved') {
          updates.approved_by = profile?.id;
          updates.approved_at = new Date().toISOString();
        }
        if (transition.next === 'sent') {
          updates.sent_at = new Date().toISOString();
        }
        if (transition.next === 'accepted') {
          updates.accepted_at = new Date().toISOString();
        }
        const { error: err } = await supabase.from('quotes').update(updates).eq('id', q.id);
        if (err) throw err;
      }
      await loadGroup();
    } catch (e) {
      setError(e.message || 'Failed to update status');
    }
    setTransitioning(false);
  };

  const handleExportPdf = async () => {
    // Use the first quote as the base for PDF generation
    if (quotes.length > 0) {
      const allLineItems = quotes.flatMap(q => q.line_items || []);
      await generateQuotePdf({ ...quotes[0], relationship_group: group.name, monthly_gross: groupMonthlyDD, annual_total: groupAnnual }, allLineItems);
    }
  };

  // Build a synthetic quote object for SendQuoteModal
  const syntheticQuote = quotes.length > 0 ? {
    ...quotes[0],
    relationship_group: group.name,
    monthly_gross: groupMonthlyDD,
    annual_total: groupAnnual,
    quote_ref: quotes.map(q => q.quote_ref).join(', '),
  } : null;
  const allLineItems = quotes.flatMap(q => q.line_items || []);

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex justify-between items-start mb-4">
        <div>
          {editingName ? (
            <div className="flex items-center gap-2">
              <input
                value={editName}
                onChange={e => setEditName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleRenameGroup(); if (e.key === 'Escape') setEditingName(false); }}
                className="text-lg font-bold text-ocean-700 border border-ocean-300 rounded px-2 py-0.5 w-64"
                autoFocus
              />
              <Btn onClick={handleRenameGroup} disabled={savingName} variant="secondary" className="text-xs py-1 px-2">{savingName ? '...' : 'Save'}</Btn>
              <button onClick={() => setEditingName(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
            </div>
          ) : (
            <h2 className="text-lg font-bold text-ocean-700 cursor-pointer hover:text-ocean-500 group" onClick={() => { setEditName(group.name); setEditingName(true); }}>
              {group.name}
              <span className="text-xs text-gray-300 font-normal ml-2 opacity-0 group-hover:opacity-100 transition-opacity">edit</span>
            </h2>
          )}
          <p className="text-xs text-gray-400">{quotes.length} entities · Group quote</p>
          <div className="mt-1">
            <StatusBadge status={currentStatus} />
          </div>
        </div>
        <Btn onClick={() => navigate('/manage/quotes')} variant="ghost">Back</Btn>
      </div>

      {error && <div className="text-xs text-red-600 bg-red-50 rounded p-2 mb-3">{error}</div>}

      {/* Status workflow actions */}
      {transitions.length > 0 && (
        <div className="flex items-center gap-2 mb-4 bg-gray-50 rounded-lg p-2 border border-gray-200">
          <span className="text-xs text-gray-500 mr-1">Actions:</span>
          {transitions.map(t => (
            <Btn
              key={t.action}
              onClick={() => handleGroupTransition(t)}
              disabled={transitioning}
              variant={t.variant || 'secondary'}
              className="text-xs py-1 px-3"
            >
              {t.label} (All)
            </Btn>
          ))}
          <Btn onClick={() => setShowSendModal(true)} variant="secondary" className="text-xs py-1 px-3">
            Send to Client
          </Btn>
          <Btn onClick={handleExportPdf} variant="ghost" className="text-xs py-1 px-3">
            Export PDF
          </Btn>
        </div>
      )}

      {/* If no transitions but still want send/export */}
      {transitions.length === 0 && (
        <div className="flex items-center gap-2 mb-4">
          <Btn onClick={() => setShowSendModal(true)} variant="secondary" className="text-xs py-1 px-3">
            Send to Client
          </Btn>
          <Btn onClick={handleExportPdf} variant="ghost" className="text-xs py-1 px-3">
            Export PDF
          </Btn>
        </div>
      )}

      {/* Clients in this Group */}
      {groupEntities.length > 0 && (
        <div className="mb-4">
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Clients in this Group</h3>
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            {groupEntities.map(ent => {
              const clientQuoteCount = quotes.filter(q => q.entity_id === ent.id).length;
              return (
                <div key={ent.id} className="flex items-center justify-between px-4 py-2 border-b border-gray-50 last:border-0 hover:bg-gray-50">
                  <div>
                    <button onClick={() => navigate('/manage/clients/' + ent.id)} className="text-sm font-medium text-ocean-600 hover:text-ocean-800 hover:underline">
                      {ent.name}
                    </button>
                    <p className="text-xs text-gray-400">
                      {ent.type?.replace('_', ' ')}{ent.company_number ? ` \u00B7 ${ent.company_number}` : ''}
                    </p>
                  </div>
                  <div className="text-xs">
                    {clientQuoteCount > 0 ? (
                      <span className="text-gray-600">{clientQuoteCount} quote{clientQuoteCount !== 1 ? 's' : ''}</span>
                    ) : (
                      <span className="text-gray-300">No quotes</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Consolidation Table */}
      <div className="mb-4">
        <ConsolidationTable
          entities={entities}
          entityTotals={entityTotals}
          discounts={discounts}
          onDiscountChange={(eid, pct) => setDiscounts(prev => ({ ...prev, [eid]: pct }))}
        />
      </div>

      {/* Individual quote cards */}
      <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Individual Quotes</h3>
      <div className="space-y-2 mb-4">
        {quotes.map(q => (
          <div
            key={q.id}
            onClick={() => navigate('/manage/quotes/' + q.id)}
            className="bg-white rounded-lg border border-gray-200 p-3 cursor-pointer hover:border-ocean-300 transition-all"
          >
            <div className="flex justify-between items-center">
              <div>
                <p className="text-sm font-medium text-gray-700">{q.relationship_group || q.quote_ref}</p>
                <p className="text-xs text-gray-400">{q.quote_ref} · {new Date(q.created_at).toLocaleDateString('en-GB')}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-mono text-ocean-600">{fmt(q.monthly_gross)}/mo</span>
                <StatusBadge status={q.status} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <Btn onClick={() => navigate(`/manage/quotes/group/${groupId}/quote`)} variant="primary">
          Build Group Quote
        </Btn>
        <Btn onClick={() => navigate('/manage/quotes/new?group=' + groupId)}>Add Entity</Btn>
        <Btn onClick={() => navigate('/manage/quotes')} variant="secondary">Back to Quotes</Btn>
      </div>

      {/* Send Quote Modal */}
      {showSendModal && syntheticQuote && (
        <SendQuoteModal
          quote={syntheticQuote}
          lineItems={allLineItems}
          profile={profile}
          onSent={() => { setShowSendModal(false); loadGroup(); }}
          onClose={() => setShowSendModal(false)}
        />
      )}
    </div>
  );
}
