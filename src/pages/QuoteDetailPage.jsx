import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, StatusBadge, Btn } from '../components/ui';
import { STATUS_TRANSITIONS, STATUS_LABELS } from '../lib/quoteStatus';
import { generateQuotePdf } from '../lib/quotePdf';
import ConsolidationTable from '../components/ConsolidationTable';
import AddToGroupPanel from '../components/AddToGroupPanel';
import SendQuoteModal from '../components/SendQuoteModal';

export default function QuoteDetailPage({ profile }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [quote, setQuote] = useState(null);
  const [lineItems, setLineItems] = useState([]);
  const [audit, setAudit] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [transitioning, setTransitioning] = useState(false);
  const [groupData, setGroupData] = useState(null);
  const [showSendModal, setShowSendModal] = useState(false);

  useEffect(() => {
    loadQuote();
  }, [id]);

  const loadQuote = async () => {
    setLoading(true);
    try {
      const [{ data: q }, { data: li }, { data: au }] = await Promise.all([
        supabase.from('quotes').select('*').eq('id', id).single(),
        supabase.from('quote_line_items').select('*').eq('quote_id', id).order('sort_order'),
        supabase.from('audit_log').select('*').eq('entity_type', 'quote').eq('entity_id', id).order('created_at', { ascending: true }),
      ]);
      setQuote(q);
      setLineItems(li || []);
      setAudit(au || []);

      // Load group data if this is a group quote
      if (q?.group_id) {
        const [{ data: qEntities }, { data: bg }] = await Promise.all([
          supabase.from('quote_entities').select('*, entity:entities(id, name, company_number, type)').eq('quote_id', q.id).order('sort_order'),
          supabase.from('billing_groups').select('*').eq('id', q.group_id).single(),
        ]);
        // Load line items per entity
        const entityLineItems = {};
        for (const qe of (qEntities || [])) {
          const { data: eli } = await supabase.from('quote_line_items').select('*').eq('quote_entity_id', qe.id).order('sort_order');
          entityLineItems[qe.id] = eli || [];
        }
        setGroupData({ billingGroup: bg, quoteEntities: qEntities || [], entityLineItems });
      }
    } catch (e) {
      setError('Failed to load quote');
    }
    setLoading(false);
  };

  const handleTransition = async (transition) => {
    setTransitioning(true);
    setError('');
    try {
      const oldStatus = quote.status;
      const updates = { status: transition.next };
      if (transition.next === 'approved') {
        updates.approved_by = profile.id;
        updates.approved_at = new Date().toISOString();
      }
      if (transition.next === 'sent') {
        updates.sent_at = new Date().toISOString();
      }
      if (transition.next === 'accepted') {
        updates.accepted_at = new Date().toISOString();
      }

      const { error: err } = await supabase.from('quotes').update(updates).eq('id', quote.id);
      if (err) throw err;

      await supabase.from('audit_log').insert({
        user_id: profile.id,
        action: 'status_change',
        entity_type: 'quote',
        entity_id: quote.id,
        detail: { from: oldStatus, to: transition.next, action: transition.action },
      });

      setQuote({ ...quote, ...updates });
    } catch (e) {
      setError(e.message || 'Transition failed');
    }
    setTransitioning(false);
  };

  if (loading) return <div className="p-6"><p className="text-sm text-gray-400">Loading quote...</p></div>;
  if (!quote) return <div className="p-6"><p className="text-sm text-red-500">Quote not found.</p></div>;

  const transitions = STATUS_TRANSITIONS[quote.status] || [];
  const recurring = lineItems.filter(l => l.is_recurring);
  const setup = lineItems.filter(l => !l.is_recurring);
  const dirs = quote.directors || [];
  const pr = quote.payroll_detail;
  const bk = quote.bookkeeping_detail;
  const mod = quote.modulr_detail;
  const ma = quote.management_accounts_detail;
  const rm = quote.review_meetings_detail;
  const bud = quote.budgeting_detail;
  const cfo = quote.cfo_detail;
  const sw = quote.software_detail;

  return (
    <div className="p-6 max-w-2xl">
      {/* Header */}
      <div className="flex justify-between items-start mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-lg font-bold text-ocean-700">{quote.quote_ref}</h2>
            <StatusBadge status={quote.status} />
          </div>
          <p className="text-xs text-gray-400">
            {quote.relationship_group || 'Unnamed client'}
            {' \u00B7 '}
            {new Date(quote.created_at).toLocaleDateString('en-GB')}
            {quote.defaults_version && ` \u00B7 v${quote.defaults_version}`}
          </p>
        </div>
        <Btn onClick={() => navigate('/manage/quotes')} variant="ghost">Back</Btn>
      </div>

      {error && <div className="text-xs text-red-600 bg-red-50 rounded p-2 mb-3">{error}</div>}

      {/* Action Buttons */}
      <div className="flex gap-2 flex-wrap mb-4">
        {transitions.map(t => (
          profile?.[t.permission] && (
            <Btn key={t.action} onClick={() => handleTransition(t)} variant={t.variant} disabled={transitioning}>
              {t.label}
            </Btn>
          )
        ))}
        {quote.status === 'draft' && profile?.can_edit_quotes && (
          <Btn onClick={() => navigate(quote.group_id ? `/manage/quotes/group/${quote.id}/edit` : `/manage/quotes/${quote.id}/edit`)} variant="secondary">Edit</Btn>
        )}
        {profile?.can_edit_quotes && (
          <Btn onClick={() => navigate(`/manage/quotes/new?from=${quote.id}`)} variant="secondary">Re-quote</Btn>
        )}
        <Btn onClick={() => generateQuotePdf(quote, lineItems)} variant="secondary">Download PDF</Btn>
        {(quote.status === 'approved' || quote.status === 'sent') && profile?.can_approve_quotes && (
          <Btn onClick={() => setShowSendModal(true)} variant="primary">Send to Client</Btn>
        )}
      </div>

      {/* Group Quote: Consolidation Table */}
      {groupData && groupData.quoteEntities.length > 0 && (
        <div className="mb-4">
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">
            Group: {groupData.billingGroup?.name || quote.relationship_group} ({groupData.quoteEntities.length} entities)
          </h3>
          <ConsolidationTable
            entities={groupData.quoteEntities.map(qe => qe.entity || { id: qe.entity_id, name: 'Entity' })}
            entityTotals={Object.fromEntries(
              groupData.quoteEntities.map(qe => [
                qe.entity_id,
                {
                  lines: (groupData.entityLineItems[qe.id] || []).filter(l => l.is_recurring).map(l => ({ id: l.service_id, name: l.description, annual: Number(l.annual_amount) })),
                  annualServices: Number(qe.annual_before_discount) - (groupData.entityLineItems[qe.id] || []).filter(l => l.is_recurring && l.service_id?.startsWith('software')).reduce((s, l) => s + Number(l.annual_amount), 0),
                  swAnnual: (groupData.entityLineItems[qe.id] || []).filter(l => l.service_id?.startsWith('software')).reduce((s, l) => s + Number(l.annual_amount), 0),
                  annualTotal: Number(qe.annual_before_discount),
                }
              ])
            )}
            discounts={Object.fromEntries(groupData.quoteEntities.map(qe => [qe.entity_id, Number(qe.discount_pct) || 0]))}
            readOnly={true}
          />
        </div>
      )}

      {/* Client Summary */}
      <div className="bg-white rounded-lg border border-gray-200 p-3 mb-3">
        <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Client</h3>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <span className="text-gray-400">Name</span><span className="text-gray-700">{quote.relationship_group || '\u2014'}</span>
          {quote.estimated_turnover && <><span className="text-gray-400">Est. Turnover</span><span className="text-gray-700 font-mono">{fmt(quote.estimated_turnover)}</span></>}
          {quote.accounts_detail?.type && <><span className="text-gray-400">Accounts Type</span><span className="text-gray-700 capitalize">{quote.accounts_detail.type}</span></>}
        </div>
      </div>

      {/* Setup Fees */}
      {setup.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-3 mb-3">
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">One-Off Setup Fees</h3>
          {setup.map((l, i) => (
            <div key={i} className="flex justify-between text-xs py-1 border-b border-gray-50 last:border-0">
              <span className="text-gray-600">{l.description}</span>
              <span className="font-mono text-gray-700">{fmt(l.annual_amount)}</span>
            </div>
          ))}
          <div className="flex justify-between text-xs font-semibold text-ocean-700 pt-1 mt-1 border-t border-gray-200">
            <span>Setup Total</span><span className="font-mono">{fmt(quote.one_off_total)}</span>
          </div>
        </div>
      )}

      {/* Recurring Services */}
      {recurring.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-3 mb-3">
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Recurring Services</h3>
          <div className="grid gap-0.5 text-xs text-gray-400 mb-1" style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
            <span>Service</span><span className="text-right">Annual</span><span className="text-right">Monthly</span>
          </div>
          {recurring.map((l, i) => (
            <div key={i} className="grid gap-0.5 text-xs py-1 border-b border-gray-50 last:border-0" style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
              <span className="text-gray-600">{l.description}{l.detail ? ` (${l.detail})` : ''}</span>
              <span className="text-right font-mono text-gray-700">{fmt(l.annual_amount)}</span>
              <span className="text-right font-mono text-gray-500">{fmt(l.monthly_amount)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Directors */}
      {dirs.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-3 mb-3">
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Directors' Tax Returns ({dirs.length})</h3>
          {dirs.map((d, i) => (
            <div key={i} className="text-xs py-1.5 border-b border-gray-50 last:border-0">
              <div className="flex justify-between">
                <span className="font-medium text-gray-700">{d.name || `Director ${i + 1}`}</span>
                <span className="font-mono text-ocean-600">{fmt(d.total)}</span>
              </div>
              <div className="text-gray-400 mt-0.5">
                Base {fmt(d.base)}
                {d.other_dividends && ` + Dividends ${fmt(d.addon_rates_used?.other_dividends)}`}
                {d.has_rentals && ` + Rental x${d.rental_properties}`}
                {d.capital_gains && ` + CGT ${fmt(d.addon_rates_used?.capital_gains)}`}
                {d.savings_income && ` + Savings`}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Payroll Detail */}
      {pr && (
        <div className="bg-white rounded-lg border border-gray-200 p-3 mb-3">
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Payroll Detail</h3>
          <div className="space-y-0.5 text-xs">
            <div className="flex justify-between"><span className="text-gray-400">Flat monthly</span><span className="font-mono">{fmt(pr.flat_monthly)}</span></div>
            {pr.monthly_ee > 0 && <div className="flex justify-between"><span className="text-gray-400">Monthly EE ({pr.monthly_ee})</span><span className="font-mono">{fmt(pr.monthly_ee * pr.monthly_ee_rate)}/mo</span></div>}
            {pr.weekly_ee > 0 && <div className="flex justify-between"><span className="text-gray-400">Weekly EE ({pr.weekly_ee})</span><span className="font-mono">{fmt(pr.weekly_ee * pr.weekly_ee_rate * 4.33)}/mo</span></div>}
            {pr.cis > 0 && <div className="flex justify-between"><span className="text-gray-400">CIS ({pr.cis})</span><span className="font-mono">{fmt(pr.cis * pr.cis_rate * 4.33)}/mo</span></div>}
            {pr.p11d > 0 && <div className="flex justify-between"><span className="text-gray-400">P11D ({pr.p11d})</span><span className="font-mono">{fmt(pr.p11d * pr.p11d_rate)}/yr</span></div>}
          </div>
        </div>
      )}

      {/* Bookkeeping Detail */}
      {bk && (
        <div className="bg-white rounded-lg border border-gray-200 p-3 mb-3">
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Bookkeeping Detail</h3>
          <div className="text-xs text-gray-600">
            {bk.hours_per_month}h/mo x {fmt(bk.rate)}/hr{bk.includes_vat ? ' (inc VAT)' : ''}
            {bk.vat_adj ? ` + adj ${fmt(bk.vat_adj)}` : ''}
          </div>
        </div>
      )}

      {/* New sections detail */}
      {(mod || ma || rm || bud || cfo) && (
        <div className="bg-white rounded-lg border border-gray-200 p-3 mb-3">
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Additional Services</h3>
          <div className="space-y-1 text-xs">
            {mod && <div className="flex justify-between"><span className="text-gray-400">Modulr</span><span className="font-mono">{fmt(mod.software_monthly)}/mo sw + {mod.payments_per_month} payments + {mod.runs_per_month} runs</span></div>}
            {ma && <div className="flex justify-between"><span className="text-gray-400">Mgmt Accounts</span><span className="font-mono">{ma.sets} sets x {fmt(ma.rate_per_set)}</span></div>}
            {rm && <div className="flex justify-between"><span className="text-gray-400">Review Meetings</span><span className="font-mono">{rm.count} x {fmt(rm.rate)}</span></div>}
            {bud && <div className="flex justify-between"><span className="text-gray-400">Budgeting</span><span className="font-mono">{bud.basic ? `Basic ${fmt(bud.basic)}` : ''}{bud.advanced ? ` Adv ${fmt(bud.advanced)}` : ''}{bud.reforecast_qty > 0 ? ` + ${bud.reforecast_qty} reforecasts` : ''}</span></div>}
            {cfo && <div className="flex justify-between"><span className="text-gray-400">Fractional CFO</span><span className="font-mono">{cfo.days} days x {fmt(cfo.day_rate)}</span></div>}
          </div>
        </div>
      )}

      {/* Software Detail */}
      {sw && (
        <div className="bg-white rounded-lg border border-gray-200 p-3 mb-3">
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Software</h3>
          <div className="space-y-0.5 text-xs">
            {sw.accounting && <div className="flex justify-between"><span className="text-gray-400">{sw.accounting.name}</span><span className="font-mono">{fmt(sw.accounting.monthly)}/mo</span></div>}
            {sw.dext && <div className="flex justify-between"><span className="text-gray-400">Dext</span><span className="font-mono">{fmt(sw.dext.monthly)}/mo</span></div>}
          </div>
        </div>
      )}

      {/* Totals Bar */}
      <div className="bg-ocean-700 text-white rounded-lg p-4 mb-3">
        {quote.one_off_total > 0 && (
          <div className="flex justify-between text-xs mb-2 pb-2 border-b border-ocean-600">
            <span className="text-ocean-300">One-Off Setup</span>
            <span className="font-mono">{fmt(quote.one_off_total)}</span>
          </div>
        )}
        <div className="space-y-1">
          <div className="flex justify-between text-xs"><span className="text-ocean-300">Annual Services</span><span className="font-mono">{fmt(quote.annual_services)}</span></div>
          {quote.annual_software > 0 && <div className="flex justify-between text-xs"><span className="text-ocean-300">Annual Software</span><span className="font-mono">{fmt(quote.annual_software)}</span></div>}
          <div className="flex justify-between text-xs"><span className="text-ocean-300">Annual Total (Net)</span><span className="font-mono font-medium">{fmt(quote.annual_total)}</span></div>
        </div>
        <div className="border-t border-ocean-600 mt-2 pt-2 space-y-1">
          <div className="flex justify-between text-xs"><span className="text-ocean-300">Monthly (Net)</span><span className="font-mono">{fmt(quote.monthly_net)}</span></div>
          <div className="flex justify-between text-xs"><span className="text-ocean-300">VAT</span><span className="font-mono">{fmt(quote.monthly_vat)}</span></div>
          <div className="flex justify-between text-base font-bold pt-1.5 border-t border-ocean-500">
            <span>Monthly Direct Debit (Inc VAT)</span>
            <span className="font-mono text-sun-300">{fmt(quote.monthly_gross)}</span>
          </div>
        </div>
      </div>

      {/* Add to Group / Group Info */}
      <div className="mb-3">
        <AddToGroupPanel quote={quote} profile={profile} />
      </div>

      {/* Audit Trail */}
      {audit.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-3">
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Audit Trail</h3>
          <div className="space-y-2">
            {audit.map((a, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <div className="w-1.5 h-1.5 rounded-full bg-ocean-400 mt-1.5 shrink-0" />
                <div>
                  <span className="text-gray-700 font-medium">
                    {a.action === 'status_change'
                      ? `${STATUS_LABELS[a.detail?.from] || a.detail?.from} \u2192 ${STATUS_LABELS[a.detail?.to] || a.detail?.to}`
                      : a.action}
                  </span>
                  <span className="text-gray-400 ml-2">
                    {new Date(a.created_at).toLocaleDateString('en-GB')}{' '}
                    {new Date(a.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Send Quote Modal */}
      {showSendModal && (
        <SendQuoteModal
          quote={quote}
          lineItems={lineItems}
          profile={profile}
          onSent={() => { setShowSendModal(false); loadQuote(); }}
          onClose={() => setShowSendModal(false)}
        />
      )}
    </div>
  );
}
