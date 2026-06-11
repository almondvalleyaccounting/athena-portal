import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, StatusBadge, Btn } from '../components/ui';
import { useAuth } from '../shell/AppShell';

// Standard minimum annual fee for the flat-rate services where a clear
// minimum exists (mirrors quote_defaults). Variable/turnover-banded services
// (accounts, payroll, bookkeeping…) have no single minimum, so they're not
// flagged. Matched loosely against both naming regimes seen in
// live_billing.services (Athena slugs + QBO-pulled labels).
const STANDARD_MIN_ANNUAL = [
  { test: /confirmation/i, min: 110, label: 'Confirmation statement' },
  { test: /registered.?office/i, min: 180, label: 'Registered office' },
  { test: /review.?meeting/i, min: 210, label: 'Annual review meeting' },
  { test: /dormant/i, min: 150, label: 'Dormant accounts' },
  { test: /auto.?enrol/i, min: 60, label: 'Auto enrolment' },
];
function standardMinAnnual(serviceId, description) {
  const hay = `${serviceId || ''} ${description || ''}`;
  for (const r of STANDARD_MIN_ANNUAL) if (r.test.test(hay)) return r.min;
  return null;
}

export default function ClientDetailPage() {
  const { profile } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();
  const [entity, setEntity] = useState(null);
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);
  const [live, setLive] = useState([]); // flattened active live-billing services
  const [liveMonthly, setLiveMonthly] = useState(0);

  useEffect(() => {
    (async () => {
      const [{ data: ent }, { data: qs }, { data: lb }] = await Promise.all([
        supabase.from('entities').select('*').eq('id', id).single(),
        supabase.from('quotes').select('*').eq('entity_id', id).order('created_at', { ascending: false }),
        supabase.from('live_billing').select('id, services, status').eq('entity_id', id).eq('status', 'active'),
      ]);
      setEntity(ent);
      setQuotes(qs || []);

      // Flatten active live-billing into one row per service, with an
      // under-billing flag where a standard minimum is known.
      const flat = [];
      for (const row of lb || []) {
        const services = Array.isArray(row.services) ? row.services : [];
        for (const s of services) {
          const monthly = Number(s.monthly_amount) || (Number(s.annual_amount) || 0) / 12;
          const annual = Number(s.annual_amount) || (Number(s.monthly_amount) || 0) * 12;
          const min = standardMinAnnual(s.service_id, s.description);
          const under = min != null && annual > 0 && annual < min ? min - annual : 0;
          flat.push({ name: s.description || s.service_id || '—', monthly, annual, min, under });
        }
      }
      flat.sort((a, b) => b.monthly - a.monthly);
      setLive(flat);
      setLiveMonthly(flat.reduce((acc, x) => acc + x.monthly, 0));
      setLoading(false);
    })();
  }, [id]);

  const handleRename = async () => {
    if (!editName.trim() || editName.trim() === entity.name) { setEditing(false); return; }
    setSaving(true);
    await supabase.from('entities').update({ name: editName.trim() }).eq('id', entity.id);
    setEntity({ ...entity, name: editName.trim() });
    setEditing(false);
    setSaving(false);
  };

  const [archiving, setArchiving] = useState(false);

  // We archive rather than hard-delete: entities have many NO ACTION child
  // FKs (quotes, tasks, timesheets…) so a real delete would either fail or
  // wipe history. Archiving hides the client from the default list while
  // preserving its records. Restorable from the list's "Show archived" view.
  const handleArchive = async () => {
    const isArchived = entity.entity_status === 'archived';
    const verb = isArchived ? 'Restore' : 'Archive';
    if (!window.confirm(`${verb} "${entity.name}"? ${isArchived ? 'It will reappear in the clients list.' : 'It will be hidden from the clients list. Its records are kept and it can be restored later.'}`)) return;
    setArchiving(true);
    const prev = entity.entity_status || 'active';
    const next = isArchived ? 'active' : 'archived';
    const { error } = await supabase.from('entities').update({ entity_status: next }).eq('id', entity.id);
    if (error) {
      alert(`Could not ${verb.toLowerCase()} client: ` + (error.message || 'Unknown error'));
      setArchiving(false);
      return;
    }
    await supabase.from('audit_log').insert({
      user_id: profile?.id || null,
      action: 'entity_status_change',
      entity_type: 'entity',
      entity_id: entity.id,
      detail: { from: prev, to: next, via: 'archive_button' },
    });
    if (isArchived) {
      setEntity({ ...entity, entity_status: next });
      setArchiving(false);
    } else {
      navigate('/manage/clients');
    }
  };

  if (loading) return <div className="p-6"><p className="text-sm text-gray-400">Loading client...</p></div>;
  if (!entity) return <div className="p-6"><p className="text-sm text-red-500">Client not found.</p></div>;

  const hasUnder = live.some((s) => s.under > 0);

  return (
    <div className="p-6 max-w-3xl">
      {/* Header */}
      <div className="flex justify-between items-start mb-4">
        <div>
          {editing ? (
            <div className="flex items-center gap-2 mb-1">
              <input
                value={editName}
                onChange={e => setEditName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setEditing(false); }}
                className="text-lg font-bold text-ocean-700 border border-ocean-300 rounded px-2 py-0.5 w-64"
                autoFocus
              />
              <Btn onClick={handleRename} disabled={saving} variant="secondary" className="text-xs py-1 px-2">{saving ? '...' : 'Save'}</Btn>
              <button onClick={() => setEditing(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
            </div>
          ) : (
            <h2 className="text-lg font-bold text-ocean-700 cursor-pointer hover:text-ocean-500 group" onClick={() => { setEditName(entity.name); setEditing(true); }}>
              {entity.name}
              <span className="text-xs text-gray-300 font-normal ml-2 opacity-0 group-hover:opacity-100 transition-opacity">edit</span>
            </h2>
          )}
          <p className="text-xs text-gray-400">
            {entity.type?.replace('_', ' ')}
            {entity.company_number ? ` \u00B7 ${entity.company_number}` : ''}
            {entity.entity_status ? ` \u00B7 ${entity.entity_status}` : ''}
          </p>
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={async () => {
                const next = !entity.expedite;
                const prev = entity.expedite;
                setEntity({ ...entity, expedite: next });
                const { error } = await supabase.from('entities').update({ expedite: next }).eq('id', entity.id);
                if (error) {
                  alert('Could not update expedite flag: ' + error.message);
                  setEntity({ ...entity, expedite: prev });
                }
              }}
              title={entity.expedite ? 'Expedite ON \u2014 work prioritised post-period-end. Click to turn off.' : 'Expedite OFF. Click to flag this client for fast turnaround.'}
              className={`text-[10px] font-bold tracking-wide uppercase px-2 py-0.5 rounded border ${
                entity.expedite
                  ? 'bg-amber-100 text-amber-700 border-amber-300'
                  : 'bg-gray-100 text-gray-500 border-gray-300 hover:bg-gray-200'
              }`}
            >
              {entity.expedite ? '\u26A1 Expedite' : 'Expedite off'}
            </button>
            {entity.grade && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200" title="Client grade (imported)">
                Grade {entity.grade}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <Btn onClick={() => navigate('/manage/quotes/new?entity=' + entity.id)}>New Quote</Btn>
          <Btn onClick={() => navigate('/manage/clients')} variant="ghost">Back</Btn>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-white rounded-lg border border-gray-200 p-3">
          <p className="text-xs text-gray-400 mb-1">Quotes</p>
          <p className="text-xl font-bold text-ocean-700 font-mono">{quotes.length}</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-3">
          <p className="text-xs text-gray-400 mb-1">Active Monthly</p>
          <p className="text-xl font-bold text-ocean-700 font-mono">{fmt(liveMonthly)}</p>
          {hasUnder && <p className="text-[10px] text-amber-600 font-medium mt-0.5">under-billing flagged</p>}
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-3">
          <p className="text-xs text-gray-400 mb-1">Status</p>
          <p className="text-sm font-medium text-gray-700 capitalize">{entity.entity_status || 'prospect'}</p>
        </div>
      </div>

      {/* Active billing — broken out to service level, with under-billing
          flagged against the standard minimum where one is defined. Click any
          row (or "Manage billing") to change existing billing. */}
      {live.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-gray-500 uppercase">Active billing — by service</h3>
            <button
              onClick={() => navigate('/manage/billing/change?client=' + encodeURIComponent(entity.name))}
              className="text-xs text-ocean-600 hover:text-ocean-700 font-medium px-2 py-1 border border-ocean-200 rounded hover:bg-ocean-50 transition-all"
            >
              Manage billing
            </button>
          </div>
          <div className="divide-y divide-gray-50">
            {live.map((s, i) => (
              <button
                key={i}
                onClick={() => navigate('/manage/billing/change?client=' + encodeURIComponent(entity.name))}
                className="w-full flex items-center justify-between gap-2 py-1.5 px-1 -mx-1 text-left rounded hover:bg-gray-50"
              >
                <span className="text-sm text-gray-700 truncate flex items-center gap-2 min-w-0">
                  <span className="truncate">{s.name}</span>
                  {s.under > 0 && (
                    <span
                      className="shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300"
                      title={`Below the standard minimum of ${fmt(s.min)}/yr — under by ${fmt(s.under)}/yr`}
                    >
                      Under {fmt(s.under)}/yr
                    </span>
                  )}
                </span>
                <span className="text-sm font-mono text-ocean-600 shrink-0">{fmt(s.monthly)}/mo</span>
              </button>
            ))}
          </div>
          <div className="flex justify-between pt-2 mt-1 border-t border-gray-200 text-sm font-semibold">
            <span className="text-gray-600">Total</span>
            <span className="font-mono text-ocean-700">{fmt(liveMonthly)}/mo</span>
          </div>
        </div>
      )}

      {/* Client details */}
      {(entity.utr || entity.vat_number || entity.paye_ref || entity.company_number) && (
        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Details</h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            {entity.company_number && <><span className="text-gray-400">Company Number</span><span className="text-gray-700">{entity.company_number}</span></>}
            {entity.utr && <><span className="text-gray-400">UTR</span><span className="text-gray-700">{entity.utr}</span></>}
            {entity.vat_number && <><span className="text-gray-400">VAT Number</span><span className="text-gray-700">{entity.vat_number}</span></>}
            {entity.paye_ref && <><span className="text-gray-400">PAYE Ref</span><span className="text-gray-700">{entity.paye_ref}</span></>}
            {entity.manager && <><span className="text-gray-400">Manager</span><span className="text-gray-700">{entity.manager}</span></>}
            {entity.grade && <><span className="text-gray-400">Grade</span><span className="text-gray-700">{entity.grade}</span></>}
            <><span className="text-gray-400">Expedite</span><span className="text-gray-700">{entity.expedite ? 'Yes — prioritise post-period-end' : 'No'}</span></>
          </div>
        </div>
      )}

      {/* Quotes list */}
      <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Quotes</h3>
      {quotes.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
          <p className="text-sm text-gray-400 mb-2">No quotes for this client yet.</p>
          <Btn onClick={() => navigate('/manage/quotes/new?entity=' + entity.id)}>Create Quote</Btn>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          {quotes.map(q => (
            <div
              key={q.id}
              onClick={() => navigate('/manage/quotes/' + q.id)}
              className="flex items-center justify-between px-4 py-3 border-b border-gray-50 last:border-0 hover:bg-gray-50 cursor-pointer"
            >
              <div>
                <p className="text-sm font-medium text-gray-700">{q.quote_ref}</p>
                <p className="text-xs text-gray-400">
                  {new Date(q.created_at).toLocaleDateString('en-GB')}
                  {q.valid_until && ` \u00B7 Valid until ${new Date(q.valid_until).toLocaleDateString('en-GB')}`}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-mono text-ocean-600">{fmt(q.monthly_gross)}</span>
                <StatusBadge status={q.status} />
              </div>
            </div>
          ))}
        </div>
      )}
      {/* Archive */}
      <div className="mt-6 pt-4 border-t border-gray-200">
        <Btn
          onClick={handleArchive}
          variant={entity.entity_status === 'archived' ? 'secondary' : 'danger'}
          disabled={archiving}
        >
          {archiving ? '...' : entity.entity_status === 'archived' ? 'Restore Client' : 'Archive Client'}
        </Btn>
        <p className="text-xs text-gray-400 mt-2">
          {entity.entity_status === 'archived'
            ? 'This client is archived and hidden from the clients list.'
            : 'Archiving hides the client from the list but keeps all records. It can be restored later.'}
        </p>
      </div>
    </div>
  );
}
